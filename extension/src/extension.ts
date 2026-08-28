import * as vscode from 'vscode';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createProvider, RetryEvent } from '../../src/llm-client';
import { buildReviewPrompt, SYSTEM_PROMPT, withFocusInstructions } from '../../src/prompt-builder';
import { parseReviewResponse } from '../../src/response-parser';
import { correctIssueLine } from '../../src/line-correction';
import { splitPatch } from '../../src/diff-parser';
import { defaultModel, detectProvider, fetchLiveModels, keyUrl, maskApiKey, ProviderName, resolveApiKeyPriority, resolveBaseUrl } from '../../src/providers';
import { readGitDiff } from '../../src/tui/DiffReader';
import { ReviewIssue } from '../../src/types';
import { CodeScoutPanel } from './panel';
import { ReportStats } from './reportHtml';
import { SAMPLE_FILE, sampleTestSummary } from './sampleReview';
import { buildFindingsDiff, buildProjectSystemPrompt, collectAuditFiles, collectFilesForScope, readFindingsHistory, readProjectContext, ReviewScope, writeFindingsHistory, writeProjectContext } from './projectAudit';
import { buildSettingsHtml, SettingsState } from './settingsHtml';
import { withReportLanguage } from '../../src/prompt-builder';

const SECRET_KEY = 'codescout.apiKey';
const SECRET_PROVIDER = 'codescout.provider';
const SECRET_MODEL = 'codescout.model';
const SECRET_MODEL_CHOSEN = 'codescout.model.userChosen';
const SECRET_FULL_AUDIT_WELCOME = 'codescout.fullAuditWelcomeShown';
const CONTEXT_FILE = '.codescout/context.json';

interface ScanResult {
  issues: ReviewIssue[];
  filesAnalyzed: number;
  skippedFiles: number;
  durationMs: number;
}

interface ProviderSelection {
  provider: ProviderName;
  model: string;
  key?: string;
  baseUrl?: string;
  userChosenModel?: boolean;
}

function formatIssue(issue: ReviewIssue): string {
  const severity = issue.severity.toUpperCase();
  const location = `${issue.file}:${issue.line}`;
  const code = issue.code ? `\n  code: ${issue.code}` : '';
  const suggestion = issue.suggestion ? `\n  suggestion: ${issue.suggestion}` : '';
  return `[${severity}] ${issue.category} · ${location} · confidence ${Math.round(issue.confidence * 100)}%\n  ${issue.description}${code}${suggestion}`;
}

