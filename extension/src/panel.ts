import * as vscode from 'vscode';
import { realpathSync } from 'node:fs';
import { ReviewIssue } from '../../src/types';
import { RetryEvent } from '../../src/llm-client';
import { maskApiKey } from '../../src/providers';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { buildEmptyReportHtml, buildReportHtml, ReportStats, AutoResumeIndicator } from './reportHtml';
import type { AuditResumeView, FindingsDiffView } from './projectAudit';

interface ScanMessage {
  command?: string;
  file?: string;
  line?: number | string;
  focus?: string;
  scope?: string;
  globs?: string;
}

function safePost(webview: vscode.Webview, message: Record<string, unknown>): void {
  try {
    void Promise.resolve(webview.postMessage(message)).then(undefined, () => undefined);
  } catch {
    // webview уже утилизирован: состояние живёт в полях панели, следующий render()/resolve догонит
  }
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
  private onWelcomeStart?: () => void;
  private onWelcomeDismiss?: () => void;

  private messageSubscription?: vscode.Disposable;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.messageSubscription?.dispose();
    this.view = webviewView;
    webviewView.onDidDispose(() => {
      this.messageSubscription?.dispose();
      this.messageSubscription = undefined;
      if (this.view === webviewView) this.view = undefined;
    });
    webviewView.webview.options = { enableScripts: true };
    this.autoResumeEnabled = vscode.workspace.getConfiguration('codescout').get<boolean>('autoResume', false);
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('codescout.autoResume')) return;
      this.autoResumeEnabled = vscode.workspace.getConfiguration('codescout').get<boolean>('autoResume', false);
      this.render();
    }, undefined, []);
    this.messageSubscription = webviewView.webview.onDidReceiveMessage((message: ScanMessage) => {
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
        void vscode.commands.executeCommand('codescout.openSettingsPage');
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
      } else if (message.command === 'openFile' && message.file && message.line !== undefined) {
        const requestedUri = vscode.Uri.file(resolve(message.file));
        const root = vscode.workspace.getWorkspaceFolder(requestedUri) ?? vscode.workspace.workspaceFolders?.[0];
        if (!root) {
          void vscode.window.showErrorMessage('Открой папку workspace, чтобы перейти к файлу.');
          return;
        }
        // Fallback joinPath-контракт: vscode.Uri.joinPath(root.uri, message.file) даёт тот же candidate для относительных путей
        const candidate = resolve(root.uri.fsPath, message.file);
        const realRoot = realExistingPath(root.uri.fsPath);
        const realCandidate = realExistingPath(candidate);
        const inside = relative(realRoot, realCandidate);
        const outsideWorkspace = inside === '' || inside.startsWith('..') || isAbsolute(inside);
        if (outsideWorkspace) {
          void vscode.window.showErrorMessage(`Файл не найден в workspace: ${message.file}`);
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
          void vscode.window.showErrorMessage(`Файл не найден в workspace: ${message.file}`);
        });
      }
    }, undefined, []);
    this.render();
  }

  setWelcomeChoiceHandler(onStart: () => void, onDismiss?: () => void): void {
    this.onWelcomeStart = onStart;
    this.onWelcomeDismiss = onDismiss;
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

  setKey(key: string | undefined, provider = 'gemini', model = 'gemini-2.5-flash'): void {
    this.keyConfigured = Boolean(key?.trim());
    this.keyMask = key ? maskApiKey(key) : '';
    this.provider = provider;
    this.model = model;
    this.render();
  }

  setScanning(scanning: boolean): void {
    this.scanning = scanning;
    if (scanning) {
      this.statusMessage = '';
      this.progressMessage = '';
      this.statusKind = 'retry';
      this.findingsDiff = undefined;
      this.customFocus = '';
      this.auditResume = undefined;
      this.autoResumeView = undefined;
    }
    this.render();
  }

  private liveWebview(): vscode.Webview | undefined {
    return this.view && this.scanning ? this.view.webview : undefined;
  }

  setProgress(index: number, total: number, filename: string, label = '🔎 Проверяю файл', elapsedMs = 0): void {
    this.scanning = true;
    this.progressMessage = `${label} ${index}/${total}: ${filename}... · ⏱ ${Math.floor(elapsedMs / 1000)}с`;
    const webview = this.liveWebview();
    if (webview) {
      safePost(webview, { type: 'progress', text: this.progressMessage, elapsedMs });
      return;
    }
    this.render();
  }

  setModelThinking(elapsedMs = 0): void {
    this.scanning = true;
    this.progressMessage = `🤖 Модель думает... · ⏱ ${Math.floor(elapsedMs / 1000)}с`;
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
    this.statusMessage = `⏳ Rate limit у ${model}, ожидание ${event.waitSeconds}с (попытка ${event.attempt}/${event.maxRetries})...`;
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
    this.statusMessage = '⛔ Сканирование остановлено пользователем';
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
    this.view.webview.html = this.hasRun || this.scanning
      ? buildReportHtml(this.issues, this.stats, this.scanning, !this.hasRun, this.statusMessage, this.statusKind, this.keyMask, this.keyConfigured, this.provider, this.model, this.testMode, this.progressMessage, this.welcomeBanner, this.welcomeReason, this.findingsDiff, this.customFocus, this.auditResume, this.autoResumeView, this.autoResumeEnabled)
      : buildEmptyReportHtml(this.keyMask, this.keyConfigured, this.provider, this.model, this.welcomeBanner, this.welcomeReason, this.auditResume, this.autoResumeEnabled);
  }
}
