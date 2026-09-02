import * as vscode from 'vscode';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { abortError, createProvider, isAbortError, RetryEvent, sleep } from '../../src/llm-client';
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
import { buildFindingsDiff, buildProjectSystemPrompt, clearAuditProgress, collectAuditFiles, collectFilesForScope, AUDIT_CHUNK_OVERLAP, AUDIT_PASSES_MAX, auditPassesFromSetting, AUTO_RESUME_MAX_ATTEMPTS_DEFAULT, AUTO_RESUME_MAX_MINUTES_DEFAULT, autoResumeDecision, defaultDocFetcher, dedupeIssues, DOC_FETCH_TIMEOUT_MS, fetchDocsForPrompt, importsContextLine, mergeCheckpointIssues, parseScopeGlobs, passFindingsSummary, pruneAuditCheckpoint, readAuditProgress, readFindingsHistory, readProjectContext, ReviewScope, writeAuditProgress, writeFindingsHistory, writeProjectContext, type AuditCheckpoint, type AuditResumeView, type DocsResult, progressView } from './projectAudit';
import { buildSettingsHtml, SettingsState } from './settingsHtml';
import { withReportLanguage } from '../../src/prompt-builder';

const SECRET_KEY = 'codescout.apiKey';
const SECRET_PROVIDER = 'codescout.provider';
const SECRET_MODEL = 'codescout.model';
const SECRET_MODEL_CHOSEN = 'codescout.model.userChosen';
const SECRET_FULL_AUDIT_WELCOME = 'codescout.fullAuditWelcomeShown';
const CONTEXT_FILE = '.codescout/context.json';
const KNOWN_SETTINGS_COMMANDS = new Set(['saveKeyProvider', 'saveAppearance', 'clearApiKey', 'chooseModel', 'saveDocLinks', 'openRules']);

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

function docLimitsFromKb(kb: number | undefined, fallback = 50): number {
  const rounded = Math.round(Number.isFinite(kb) && (kb as number) > 0 ? (kb as number) : fallback);
  return Math.min(2048, Math.max(1, rounded)) * 1024;
}

function docLimitsFromCount(count: number | undefined, fallback = 5): number {
  const rounded = Math.round(Number.isFinite(count) && (count as number) > 0 ? (count as number) : fallback);
  return Math.min(50, Math.max(1, rounded));
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

async function reviewFiles(context: vscode.ExtensionContext, files: Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }>, workspaceRoot: string | undefined, onRetry: (event: RetryEvent, model: string) => void, onProgress?: (index: number, total: number, filename: string, elapsedMs: number) => void, onThinking?: (elapsedMs: number) => void, signal?: AbortSignal, systemPrompt = SYSTEM_PROMPT, continueOnFileError = false, onFileSkipped?: (filename: string, error: unknown) => void, onFileChecked?: (filename: string, fileIssues: ReviewIssue[]) => void, importsResolver?: (filename: string) => string, passes = 1, onPass?: (filename: string, pass: number, totalPasses: number) => void): Promise<ScanResult> {
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
        const importsLine = importsResolver?.(file.filename) ?? '';
        for (let pass = 1; pass <= passes; pass++) {
          const passLine = pass > 1 ? passFindingsSummary(dedupeIssues(fileIssues)) : '';
          if (pass > 1) onPass?.(file.filename, pass, passes);
          for (const chunk of splitPatch(file.patch, 45_000)) {
            if (signal?.aborted) throw abortError();
            const elapsedMs = Date.now() - startedAt;
            onProgress?.(fileIndex + 1, files.length, file.filename, elapsedMs);
            onThinking?.(elapsedMs);
            const raw = await provider.review(systemPrompt, buildReviewPrompt(file, chunk, importsLine, passLine));
            const parsed = parseReviewResponse(raw, file.filename);
            fileIssues.push(...parsed.issues.map((issue) => workspaceRoot ? correctIssueLine(issue, workspaceRoot) : issue));
          }
        }
        const deduped = dedupeIssues(fileIssues);
        issues.push(...deduped);
        onFileChecked?.(file.filename, deduped);
        completed = true;
      } catch (error) {
        lastError = error;
        if (isAbortError(error)) throw error;
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
  if (signal?.aborted) throw abortError();
  return reviewFiles(context, readGitDiff(workspaceRoot, { lastCommit }), workspaceRoot, onRetry, onProgress, onThinking, signal, systemPrompt, false, undefined, undefined, (filename) => importsContextLine(workspaceRoot, filename));
}