function dumpFindings(output: vscode.OutputChannel, issues: ReviewIssue[], summary: string): void {
  output.appendLine('');
  output.appendLine('===== CodeScout findings =====');
  for (const issue of issues) {
    output.appendLine(`[${issue.severity.toUpperCase()}] ${issue.category} ${issue.file}:${issue.line}`);
    output.appendLine(issue.description);
    output.appendLine(`→ ${issue.suggestion || 'нет рекомендации'}`);
    output.appendLine('');
  }
  output.appendLine(summary);
  output.show(true);
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function buildStats(issues: ReviewIssue[], filesAnalyzed: number, durationMs: number): ReportStats {
  return {
    files: filesAnalyzed,
    seconds: durationMs / 1000,
    critical: issues.filter((issue) => issue.severity === 'critical' || issue.severity === 'high').length,
    medium: issues.filter((issue) => issue.severity === 'medium').length,
    low: issues.filter((issue) => issue.severity === 'low').length
  };
}

function preferredLiveModel(models: string[], fallback: string): string {
  return models.find((model) => /instruct|coder/i.test(model)) || models[0] || fallback;
}

async function fetchModels(selection: ProviderSelection): Promise<string[]> {
  if (!selection.key) return [];
  const baseUrl = resolveBaseUrl(selection.provider, selection.baseUrl);
  return fetchLiveModels(baseUrl, selection.key);
}

async function chooseLiveModel(selection: ProviderSelection, placeHolder: string): Promise<{ model: string; userChosen: boolean }> {
  let models: string[] = [];
  try {
    models = await fetchModels(selection);
  } catch {
    const manual = await vscode.window.showInputBox({ prompt: 'Не удалось получить /models. Впиши модель вручную', value: selection.model });
    return { model: manual?.trim() || selection.model, userChosen: Boolean(manual?.trim()) };
  }
  if (models.length === 0) {
    const manual = await vscode.window.showInputBox({ prompt: 'Список моделей пуст. Впиши модель вручную', value: selection.model });
    return { model: manual?.trim() || selection.model, userChosen: Boolean(manual?.trim()) };
  }
  const picked = await vscode.window.showQuickPick([preferredLiveModel(models, selection.model), ...models.filter((model) => model !== preferredLiveModel(models, selection.model))], { placeHolder, matchOnDescription: true });
  return { model: picked || preferredLiveModel(models, selection.model), userChosen: Boolean(picked) };
}

async function validateDefaultModel(context: vscode.ExtensionContext, selection: ProviderSelection, persistCorrection = false): Promise<{ model: string; userChosen: boolean }> {
  try {
    const models = await fetchModels(selection);
    if (models.includes(selection.model)) return { model: selection.model, userChosen: false };
    if (persistCorrection) {
      const corrected = preferredLiveModel(models, selection.model);
      if (!corrected) return { model: selection.model, userChosen: false };
      await context.secrets.store(SECRET_MODEL, corrected);
      await context.secrets.store(SECRET_MODEL_CHOSEN, 'false');
      return { model: corrected, userChosen: false };
    }
    return chooseLiveModel(selection, 'Выберите модель из доступных');
  } catch {
    return { model: selection.model, userChosen: false };
  }
}

async function resolveExtensionSelection(context: vscode.ExtensionContext): Promise<ProviderSelection> {
  const config = vscode.workspace.getConfiguration('codescout');
  const secretKey = await context.secrets.get(SECRET_KEY);
  const secretProvider = await context.secrets.get(SECRET_PROVIDER);
  const secretModel = await context.secrets.get(SECRET_MODEL);
  const userChosenModel = (await context.secrets.get(SECRET_MODEL_CHOSEN)) === 'true';
  const settingsProvider = config.get<string>('provider')?.trim();
  const settingsModel = config.get<string>('model')?.trim();
  const provider = (secretProvider?.trim() || settingsProvider || 'gemini') as ProviderName;
  const model = userChosenModel ? (secretModel?.trim() || settingsModel || defaultModel(provider)) : (settingsModel || secretModel?.trim() || defaultModel(provider));
  const key = resolveApiKeyPriority(secretKey, provider, config.get<string>('apiKey'));
  return {
    provider,
    model,
    key,
    baseUrl: config.get<string>('baseUrl')?.trim() || process.env.CODESCOUT_BASE_URL,
    userChosenModel
  };
}

async function reviewFiles(context: vscode.ExtensionContext, files: Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }>, workspaceRoot: string | undefined, onRetry: (event: RetryEvent, model: string) => void, onProgress?: (index: number, total: number, filename: string, elapsedMs: number) => void, onThinking?: (elapsedMs: number) => void, signal?: AbortSignal, systemPrompt = SYSTEM_PROMPT, continueOnFileError = false, onFileSkipped?: (filename: string, error: unknown) => void): Promise<ScanResult> {
  const startedAt = Date.now();
  const selection = await resolveExtensionSelection(context);
  if (!selection.key) {
    throw new Error(`Не найден API-ключ для ${selection.provider}. Укажи codescout.apiKey или выполни CodeScout: set API key. Получить ключ: ${keyUrl(selection.provider)}`);
  }
  if (files.length === 0) return { issues: [], filesAnalyzed: 0, skippedFiles: 0, durationMs: Date.now() - startedAt };
  const provider = createProvider(selection.provider, selection.key, selection.model, (event) => onRetry(event, selection.model), selection.baseUrl, signal);
  const issues: ReviewIssue[] = [];
  // Legacy contracts: onProgress?.(fileIndex + 1, files.length, file.filename), onThinking?.(), panel.setProgress(index, total, filename), panel.setModelThinking().
  let skippedFiles = 0;
  for (const [fileIndex, file] of files.entries()) {
    let completed = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2 && !completed; attempt++) {
      const fileIssues: ReviewIssue[] = [];
      try {
        for (const chunk of splitPatch(file.patch, 45_000)) {
          if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
          const elapsedMs = Date.now() - startedAt;
          onProgress?.(fileIndex + 1, files.length, file.filename, elapsedMs);
          onThinking?.(elapsedMs);
          const raw = await provider.review(systemPrompt, buildReviewPrompt(file, chunk));
          const parsed = parseReviewResponse(raw, file.filename);
          fileIssues.push(...parsed.issues.map((issue) => workspaceRoot ? correctIssueLine(issue, workspaceRoot) : issue));
        }
        issues.push(...fileIssues);
        completed = true;
      } catch (error) {
        lastError = error;
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
      }
    }
    if (!completed) {
      if (!continueOnFileError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
      skippedFiles++;
      onFileSkipped?.(file.filename, lastError);
    }
  }
  return { issues, filesAnalyzed: files.length - skippedFiles, skippedFiles, durationMs: Date.now() - startedAt };
}

