import * as vscode from 'vscode';
import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ReviewIssue } from '../../src/types';
import { RetryEvent } from '../../src/llm-client';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { buildEmptyReportHtml, buildReportHtml, ReportStats, AutoResumeIndicator, type WebviewAssets, type PanelUx } from './reportHtml';
import { DEFAULT_UI_PREFS, normalizeUiPrefs, type UiPrefs } from './uiPrefs';
import { normalizeLang, t, type Lang } from '../../src/i18n';
import type { AuditResumeView, FindingsDiffView } from './projectAudit';

interface ScanMessage {
  command?: string;
  file?: string;
  line?: number | string;
  focus?: string;
  scope?: string;
  globs?: string;
  anchor?: string;
}

function safePost(webview: vscode.Webview, message: Record<string, unknown>): void {
  try {
    void Promise.resolve(webview.postMessage(message)).then(undefined, () => undefined);
  } catch {
    // webview уже утилизирован: состояние живёт в полях панели, следующий render()/resolve догонит
  }
}

function clampSetting(value: number | undefined, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(max, n);
}

function realExistingPath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return missing.length ? resolve(realpathSync(current), ...missing) : realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export class CodeScoutPanel implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}
  private view?: vscode.WebviewView;
  private issues: ReviewIssue[] = [];
  private stats: ReportStats = { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 };
  private hasRun = false;
  private scanning = false;
  private statusMessage = '';
  private statusKind: 'retry' | 'error' | 'test' | 'success' = 'retry';
  private testMode = false;
  private progressMessage = '';
  private keyMask = '';
  private keyConfigured = false;
  private provider = 'gemini';
  private model = 'gemini-2.5-flash';
  private welcomeBanner = false;
  private welcomeReason: 'new' | 'stale' = 'new';
  private findingsDiff?: FindingsDiffView;
  private customFocus = '';
  private auditResume?: AuditResumeView;
  private autoResumeView?: AutoResumeIndicator;
  private autoResumeEnabled = false;
  private autoResumeMaxAttempts = 0;
  private autoResumeMaxMinutes = 0;
  private uiPrefs: UiPrefs = DEFAULT_UI_PREFS;
  private language: Lang = 'ru';
  private onboardingHidden = false;
  private firstAuditDone: boolean | undefined;
  private progressInfo?: { checked: number; total: number; etaSeconds?: number | null; pass?: number; totalPasses?: number };
  private auditSummary?: { issues: number; files: number; seconds: number };
  private auditDurations: number[] = [];
  private onWelcomeStart?: () => void;
  private onWelcomeDismiss?: () => void;

  private messageSubscription?: vscode.Disposable;
  private configSubscription?: vscode.Disposable;

  private refreshAutoResumeSettings(): void {
    const config = vscode.workspace.getConfiguration('codescout');
    this.autoResumeEnabled = config.get<boolean>('autoResume', false);
    this.autoResumeMaxAttempts = clampSetting(config.get<number>('autoResumeMaxAttempts'), 1000);
    this.autoResumeMaxMinutes = clampSetting(config.get<number>('autoResumeMaxMinutes'), 10000);
    this.uiPrefs = normalizeUiPrefs({
      theme: config.get<string>('uiTheme', 'auto') as UiPrefs['theme'],
      accent: config.get<string>('accentColor', 'auto') as UiPrefs['accent'],
      density: config.get<string>('uiDensity', 'standard') as UiPrefs['density'],
      fontSize: config.get<string>('uiFontSize', 'm') as UiPrefs['fontSize'],
      showConfidence: config.get<boolean>('showConfidence', true),
      findingsSort: config.get<string>('findingsSort', 'severity') as UiPrefs['findingsSort'],
      reportTheme: config.get<string>('reportTheme', 'auto') as UiPrefs['reportTheme'],
      customColors: config.get<string>('customColors', '')
    });
    this.language = normalizeLang(config.get<string>('language', 'ru'));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.messageSubscription?.dispose();
    this.view = webviewView;
    webviewView.onDidDispose(() => {
      this.messageSubscription?.dispose();
      this.messageSubscription = undefined;
      this.configSubscription?.dispose();
      this.configSubscription = undefined;
      if (this.view === webviewView) this.view = undefined;
    });
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    this.refreshAutoResumeSettings();
    this.configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      const watched = ['autoResume', 'autoResumeMaxAttempts', 'autoResumeMaxMinutes', 'uiTheme', 'accentColor', 'uiDensity', 'uiFontSize', 'showConfidence', 'findingsSort', 'reportTheme', 'customColors', 'language'];
      if (!watched.some((key) => event.affectsConfiguration(`codescout.${key}`))) return;
      this.refreshAutoResumeSettings();
      this.render();
    });
    this.messageSubscription = webviewView.webview.onDidReceiveMessage((message: ScanMessage) => {
      if (!message || typeof message !== 'object') return;
      if (message.command === 'scanLastCommit') {
        void vscode.commands.executeCommand('codescout.scanLastCommit');
      } else if (message.command === 'scanUncommitted') {
        void vscode.commands.executeCommand('codescout.scanUncommitted');
      } else if (message.command === 'scanFull' || message.command === 'startFullAudit') {
        this.onWelcomeStart?.();
        this.welcomeBanner = false;
        this.render();
        void vscode.commands.executeCommand('codescout.scanFull');
      } else if (message.command === 'dismissWelcome') {
        this.onWelcomeDismiss?.();
        this.welcomeBanner = false;
        this.render();
      } else if (message.command === 'resumeAudit') {
        void vscode.commands.executeCommand('codescout.resumeAudit');
      } else if (message.command === 'restartAudit') {
        void vscode.commands.executeCommand('codescout.restartAudit');
      } else if (message.command === 'setApiKey') {
        void vscode.commands.executeCommand('codescout.setApiKey');
      } else if (message.command === 'openSettings') {
        void vscode.commands.executeCommand('codescout.openSettings');
      } else if (message.command === 'openSettingsPage') {
        void vscode.commands.executeCommand('codescout.openSettingsPage', message.anchor ?? '');
      } else if (message.command === 'toggleLanguage') {
        void vscode.commands.executeCommand('codescout.toggleLanguage');
      } else if (message.command === 'dismissOnboarding') {
        void vscode.commands.executeCommand('codescout.dismissOnboarding');
      } else if (message.command === 'openReport') {
        void vscode.commands.executeCommand('codescout.openAuditReport');
      } else if (message.command === 'runAgain') {
        void vscode.commands.executeCommand('codescout.scanFull');
      } else if (message.command === 'reportIssue') {
        void vscode.commands.executeCommand('codescout.reportIssue');
      } else if (message.command === 'customReview') {
        void vscode.commands.executeCommand('codescout.customReview', message.focus ?? '', message.scope ?? 'all', message.globs ?? '');
      } else if (message.command === 'clearApiKey') {
        void vscode.commands.executeCommand('codescout.clearApiKey');
      } else if (message.command === 'chooseModel') {
        void vscode.commands.executeCommand('codescout.chooseModel');
      } else if (message.command === 'openKeyLink') {
        void vscode.env.openExternal(vscode.Uri.parse('https://aistudio.google.com/apikey'));
      } else if (message.command === 'testSample') {
        void vscode.commands.executeCommand('codescout.testSample');
      } else if (message.command === 'cancelScan') {
        void vscode.commands.executeCommand('codescout.cancelScan');
      } else if (message.command === 'pickScope') {
        void this.handlePickScope();
      } else if (message.command === 'openFile' && message.file && message.line !== undefined) {
        const requestedUri = vscode.Uri.file(resolve(message.file));
        const root = vscode.workspace.getWorkspaceFolder(requestedUri) ?? vscode.workspace.workspaceFolders?.[0];
        if (!root) {
          void vscode.window.showErrorMessage(t('panel.errOpenFileNoWorkspace', this.language));
          return;
        }
        // Fallback joinPath-контракт: vscode.Uri.joinPath(root.uri, message.file) даёт тот же candidate для относительных путей
        const candidate = resolve(root.uri.fsPath, message.file);
        const realRoot = realExistingPath(root.uri.fsPath);
        const realCandidate = realExistingPath(candidate);
        const inside = relative(realRoot, realCandidate);
        const outsideWorkspace = inside === '' || inside.startsWith('..') || isAbsolute(inside);
        if (outsideWorkspace) {
          void vscode.window.showErrorMessage(t('panel.errFileNotFound', this.language, { file: message.file }));
          return;
        }
        const fileUri = vscode.Uri.file(realCandidate);
        void vscode.workspace.openTextDocument(fileUri).then((document) => {
          const rawLine = parseInt(String(message.line), 10);
          const line = Number.isInteger(rawLine) && rawLine >= 1 ? rawLine - 1 : 0;
          const position = new vscode.Position(Math.min(line, Math.max(0, document.lineCount - 1)), 0);
          return vscode.window.showTextDocument(document, { preview: false }).then((editor) => {
            const range = new vscode.Range(position, position);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(position, position);
          });
        }, () => {
          void vscode.window.showErrorMessage(t('panel.errFileNotFound', this.language, { file: message.file ?? '' }));
        });
      }
    }, undefined, []);
    this.render();
  }

  private async handlePickScope(): Promise<void> {
    const webview = this.view?.webview;
    if (!webview) return;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      await webview.postMessage({ type: 'scopePickResult', globs: [], outside: [], noWorkspace: true });
      return;
    }
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, defaultUri: vscode.Uri.file(workspaceRoot), openLabel: t('dialog.addToScope', this.language) });
    const globs: string[] = [];
    const outside: string[] = [];
    for (const uri of picked ?? []) {
      const rel = relative(workspaceRoot, resolve(uri.fsPath)).replaceAll('\\', '/');
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) { outside.push(uri.fsPath); continue; }
      let isDirectory = false;
      try {
        isDirectory = (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.Directory;
      } catch {
        isDirectory = false;
      }
      globs.push(isDirectory ? `${rel}/**` : rel);
    }
    await webview.postMessage({ type: 'scopePickResult', globs, outside });
  }

  setWelcomeChoiceHandler(onStart: () => void, onDismiss?: () => void): void {
    this.onWelcomeStart = onStart;
    this.onWelcomeDismiss = onDismiss;
  }

  forceLanguageRefresh(): void {
    this.refreshAutoResumeSettings();
    this.render();
  }

  setOnboardingHidden(hidden: boolean): void {
    this.onboardingHidden = hidden;
    this.render();
  }

  setFirstAuditDone(done: boolean | undefined): void {
    this.firstAuditDone = done;
    this.render();
  }

  showAuditSummary(summary: { issues: number; files: number; seconds: number } | undefined): void {
    this.auditSummary = summary;
    this.render();
  }

  recordFileDuration(seconds: number): void {
    if (Number.isFinite(seconds) && seconds >= 0) this.auditDurations.push(seconds);
  }

  getFileDurations(): number[] {
    return [...this.auditDurations];
  }

  setAuditPass(pass: number, totalPasses: number): void {
    if (this.progressInfo) this.progressInfo = { ...this.progressInfo, pass, totalPasses };
  }

  setWelcomeBanner(visible: boolean, reason: 'new' | 'stale' = 'new'): void {
    this.welcomeBanner = visible;
    this.welcomeReason = reason;
    this.render();
  }

  setAuditResume(resume: AuditResumeView | undefined): void {
    this.auditResume = resume;
    this.render();
  }

  // Персистентный частичный отчёт (v1.4b-15): после рестарта VS Code
  // панель рисует находки с диска как обычный отчёт + resume-баннер.
  // Единственный источник правды о скане — хост; во время живого скана
  // рестору нечего делать (иначе он сбил бы скан-UI).
  restoreAuditResults(issues: ReviewIssue[], stats: ReportStats, resume: AuditResumeView | undefined): void {
    if (this.scanning) return;
    this.issues = issues;
    this.stats = stats;
    this.hasRun = true;
    this.scanning = false;
    this.testMode = false;
    this.progressMessage = '';
    this.statusMessage = '';
    this.findingsDiff = undefined;
    this.customFocus = '';
    this.auditSummary = undefined;
    this.auditResume = resume;
    this.render();
  }

  setKey(keyMaskOrStatus: string | boolean | undefined, provider = 'gemini', model = 'gemini-2.5-flash'): void {
    if (typeof keyMaskOrStatus === 'string') {
      this.keyMask = keyMaskOrStatus;
      this.keyConfigured = keyMaskOrStatus.trim().length > 0;
    } else {
      this.keyConfigured = keyMaskOrStatus === true;
      if (!this.keyConfigured) this.keyMask = '';
    }
    this.provider = provider;
    this.model = model;
    this.render();
  }

  setScanning(scanning: boolean, keepAuditStats = false): void {
    this.scanning = scanning;
    if (scanning) {
      this.statusMessage = '';
      this.progressMessage = '';
      this.statusKind = 'retry';
      this.findingsDiff = undefined;
      this.customFocus = '';
      this.auditResume = undefined;
      this.autoResumeView = undefined;
      this.progressInfo = undefined;
      this.auditSummary = undefined;
      if (!keepAuditStats) this.auditDurations = [];
    }
    this.render();
  }

  isScanRunning(): boolean {
    return this.scanning;
  }

  private liveWebview(): vscode.Webview | undefined {
    return this.view && this.scanning ? this.view.webview : undefined;
  }

  setProgress(index: number, total: number, filename: string, label?: string, elapsedMs = 0, etaSeconds?: number | null): void {
    this.scanning = true;
    this.progressMessage = t('progress.fileLine', this.language, { label: label ?? t('progress.file.check', this.language), index, total, file: filename, s: Math.floor(elapsedMs / 1000) });
    this.progressInfo = { checked: index, total, etaSeconds, pass: this.progressInfo?.pass, totalPasses: this.progressInfo?.totalPasses };
    const webview = this.liveWebview();
    if (webview) {
      safePost(webview, { type: 'progress', text: this.progressMessage, elapsedMs, checked: index, total, etaSeconds, pass: this.progressInfo.pass, totalPasses: this.progressInfo.totalPasses });
      return;
    }
    this.render();
  }

  setModelThinking(elapsedMs = 0): void {
    this.scanning = true;
    this.progressMessage = t('status.thinking', this.language, { s: Math.floor(elapsedMs / 1000) });
    const webview = this.liveWebview();
    if (webview) {
      safePost(webview, { type: 'progress', text: this.progressMessage, elapsedMs });
      return;
    }
    this.render();
  }

  setRetry(event: RetryEvent, model = 'model'): void {
    this.scanning = true;
    this.statusKind = 'retry';
    this.statusMessage = t('status.retry', this.language, { model, s: event.waitSeconds, a: event.attempt, m: event.maxRetries });
    const webview = this.liveWebview();
    if (webview) {
      safePost(webview, { type: 'status', message: this.statusMessage, kind: 'retry' });
      return;
    }
    this.render();
  }

  setAutoResume(view: AutoResumeIndicator | undefined): void {
    this.autoResumeView = view;
    const webview = this.view && this.scanning ? this.view.webview : undefined;
    if (webview) {
      safePost(webview, view ? { type: 'auto', ...view } : { type: 'auto', off: true });
      return;
    }
    this.render();
  }

  setCancelled(): void {
    this.scanning = false;
    this.hasRun = true;
    this.progressMessage = '';
    this.autoResumeView = undefined;
    this.statusKind = 'error';
    this.statusMessage = t('status.cancelled', this.language);
    this.render();
  }

  setError(message: string): void {
    this.scanning = false;
    this.hasRun = true;
    this.testMode = false;
    this.progressMessage = '';
    this.statusKind = 'error';
    this.statusMessage = message;
    this.render();
  }

  update(issues: ReviewIssue[], stats: ReportStats, testMode = false, testMessage = '', testWarning = false, findingsDiff?: FindingsDiffView, customFocus = ''): void {
    this.issues = issues;
    this.stats = stats;
    this.hasRun = true;
    this.scanning = false;
    this.testMode = testMode;
    this.findingsDiff = findingsDiff;
    this.customFocus = customFocus;
    this.auditResume = undefined;
    this.autoResumeView = undefined;
    this.progressMessage = '';
    this.statusMessage = testMessage;
    this.statusKind = testWarning ? 'error' : testMode ? 'test' : 'success';
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    const webview = this.view.webview;
    const assets: WebviewAssets = {
      codiconCss: webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'codicon.css')).toString(),
      cspSource: webview.cspSource
    };
    const nonce = randomBytes(16).toString('hex');
    const ux: PanelUx = {
      onboarding: !this.keyConfigured && !this.onboardingHidden,
      firstAudit: this.keyConfigured && this.firstAuditDone === false,
      progress: this.progressInfo ? { ...this.progressInfo } : undefined,
      summary: !this.scanning && this.auditSummary ? { ...this.auditSummary } : undefined
    };
    this.view.webview.html = this.hasRun || this.scanning
      ? buildReportHtml(this.issues, this.stats, this.scanning, !this.hasRun, this.statusMessage, this.statusKind, this.keyMask, this.keyConfigured, this.provider, this.model, this.testMode, this.progressMessage, this.welcomeBanner, this.welcomeReason, this.findingsDiff, this.customFocus, this.auditResume, this.autoResumeView, this.autoResumeEnabled, this.autoResumeMaxAttempts, this.autoResumeMaxMinutes, assets, nonce, this.uiPrefs, this.language, ux)
      : buildEmptyReportHtml(this.keyMask, this.keyConfigured, this.provider, this.model, this.welcomeBanner, this.welcomeReason, this.auditResume, this.autoResumeEnabled, this.autoResumeMaxAttempts, this.autoResumeMaxMinutes, assets, nonce, this.uiPrefs, this.language, ux);
  }
}