let activeAbortController: AbortController | undefined;

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

type AuditOutcome = { kind: 'done' } | { kind: 'interrupted'; view?: AuditResumeView };

let autoResumeCancelled = false;

function autoResumeEnabled(): boolean {
  return vscode.workspace.getConfiguration('codescout').get<boolean>('autoResume', false);
}

async function runFullAudit(context: vscode.ExtensionContext, output: vscode.OutputChannel, panel: CodeScoutPanel, resume = false): Promise<void> {
  autoResumeCancelled = false;
  panel.setAutoResume(undefined);
  let isResume = resume;
  let autonomyStartedAt = Date.now();
  let lastAttempt = 0;
  for (;;) {
    const outcome = await runFullAuditOnce(context, output, panel, isResume);
    if (outcome.kind === 'done') { panel.setAutoResume(undefined); return; }
    if (!autoResumeEnabled() || autoResumeCancelled || !outcome.view) { panel.setAutoResume(undefined); return; }
    const decision = autoResumeDecision(lastAttempt + 1, autonomyStartedAt, Date.now());
    if (!decision) {
      output.appendLine(`🤖 автономный лимит исчерпан (${AUTO_RESUME_MAX_ATTEMPTS_DEFAULT} попыток / ${AUTO_RESUME_MAX_MINUTES_DEFAULT} мин) — нужен человек: кнопки «▶️ Продолжить» в баннере`);
      panel.setAutoResume(undefined);
      return;
    }
    lastAttempt = decision.attempt;
    output.appendLine(`🤖 rate-limit:_resume через ${decision.waitSeconds}с (попытка ${decision.attempt}/${AUTO_RESUME_MAX_ATTEMPTS_DEFAULT})`);
    panel.setAutoResume({ done: outcome.view.done, total: outcome.view.total, secondsLeft: decision.waitSeconds, attempt: decision.attempt, maxAttempts: AUTO_RESUME_MAX_ATTEMPTS_DEFAULT });
    const waitController = new AbortController();
    activeAbortController?.abort();
    activeAbortController = waitController;
    try {
      await sleep(decision.waitSeconds * 1000, waitController.signal);
    } catch {
      output.appendLine('🤖 авто-догон остановлен пользователем');
      panel.setAutoResume(undefined);
      return;
    } finally {
      if (activeAbortController === waitController) activeAbortController = undefined;
    }
    if (autoResumeCancelled) { panel.setAutoResume(undefined); return; }
    isResume = true;
  }
}