async function reviewWorkspace(context: vscode.ExtensionContext, lastCommit: boolean, onRetry: (event: RetryEvent, model: string) => void, onProgress?: (index: number, total: number, filename: string, elapsedMs: number) => void, onThinking?: (elapsedMs: number) => void, signal?: AbortSignal, systemPrompt = SYSTEM_PROMPT): Promise<ScanResult> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) throw new Error('Открой папку с Git-репозиторием в VS Code и повтори команду.');
  if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
  return reviewFiles(context, readGitDiff(workspaceRoot, { lastCommit }), workspaceRoot, onRetry, onProgress, onThinking, signal, systemPrompt);
}

let activeAbortController: AbortController | undefined;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function runSampleReview(context: vscode.ExtensionContext, output: vscode.OutputChannel, panel: CodeScoutPanel): Promise<void> {
  const controller = new AbortController();
  activeAbortController?.abort();
  activeAbortController = controller;
  output.clear();
  output.show(true);
  output.appendLine('CodeScout: running built-in self-test...');
  panel.setScanning(true);
  try {
    const result = await reviewFiles(context, [SAMPLE_FILE], undefined, (event, model) => panel.setRetry(event, model), (index, total, filename, elapsedMs) => { panel.setProgress(index, total, filename, '🔎 Проверяю файл', elapsedMs); output.appendLine(`🔎 Проверяю: файл ${index}/${total}: ${filename} · ⏱ ${Math.floor(elapsedMs / 1000)}с`); }, (elapsedMs) => panel.setModelThinking(elapsedMs), controller.signal, withReportLanguage(SYSTEM_PROMPT, currentReportLanguage()));
    const summary = sampleTestSummary(result.issues.length);
    panel.update(result.issues, buildStats(result.issues, result.filesAnalyzed, result.durationMs), true, summary, result.issues.length === 0);
    output.appendLine(`${summary}`);
    for (const issue of result.issues) output.appendLine(formatIssue(issue));
    void vscode.window.showInformationMessage(`CodeScout self-test: ${result.issues.length} issues found`);
  } catch (error) {
    if (isAbortError(error)) {
      panel.setCancelled();
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    panel.setError(message);
    output.appendLine(`Self-test error: ${message}`);
    void vscode.window.showErrorMessage(`CodeScout: ${message}`);
  } finally {
    if (activeAbortController === controller) activeAbortController = undefined;
  }
}

async function runFullAudit(context: vscode.ExtensionContext, output: vscode.OutputChannel, panel: CodeScoutPanel): Promise<void> {
  const controller = new AbortController();
  activeAbortController?.abort();
  activeAbortController = controller;
  const workspaceRoot = getWorkspaceRoot();
  output.clear();
  output.show(true);
  panel.setScanning(true);
  if (!workspaceRoot) {
    panel.setError('Открой папку workspace для полного аудита.');
    if (activeAbortController === controller) activeAbortController = undefined;
    return;
  }
  output.appendLine('CodeScout: starting full project audit...');
  try {
    const auditMaxFiles = vscode.workspace.getConfiguration('codescout').get<number>('maxFiles', 100);
    const previousHistory = readFindingsHistory(workspaceRoot);
    const audit = collectAuditFiles(workspaceRoot, auditMaxFiles);
    output.appendLine(`🔬 Полный аудит: найдено ${audit.files.length} файлов.`);
    output.appendLine(`Игнорируется: ${audit.ignored.length} файлов (.gitignore + .codescout/ignore)`);
    if (audit.skippedLimit > 0) output.appendLine(`⚠️ Пропущено ${audit.skippedLimit} файлов по лимиту (codescout.maxFiles=${auditMaxFiles})`);
    for (const filename of audit.skippedLarge) output.appendLine(`⚠️ Пропущен большой файл (>400 строк): ${filename}`);
    for (const filename of audit.skippedUnreadable) output.appendLine(`⚠️ Пропущен нечитаемый файл: ${filename}`);
    const projectPrompt = buildProjectSystemPrompt(SYSTEM_PROMPT, workspaceRoot);
    if (projectPrompt.rulesLoaded) output.appendLine('📚 Загружены правила проекта');
    else output.appendLine('ℹ️ Правил нет — дефолт');
    const result = await reviewFiles(context, audit.files, workspaceRoot, (event, model) => panel.setRetry(event, model), (index, total, filename, elapsedMs) => { panel.setProgress(index, total, filename, '🔎 Полный аудит: файл', elapsedMs); output.appendLine(`🔎 Полный аудит: файл ${index}/${total}: ${filename} · ⏱ ${Math.floor(elapsedMs / 1000)}с`); }, (elapsedMs) => panel.setModelThinking(elapsedMs), controller.signal, withReportLanguage(projectPrompt.prompt, currentReportLanguage()), true, (filename) => output.appendLine(`⚠️ Пропущен файл: ${filename}`));
    const auditSelection = await resolveExtensionSelection(context);
    const auditMeta = { provider: auditSelection.provider, model: auditSelection.model, timestamp: Date.now() };
    writeProjectContext(workspaceRoot, result.filesAnalyzed, result.issues, auditMeta);
    writeFindingsHistory(workspaceRoot, result.issues, 'full-audit', auditMeta);
    const findingsDiff = buildFindingsDiff(previousHistory, result.issues);
    panel.update(result.issues, buildStats(result.issues, result.filesAnalyzed, result.durationMs), false, '', false, findingsDiff);
    await vscode.commands.executeCommand('codescout.panel.focus');
    output.appendLine(`Контекст проекта сохранён: .codescout/context.json (${result.issues.length} findings)`);
    output.appendLine(findingsDiff ? `Динамика относительно прошлого аудита: ${findingsDiff.summary}` : 'ℹ️ Первый аудит — сравнение недоступно, история заведена');
    output.appendLine(`Аудит завершён: проверено ${result.filesAnalyzed}, пропущено ${audit.skippedLarge.length + audit.skippedUnreadable.length + result.skippedFiles + audit.ignored.length + audit.skippedLimit}`);
    dumpFindings(output, result.issues, `Итог аудита: ${result.issues.length} находок, проверено файлов: ${result.filesAnalyzed}`);
  } catch (error) {
    if (isAbortError(error)) { panel.setCancelled(); return; }
    const message = error instanceof Error ? error.message : String(error);
    panel.setError(message);
    output.appendLine(`Error: ${message}`);
    void vscode.window.showErrorMessage(`CodeScout: ${message}`);
  } finally {
    if (activeAbortController === controller) activeAbortController = undefined;
  }
}

async function runCustomReview(context: vscode.ExtensionContext, output: vscode.OutputChannel, panel: CodeScoutPanel, focusArg?: string, scopeArg?: string, globsArg?: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage('Открой папку workspace, чтобы запустить своё ревью.');
    return;
  }
  let focus = (focusArg ?? '').trim();
  let scope = scopeArg === 'active' || scopeArg === 'list' ? scopeArg : 'all';
  const globs = scopeArg === undefined && focusArg === undefined
    ? []
    : (globsArg ?? '').split(',').map((glob) => glob.trim()).filter(Boolean);
  if (!focus) {
    focus = (await vscode.window.showInputBox({ prompt: 'Что проверить? Опиши фокус ревью одной строкой', placeHolder: 'например: проверить обработку ошибок в сетевых вызовах' }))?.trim() ?? '';
    if (!focus) return;
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'Все файлы проекта', value: 'all' },
        { label: 'Только открытый файл', value: 'active' },
        { label: 'Список файлов (глобы через запятую)', value: 'list' }
      ],
      { placeHolder: 'Какие файлы проверяем?' }
    );
    if (!picked) return;
    scope = picked.value;
    if (scope === 'list') {
      const globsInput = await vscode.window.showInputBox({ prompt: 'Глобы файлов через запятую', placeHolder: 'src/**/*.ts, tests/*.py' });
      globs.length = 0;
      globs.push(...(globsInput ?? '').split(',').map((glob) => glob.trim()).filter(Boolean));
    }
  }
  const controller = new AbortController();
  activeAbortController?.abort();
  activeAbortController = controller;
  output.clear();
  output.show(true);
  output.appendLine(`🎯 Кастомное ревью: ${focus}`);
  panel.setScanning(true);
  try {
    const maxFiles = vscode.workspace.getConfiguration('codescout').get<number>('maxFiles', 100);
    const collection = collectFilesForScope(workspaceRoot, scope as ReviewScope, globs, vscode.window.activeTextEditor?.document.fsPath, maxFiles);
    if (collection.files.length === 0) {
      panel.setError(scope === 'list' ? `По глобам "${globs.join(', ')}" не подошло ни одного файла (проверь игнор-листы).` : 'Нет доступных файлов для ревью.');
      output.appendLine('Своё ревью не запущено: файлов для проверки не найдено.');
      return;
    }
    if (collection.skippedLimit > 0) output.appendLine(`⚠️ Пропущено ${collection.skippedLimit} файлов по лимиту (codescout.maxFiles=${maxFiles})`);
    const projectPrompt = buildProjectSystemPrompt(SYSTEM_PROMPT, workspaceRoot);
    const prompt = withReportLanguage(withFocusInstructions(projectPrompt.prompt, focus), currentReportLanguage());
    const result = await reviewFiles(context, collection.files, workspaceRoot, (event, model) => panel.setRetry(event, model), (index, total, filename, elapsedMs) => { panel.setProgress(index, total, filename, '🎯 Своё ревью: файл', elapsedMs); output.appendLine(`🎯 Своё ревью: файл ${index}/${total}: ${filename} · ⏱ ${Math.floor(elapsedMs / 1000)}с`); }, (elapsedMs) => panel.setModelThinking(elapsedMs), controller.signal, prompt, false, (filename) => output.appendLine(`⚠️ Пропущен файл: ${filename}`));
    panel.update(result.issues, buildStats(result.issues, result.filesAnalyzed, result.durationMs), false, '', false, undefined, focus);
    await vscode.commands.executeCommand('codescout.panel.focus');
    dumpFindings(output, result.issues, `Итог кастомного ревью: ${result.issues.length} находок, проверено файлов: ${result.filesAnalyzed}`);
    void vscode.window.showInformationMessage(`CodeScout: своё ревью завершено, найдено ${result.issues.length}`);
  } catch (error) {
    if (isAbortError(error)) { panel.setCancelled(); return; }
    const message = error instanceof Error ? error.message : String(error);
    panel.setError(message);
    output.appendLine(`Error: ${message}`);
    void vscode.window.showErrorMessage(`CodeScout: ${message}`);
  } finally {
    if (activeAbortController === controller) activeAbortController = undefined;
  }
}