async function runFullAuditOnce(context: vscode.ExtensionContext, output: vscode.OutputChannel, panel: CodeScoutPanel, resume = false): Promise<AuditOutcome> {
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
    return { kind: 'done' };
  }
  output.appendLine(resume ? 'CodeScout: resuming full project audit...' : 'CodeScout: starting full project audit...');
  let progress: AuditCheckpoint | undefined;
  let planFiles: string[] = [];
  try {
    const auditConfig = vscode.workspace.getConfiguration('codescout');
    const auditMaxFiles = auditConfig.get<number>('maxFiles', 100);
    const auditMaxLines = auditConfig.get<number>('maxLines', 0);
    const auditPasses = auditPassesFromSetting(auditConfig.get<number>('auditPasses'));
    const auditSelection = await resolveExtensionSelection(context);
    const previousHistory = readFindingsHistory(workspaceRoot);
    const auditScopeText = auditConfig.get<string>('auditScope') ?? '';
    const audit = collectAuditFiles(workspaceRoot, auditMaxFiles, auditMaxLines, auditScopeText, (message) => output.appendLine(message));
    planFiles = [...new Set(audit.files.map((file) => file.filename))];
    output.appendLine(`🔬 Полный аудит: найдено ${planFiles.length} файлов.`);
    const scopeGlobs = parseScopeGlobs(auditScopeText);
    if (scopeGlobs.length) output.appendLine(`🎯 Scope аудита: ${scopeGlobs.join(', ')} — подходит ${planFiles.length} файлов (codescout.auditScope)`);
    output.appendLine(`Игнорируется: ${audit.ignored.length} файлов (.gitignore + .codescout/ignore)`);
    if (audit.skippedLimit > 0) output.appendLine(`⚠️ Пропущено ${audit.skippedLimit} файлов по лимиту (codescout.maxFiles=${auditMaxFiles})`);
    for (const filename of audit.skippedLarge) output.appendLine(`⚠️ Пропущен большой файл (>${auditMaxLines} строк, codescout.maxLines): ${filename}`);
    for (const filename of audit.skippedUnreadable) output.appendLine(`⚠️ Пропущен нечитаемый файл: ${filename}`);
    for (const entry of audit.chunked) output.appendLine(`📄 файл ${entry.file}: ${entry.chunks} чанков (перекрытие ${AUDIT_CHUNK_OVERLAP} строк)`);
    const docMaxBytes = docLimitsFromKb(auditConfig.get<number>('docMaxKb'));
    const docMaxLinks = docLimitsFromCount(auditConfig.get<number>('docMaxLinks'));
    const docLinks = auditConfig.get<string[]>('docLinks') ?? [];
    let docs: DocsResult = { section: '', fetched: 0, fromCache: 0, failed: 0 };
    if (docLinks.some((link) => link.trim())) {
      try {
        docs = await fetchDocsForPrompt(workspaceRoot, docLinks, defaultDocFetcher, (message) => output.appendLine(message), { maxBytes: docMaxBytes, maxLinks: docMaxLinks, timeoutMs: DOC_FETCH_TIMEOUT_MS });
      } catch (error) {
        docs = { section: '', fetched: 0, fromCache: 0, failed: 0 };
        output.appendLine(`⚠️ Docs fetch не выполнен: ${error instanceof Error ? error.message : String(error)} — аудит продолжается без текстов документации`);
      }
      const used = docs.fetched + docs.fromCache;
      if (used > 0) output.appendLine(`🔗 Документация проекта: ${used} док(ов) в промте (свежих: ${docs.fetched}, из кэша: ${docs.fromCache})`);
      else output.appendLine('🔗 Документация проекта: ни один док не подтянулся — в промте только ссылки');
    }
    const projectPrompt = buildProjectSystemPrompt(SYSTEM_PROMPT, workspaceRoot, docLinks, docs.section);
    if (projectPrompt.rulesLoaded) output.appendLine('📚 Загружены правила проекта');
    else output.appendLine('ℹ️ Правил нет — дефолт');
    let initial: AuditCheckpoint = { startedAt: Date.now(), model: auditSelection.model, checked: [], remaining: planFiles };
    if (resume) {
      const saved = readAuditProgress(workspaceRoot);
      if (!saved) output.appendLine('ℹ️ Прогресса не найдено — запускаю с нуля');
      else if (saved.model !== auditSelection.model) {
        output.appendLine(`ℹ️ Модель сменилась (${saved.model} → ${auditSelection.model}) — чекпоинт не подходит, начинаю заново`);
        clearAuditProgress(workspaceRoot);
      } else {
        initial = pruneAuditCheckpoint(saved, planFiles);
        output.appendLine(`▶️ Продолжаю аудит: проверено ${initial.checked.length} файлов, осталось ${planFiles.length - initial.checked.length}`);
      }
    } else {
      clearAuditProgress(workspaceRoot);
    }
    progress = initial;
    const state = initial;
    const doneNames = new Set(state.checked.map((entry) => entry.file));
    const toReview = audit.files.filter((file) => !doneNames.has(file.filename));
    const chunkTotals = new Map<string, number>();
    for (const file of audit.files) chunkTotals.set(file.filename, (chunkTotals.get(file.filename) ?? 0) + 1);
    const chunkProgress = new Map<string, { done: number; issues: ReviewIssue[] }>();
    const loggedStart = new Set<string>();
    const fileStartedAt = new Map<string, number>();
    if (auditPasses > 1) output.appendLine(`🔁 Мульти-пасс аудит: ${auditPasses} круга на файл (codescout.auditPasses)`);
    const persist = (): void => {
      state.remaining = planFiles.filter((file) => !doneNames.has(file));
      writeAuditProgress(workspaceRoot, state);
    };
    persist();
    const result = await reviewFiles(context, toReview, workspaceRoot, (event, model) => panel.setRetry(event, model), (index, total, filename, elapsedMs) => { panel.setProgress(index, total, filename, '🔎 Полный аудит: файл', elapsedMs); if (!loggedStart.has(filename)) { loggedStart.add(filename); fileStartedAt.set(filename, Date.now()); output.appendLine(`🔎 файл ${index}/${total}: ${filename} — старт…`); } }, (elapsedMs) => panel.setModelThinking(elapsedMs), controller.signal, withReportLanguage(projectPrompt.prompt, currentReportLanguage()), true, (filename) => output.appendLine(`⚠️ Пропущен файл: ${filename}`), (filename, fileIssues) => {
      const acc = chunkProgress.get(filename) ?? { done: 0, issues: [] as ReviewIssue[] };
      acc.done += 1;
      acc.issues.push(...fileIssues);
      chunkProgress.set(filename, acc);
      if (acc.done >= (chunkTotals.get(filename) ?? 1)) {
        doneNames.add(filename);
        state.checked.push({ file: filename, issues: dedupeIssues(acc.issues) });
        persist();
        const seconds = Math.max(0, Math.round(((Date.now() - (fileStartedAt.get(filename) ?? Date.now())) / 1000) * 10) / 10);
        output.appendLine(`✅ файл ${doneNames.size}/${planFiles.length}: ${filename} — готово за ${seconds}с`);
      }
    }, (filename) => importsContextLine(workspaceRoot, filename), auditPasses, (filename, pass, totalPasses) => output.appendLine(`🔄 круг ${pass}/${totalPasses}: файл ${filename}`));
    const mergedIssues = dedupeIssues(mergeCheckpointIssues(state));
    const filesAnalyzed = state.checked.length;
    const auditMeta = { provider: auditSelection.provider, model: auditSelection.model, timestamp: Date.now() };
    writeProjectContext(workspaceRoot, filesAnalyzed, mergedIssues, auditMeta);
    writeFindingsHistory(workspaceRoot, mergedIssues, 'full-audit', auditMeta);
    if (result.skippedFiles > 0) {
      persist();
      output.appendLine(`ℹ️ Скипнуто ${result.skippedFiles} файлов (rate-limit/ошибки) — чекпоинт сохранён, можно догнать кнопкой «▶️ Продолжить»`);
    } else {
      clearAuditProgress(workspaceRoot);
    }
    const findingsDiff = buildFindingsDiff(previousHistory, mergedIssues);
    panel.update(mergedIssues, buildStats(mergedIssues, filesAnalyzed, result.durationMs), false, '', false, findingsDiff);
    const resumeView = result.skippedFiles > 0 ? progressView(state) : undefined;
    if (resumeView) panel.setAuditResume(resumeView);
    await vscode.commands.executeCommand('codescout.panel.focus');
    output.appendLine(`Контекст проекта сохранён: .codescout/context.json (${mergedIssues.length} findings)`);
    output.appendLine(findingsDiff ? `Динамика относительно прошлого аудита: ${findingsDiff.summary}` : 'ℹ️ Первый аудит — сравнение недоступно, история заведена');
    output.appendLine(`Аудит завершён: проверено ${filesAnalyzed}, пропущено ${audit.skippedLarge.length + audit.skippedUnreadable.length + result.skippedFiles + audit.ignored.length + audit.skippedLimit}`);
    dumpFindings(output, mergedIssues, `Итог аудита: ${mergedIssues.length} находок, проверено файлов: ${filesAnalyzed}`);
    return resumeView ? { kind: 'interrupted', view: resumeView } : { kind: 'done' };
  } catch (error) {
    const resumeView = progress && progress.checked.length > 0 ? progressView(progress) : undefined;
    if (resumeView) panel.setAuditResume(resumeView);
    if (isAbortError(error)) { panel.setCancelled(); return { kind: 'done' }; }
    const message = error instanceof Error ? error.message : String(error);
    panel.setError(message);
    output.appendLine(`Error: ${message}`);
    void vscode.window.showErrorMessage(`CodeScout: ${message}`);
    return { kind: 'interrupted', view: resumeView };
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
    const reviewConfig = vscode.workspace.getConfiguration('codescout');
    const maxFiles = reviewConfig.get<number>('maxFiles', 100);
    const maxLines = reviewConfig.get<number>('maxLines', 0);
    const collection = collectFilesForScope(workspaceRoot, scope as ReviewScope, globs, vscode.window.activeTextEditor?.document.fsPath, maxFiles, maxLines, (message) => output.appendLine(message));
    for (const entry of collection.chunked) output.appendLine(`📄 файл ${entry.file}: ${entry.chunks} чанков (перекрытие ${AUDIT_CHUNK_OVERLAP} строк)`);
    if (collection.files.length === 0) {
      panel.setError(scope === 'list' ? `По глобам "${globs.join(', ')}" не подошло ни одного файла (проверь игнор-листы).` : 'Нет доступных файлов для ревью.');
      output.appendLine('Своё ревью не запущено: файлов для проверки не найдено.');
      return;
    }
    if (collection.skippedLimit > 0) output.appendLine(`⚠️ Пропущено ${collection.skippedLimit} файлов по лимиту (codescout.maxFiles=${maxFiles})`);
    const projectPrompt = buildProjectSystemPrompt(SYSTEM_PROMPT, workspaceRoot);
    const prompt = withReportLanguage(withFocusInstructions(projectPrompt.prompt, focus), currentReportLanguage());
    const result = await reviewFiles(context, collection.files, workspaceRoot, (event, model) => panel.setRetry(event, model), (index, total, filename, elapsedMs) => { panel.setProgress(index, total, filename, '🎯 Своё ревью: файл', elapsedMs); output.appendLine(`🎯 Своё ревью: файл ${index}/${total}: ${filename} · ⏱ ${Math.floor(elapsedMs / 1000)}с`); }, (elapsedMs) => panel.setModelThinking(elapsedMs), controller.signal, prompt, false, (filename) => output.appendLine(`⚠️ Пропущен файл: ${filename}`), undefined, (filename) => importsContextLine(workspaceRoot, filename));
    panel.update(dedupeIssues(result.issues), buildStats(result.issues, result.filesAnalyzed, result.durationMs), false, '', false, undefined, focus);
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

async function runSelectionReview(context: vscode.ExtensionContext, output: vscode.OutputChannel, panel: CodeScoutPanel, uri?: vscode.Uri): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage('Открой папку workspace, чтобы проверить файл/папку.');
    return;
  }
  if (!uri) {
    void vscode.window.showErrorMessage('CodeScout: проверять можно через контекстное меню проводника (ПКМ по файлу или папке).');
    return;
  }
  const target = uri.fsPath;
  let isDirectory = false;
  try {
    isDirectory = statSync(target).isDirectory();
  } catch {
    void vscode.window.showErrorMessage(`CodeScout: не удалось прочитать выбранный путь: ${target}`);
    return;
  }
  const rel = relative(workspaceRoot, resolve(target)).replaceAll('\\', '/');
  if (!rel || rel.startsWith('..')) {
    void vscode.window.showErrorMessage('CodeScout: выбранный путь вне workspace — проверяю только файлы проекта.');
    return;
  }
  const globs = isDirectory ? `${rel}/**` : rel;
  // разовая проверка выбора: codescout.auditScope здесь сознательно игнорируется
  await runCustomReview(context, output, panel, `Проверка выбора в проводнике: ${rel}`, 'list', globs);
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
  linksText?: string;
  docMaxKb?: number;
  docMaxLinks?: number;
  maxLines?: number;
  autoResume?: boolean;
  auditScope?: string;
  auditPasses?: number;
}

const RULES_TEMPLATE = '# Правила проекта CodeScout\n\nМодель подмешивает этот файл в каждый промт ревью.\n\n## Примеры\n- Не флагать tenant-scoped чтения через Prisma.\n- Все внешние HTTP-вызовы — с таймаутом и ретраями.\n- Миграции БД — только через папку prisma/migrations.\n';

async function openOrCreateRules(workspaceRoot: string | undefined): Promise<string> {
  if (!workspaceRoot) throw new Error('Открой папку workspace в VS Code');
  const directory = join(workspaceRoot, '.codescout');
  const rulesPath = join(directory, 'rules.md');
  if (!existsSync(rulesPath)) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(rulesPath, RULES_TEMPLATE, 'utf8');
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(rulesPath));
  await vscode.window.showTextDocument(document, { preview: false });
  return rulesPath;
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
    showAuditBanner: auditBannerEnabled(),
    docLinks: vscode.workspace.getConfiguration('codescout').get<string[]>('docLinks') ?? [],
    docMaxKb: docLimitsFromKb(vscode.workspace.getConfiguration('codescout').get<number>('docMaxKb')) / 1024,
    docMaxLinks: docLimitsFromCount(vscode.workspace.getConfiguration('codescout').get<number>('docMaxLinks')),
    maxLines: Math.max(0, Math.round(vscode.workspace.getConfiguration('codescout').get<number>('maxLines', 0) || 0)),
    autoResume: vscode.workspace.getConfiguration('codescout').get<boolean>('autoResume', false),
    auditScope: vscode.workspace.getConfiguration('codescout').get<string>('auditScope') ?? '',
    auditPasses: auditPassesFromSetting(vscode.workspace.getConfiguration('codescout').get<number>('auditPasses'))
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
    vscode.commands.registerCommand('codescout.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'codescout')),
    vscode.commands.registerCommand('codescout.openSettingsPage', async () => {
      const render = async (status = '', statusKind: 'ok' | 'error' = 'ok'): Promise<void> => {
        if (settingsPanel) settingsPanel.webview.html = buildSettingsHtml(await readSettingsState(context), status, statusKind, randomBytes(16).toString('hex'));
      };
      if (!settingsPanel) {
        settingsPanel = vscode.window.createWebviewPanel('codescout.settings', 'CodeScout: Настройки', vscode.ViewColumn.One, { enableScripts: true });
        settingsPanel.onDidDispose(() => { settingsPanel = undefined; });
        settingsPanel.webview.onDidReceiveMessage((message: SettingsMessage) => {
          if (!KNOWN_SETTINGS_COMMANDS.has(message.command)) return;
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
          } else if (message.command === 'saveDocLinks') {
            const links = (message.linksText ?? '').split(/\r?\n/).map((link) => link.trim()).filter(Boolean);
            const maxKb = docLimitsFromKb(message.docMaxKb) / 1024;
            const maxLinks = docLimitsFromCount(message.docMaxLinks);
            const maxLinesRaw = Math.round(Number(message.maxLines));
            const maxLines = Number.isFinite(maxLinesRaw) && maxLinesRaw > 0 ? Math.min(100000, maxLinesRaw) : 0;
            const autoResume = message.autoResume === true;
            const auditScope = (message.auditScope ?? '').trim();
            const auditPasses = auditPassesFromSetting(message.auditPasses);
            const config = vscode.workspace.getConfiguration('codescout');
            await config.update('docLinks', links, vscode.ConfigurationTarget.Global);
            await config.update('docMaxKb', maxKb, vscode.ConfigurationTarget.Global);
            await config.update('docMaxLinks', maxLinks, vscode.ConfigurationTarget.Global);
            await config.update('maxLines', maxLines, vscode.ConfigurationTarget.Global);
            await config.update('autoResume', autoResume, vscode.ConfigurationTarget.Global);
            await config.update('auditScope', auditScope, vscode.ConfigurationTarget.Global);
            await config.update('auditPasses', auditPasses, vscode.ConfigurationTarget.Global);
            await render(`✅ Сохранено · Документация: ${links.length} ссылок, док ≤ ${maxKb}KB, ссылок в аудит ≤ ${maxLinks} · maxLines: ${maxLines === 0 ? 'без лимита (чанки по 800)' : `${maxLines} строк`} · кругов: ${auditPasses} · автономный режим ${autoResume ? 'включён' : 'выключен'} · scope: ${auditScope || 'все файлы'}`);
          } else if (message.command === 'openRules') {
            try {
              await openOrCreateRules(getWorkspaceRoot());
              await render('✅ Открыт .codescout/rules.md — правки подхватываются следующим ревью');
            } catch (error) {
              await render(`❌ Ошибка: ${error instanceof Error ? error.message : String(error)}`, 'error');
            }
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
    vscode.commands.registerCommand('codescout.resumeAudit', () => runFullAudit(context, output, panel, true)),
    vscode.commands.registerCommand('codescout.restartAudit', () => {
      const root = getWorkspaceRoot();
      if (root) clearAuditProgress(root);
      return runFullAudit(context, output, panel);
    }),
    vscode.commands.registerCommand('codescout.customReview', (focus?: string, scope?: string, globs?: string) => runCustomReview(context, output, panel, focus, scope, globs)),
    vscode.commands.registerCommand('codescout.reviewSelection', (uri?: vscode.Uri) => runSelectionReview(context, output, panel, uri)),
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
      autoResumeCancelled = true;
      panel.setAutoResume(undefined);
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
      void runReview(context, lastScanWasLastCommit, output, panel).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`Error: ${message}`);
        void vscode.window.showErrorMessage(`CodeScout: ${message}`);
      });
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
    const savedProgress = progressView(readAuditProgress(workspaceRoot));
    if (savedProgress) panel.setAuditResume(savedProgress);
    if (!auditBannerEnabled()) return;
    if (!projectContext && !choiceStored) panel.setWelcomeBanner(true, 'new');
    else if (stale) panel.setWelcomeBanner(true, 'stale');
  })().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Init error: ${message}`);
    void vscode.window.showErrorMessage(`CodeScout: ${message}`);
  });
}

export function deactivate(): void {}