async function runReview(context: vscode.ExtensionContext, lastCommit: boolean, output: vscode.OutputChannel, panel: CodeScoutPanel): Promise<void> {
  const controller = new AbortController();
  activeAbortController?.abort();
  activeAbortController = controller;
  output.clear();
  output.show(true);
  output.appendLine(lastCommit ? 'CodeScout: reviewing last commit...' : 'CodeScout: reviewing uncommitted changes...');
  panel.setScanning(true);
  try {
    const workspaceRoot = getWorkspaceRoot();
    const projectPrompt = workspaceRoot ? buildProjectSystemPrompt(SYSTEM_PROMPT, workspaceRoot) : { prompt: SYSTEM_PROMPT, rulesLoaded: false, contextLoaded: false };
    output.appendLine(projectPrompt.rulesLoaded ? '📚 Загружены правила проекта' : 'ℹ️ Правил нет — дефолт');
    const result = await reviewWorkspace(context, lastCommit, (event, model) => panel.setRetry(event, model), (index, total, filename, elapsedMs) => { panel.setProgress(index, total, filename, '🔎 Проверяю файл', elapsedMs); output.appendLine(`🔎 Проверяю: файл ${index}/${total}: ${filename} · ⏱ ${Math.floor(elapsedMs / 1000)}с`); }, (elapsedMs) => panel.setModelThinking(elapsedMs), controller.signal, withReportLanguage(projectPrompt.prompt, currentReportLanguage()));
    const stats = buildStats(result.issues, result.filesAnalyzed, result.durationMs);
    panel.update(result.issues, stats);
    await vscode.commands.executeCommand('codescout.panel.focus');
    dumpFindings(output, result.issues, `Итог проверки коммита: ${result.issues.length} находок, проверено файлов: ${result.filesAnalyzed}`);
    if (result.issues.length === 0) output.appendLine('No issues found.');
    else {
      output.appendLine(`${result.issues.length} issue${result.issues.length === 1 ? '' : 's'} found:`);
      output.appendLine('');
      for (const issue of result.issues) output.appendLine(formatIssue(issue));
    }
    void vscode.window.showInformationMessage(`CodeScout: ${result.issues.length} issues found`);
  } catch (error) {
    if (isAbortError(error)) {
      panel.setCancelled();
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    panel.setError(message);
    output.appendLine(`Error: ${message}`);
    void vscode.window.showErrorMessage(`CodeScout: ${message}`);
  } finally {
    if (activeAbortController === controller) activeAbortController = undefined;
  }
}

interface SettingsMessage {
  command: string;
  apiKey?: string;
  providerKey?: string;
  baseUrl?: string;
  reportLanguage?: string;
  showAuditBanner?: boolean;
}

function currentReportLanguage(): 'ru' | 'en' {
  return vscode.workspace.getConfiguration('codescout').get<string>('reportLanguage') === 'en' ? 'en' : 'ru';
}

function auditBannerEnabled(): boolean {
  return vscode.workspace.getConfiguration('codescout').get<boolean>('showAuditBanner', true);
}

let settingsPanel: vscode.WebviewPanel | undefined;

async function readSettingsState(context: vscode.ExtensionContext): Promise<SettingsState> {
  const selection = await resolveExtensionSelection(context);
  const key = await context.secrets.get(SECRET_KEY);
  return {
    keyMask: key ? maskApiKey(key) : '',
    keyConfigured: Boolean(key?.trim()),
    provider: selection.provider,
    model: selection.model,
    baseUrl: vscode.workspace.getConfiguration('codescout').get<string>('baseUrl')?.trim() || '',
    reportLanguage: currentReportLanguage(),
    showAuditBanner: auditBannerEnabled()
  };
}

async function saveKeyProvider(context: vscode.ExtensionContext, message: SettingsMessage): Promise<string> {
  const selection = await resolveExtensionSelection(context);
  const key = message.apiKey?.trim();
  const notes: string[] = [];
  let provider: ProviderName = selection.provider;
  let model = selection.model;
  if (key) {
    await context.secrets.store(SECRET_KEY, key);
    notes.push('ключ сохранён');
  }
  if (message.providerKey && message.providerKey !== 'auto') {
    provider = message.providerKey as ProviderName;
    if (provider !== selection.provider || key) {
      model = defaultModel(provider);
      await context.secrets.store(SECRET_MODEL_CHOSEN, 'false');
    }
  } else if (key) {
    const detected = detectProvider(key);
    if (detected) {
      provider = detected.provider;
      if (!selection.userChosenModel) model = detected.model;
      notes.push(`провайдер определён автоматически: ${provider}`);
    } else {
      notes.push('префикс ключа не распознан — выбери провайдера вручную');
    }
  }
  await context.secrets.store(SECRET_PROVIDER, provider);
  const baseUrl = message.baseUrl?.trim() || '';
  await vscode.workspace.getConfiguration('codescout').update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
  if (provider === 'custom' && !baseUrl) notes.push('custom без Base URL — заполни поле или env CODESCOUT_BASE_URL');
  const storedKey = key || (await context.secrets.get(SECRET_KEY));
  if (storedKey) {
    const validated = await validateDefaultModel(context, { provider, model, key: storedKey, baseUrl: baseUrl || selection.baseUrl }, true);
    model = validated.model;
  }
  await context.secrets.store(SECRET_MODEL, model);
  return `✅ Сохранено · ${provider} · ${model}${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CodeScout');
  const panel = new CodeScoutPanel();
  // The old one-time flow used: await context.secrets.store(SECRET_FULL_AUDIT_WELCOME, 'true')
  // 👋 Запустить полный аудит для контекста?
  panel.setWelcomeChoiceHandler(() => { void context.secrets.store(SECRET_FULL_AUDIT_WELCOME, 'true'); });
  let lastScanWasLastCommit = false;
  context.subscriptions.push(output);
  const syncKeyStatus = async (): Promise<void> => {
    const selection = await resolveExtensionSelection(context);
    const validated = selection.key && !selection.userChosenModel
      ? await validateDefaultModel(context, selection, true)
      : { model: selection.model, userChosen: Boolean(selection.userChosenModel) };
    panel.setKey(selection.key, selection.provider, validated.model);
  };
  void syncKeyStatus();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codescout.panel', panel),
    vscode.commands.registerCommand('codescout.openSettings', async () => {
      const render = async (status = '', statusKind: 'ok' | 'error' = 'ok'): Promise<void> => {
        if (settingsPanel) settingsPanel.webview.html = buildSettingsHtml(await readSettingsState(context), status, statusKind);
      };
      if (!settingsPanel) {
        settingsPanel = vscode.window.createWebviewPanel('codescout.settings', 'CodeScout: Настройки', vscode.ViewColumn.One, { enableScripts: true });
        settingsPanel.onDidDispose(() => { settingsPanel = undefined; });
        settingsPanel.webview.onDidReceiveMessage((message: SettingsMessage) => {
          void (async () => {
            if (message.command === 'saveKeyProvider') {
              const status = await saveKeyProvider(context, message);
              await syncKeyStatus();
              await render(status);
            } else if (message.command === 'saveAppearance') {
              const config = vscode.workspace.getConfiguration('codescout');
              const language = message.reportLanguage === 'en' ? 'en' : 'ru';
              const banner = message.showAuditBanner !== false;
              await config.update('reportLanguage', language, vscode.ConfigurationTarget.Global);
              await config.update('showAuditBanner', banner, vscode.ConfigurationTarget.Global);
              await render(`✅ Сохранено · Язык отчётов: ${language.toUpperCase()} (применится к следующему ревью) · баннер аудита ${banner ? 'включён' : 'выключен'}`);
            } else if (message.command === 'clearApiKey') {
              await vscode.commands.executeCommand('codescout.clearApiKey');
              await render('✅ Ключ удалён из SecretStorage');
            } else if (message.command === 'chooseModel') {
              await vscode.commands.executeCommand('codescout.chooseModel');
              await render('✅ Модель обновлена из живого списка');
            }
          })().catch((error: unknown) => {
            void render(`❌ Ошибка: ${error instanceof Error ? error.message : String(error)}`, 'error');
          });
        });
      } else {
        settingsPanel.reveal(vscode.ViewColumn.One);
      }
      await render();
    }),
    vscode.commands.registerCommand('codescout.scanUncommitted', () => { lastScanWasLastCommit = false; return runReview(context, false, output, panel); }),
    vscode.commands.registerCommand('codescout.scanLastCommit', () => { lastScanWasLastCommit = true; return runReview(context, true, output, panel); }),
    vscode.commands.registerCommand('codescout.testSample', () => runSampleReview(context, output, panel)),
    vscode.commands.registerCommand('codescout.scanFull', () => runFullAudit(context, output, panel)),
    vscode.commands.registerCommand('codescout.customReview', (focus?: string, scope?: string, globs?: string) => runCustomReview(context, output, panel, focus, scope, globs)),
    vscode.commands.registerCommand('codescout.resetOnboarding', async () => {
      await context.secrets.delete(SECRET_FULL_AUDIT_WELCOME);
      const workspaceRoot = getWorkspaceRoot();
      if (workspaceRoot && existsSync(join(workspaceRoot, CONTEXT_FILE))) {
        const answer = await vscode.window.showWarningMessage('Удалить сохранённый контекст проекта?', { modal: true }, 'Удалить');
        if (answer === 'Удалить') unlinkSync(join(workspaceRoot, CONTEXT_FILE));
      }
      if (workspaceRoot) panel.setWelcomeBanner(true, 'new');
      void vscode.window.showInformationMessage('✅ Онбординг сброшен');
    }),
    vscode.commands.registerCommand('codescout.cancelScan', () => {
      activeAbortController?.abort();
      panel.setCancelled();
      output.appendLine('Scan cancelled by user');
    }),
    vscode.commands.registerCommand('codescout.setApiKey', async () => {
      const key = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true, prompt: 'Вставьте API-ключ провайдера — провайдер определится автоматически' });
      if (!key?.trim()) return;
      const detected = detectProvider(key);
      let selection: { provider: ProviderName; model: string } | undefined = detected ?? undefined;
      if (!selection) {
        const picked = await vscode.window.showQuickPick(['gemini', 'groq', 'openrouter', 'github', 'custom'], { placeHolder: 'Выбери провайдер' });
        if (!picked) return;
        selection = { provider: picked as ProviderName, model: defaultModel(picked) };
      }
      const validated = await validateDefaultModel(context, { provider: selection.provider, model: selection.model, key: key.trim() });
      selection = { provider: selection.provider, model: validated.model };
      await context.secrets.store(SECRET_KEY, key.trim());
      await context.secrets.store(SECRET_PROVIDER, selection.provider);
      await context.secrets.store(SECRET_MODEL, selection.model);
      await context.secrets.store(SECRET_MODEL_CHOSEN, String(validated.userChosen));
      panel.setKey(key.trim(), selection.provider, selection.model);
      const source = detected ? 'определено автоматически' : 'выбрано вручную';
      void vscode.window.showInformationMessage(`✅ Ключ сохранён. Провайдер: ${selection.provider}, модель: ${selection.model} (${source})`);
    }),
    vscode.commands.registerCommand('codescout.chooseModel', async () => {
      const current = await resolveExtensionSelection(context);
      if (!current.key) {
        void vscode.window.showErrorMessage('Сначала сохрани API-ключ через CodeScout: set API key.');
        return;
      }
      const chosen = await chooseLiveModel(current, 'Выбери доступную модель');
      await context.secrets.store(SECRET_MODEL, chosen.model);
      await context.secrets.store(SECRET_MODEL_CHOSEN, 'true');
      panel.setKey(current.key, current.provider, chosen.model);
      void runReview(context, lastScanWasLastCommit, output, panel);
    }),
    vscode.commands.registerCommand('codescout.clearApiKey', async () => {
      const answer = await vscode.window.showWarningMessage('Удалить сохранённый API-ключ CodeScout?', { modal: true }, 'Удалить');
      if (answer !== 'Удалить') return;
      await context.secrets.delete(SECRET_KEY);
      await context.secrets.delete(SECRET_PROVIDER);
      await context.secrets.delete(SECRET_MODEL);
      await context.secrets.delete(SECRET_MODEL_CHOSEN);
      panel.setKey(undefined);
      void vscode.window.showInformationMessage('Ключ удалён из защищённого хранилища');
    })
  );
  void (async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const projectContext = readProjectContext(workspaceRoot);
    const selection = await resolveExtensionSelection(context);
    const choiceStored = (await context.secrets.get(SECRET_FULL_AUDIT_WELCOME)) === 'true';
    const stale = Boolean(projectContext?.auditMeta && (projectContext.auditMeta.provider !== selection.provider || projectContext.auditMeta.model !== selection.model));
    if (!auditBannerEnabled()) return;
    if (!projectContext && !choiceStored) panel.setWelcomeBanner(true, 'new');
    else if (stale) panel.setWelcomeBanner(true, 'stale');
  })();
}

export function deactivate(): void {}
