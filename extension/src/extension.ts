import * as vscode from 'vscode';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { abortError, AllProfilesAsleepError, BadResponseError, createProvider, isAbortError, ProviderHttpError, RateLimitError, requestTimeoutSecondsFromSetting, RetryEvent, setDefaultRequestTimeoutMs, sleep, type FailoverHooks, type FailoverSwitchDecision } from '../../src/llm-client';
import { formatError } from '../../src/error-classifier';
import { buildReviewPrompt, SYSTEM_PROMPT, withFocusInstructions } from '../../src/prompt-builder';
import { confidencePercent, parseReviewResponse } from '../../src/response-parser';
import { correctIssueLine } from '../../src/line-correction';
import { splitPatch } from '../../src/diff-parser';
import { clearModelsCache, defaultModel, detectProvider, fetchLiveModelsCached, isLocalBaseUrl, keyUrl, maskApiKey, MODELS_FETCH_TIMEOUT_MS, normalizeProvider, probeLocalServer, PROVIDER_ORDER, ProviderName, resolveApiKeyPriority, resolveBaseUrl, sanitizeApiKey, SK_AMBIGUOUS_OPTIONS } from '../../src/providers';
import { readGitDiff } from '../../src/tui/DiffReader';
import { ReviewIssue } from '../../src/types';
import { CodeScoutPanel } from './panel';
import { filterSuppressed } from './findingsStore';
import { ReportStats } from './reportHtml';
import { SAMPLE_FILE, sampleTestSummary } from './sampleReview';
import { buildFindingsDiff, buildProjectSystemPrompt, checkpointHasFileHashes, clearAuditProgress, clearAuditResults, collectAuditFiles, collectCheckpointFindings, collectFilesForScope, AUDIT_CHUNK_OVERLAP, AUDIT_PASSES_MAX, auditPassesFromSetting, auditEtaSeconds, autoResumeBadgeDetail, autoResumeDecision, autoResumeLimitFromSetting, AUTO_RESUME_LADDER_SECONDS, AuditCircuitBreakerError, chunkLineCount, chunkLinesFromSetting, defaultDocFetcher, dedupeIssues, docBudgetBytesFromSetting, DOC_FETCH_TIMEOUT_MS, estimateRequestTokens, fetchDocsForPrompt, formatSkipReason, hashAuditFile, importsContextLine, ladderRemainingSeconds, lastCheckpointTag, makeDocsResolver, maxRequestKTokensFromSetting, parseScopeGlobs, passFindingsSummary, pruneAuditCheckpoint, QUARANTINE_CYCLES_PER_ROUND, QUARANTINE_MAX_ROUNDS, readAuditProgress, readAuditResults, readFindingsHistory, readProjectContext, reconcileCheckedHashes, ReviewScope, skipBreakerFeed, skipBreakerLimitFromSetting, skipBreakerReset, skipReasonLine, splitAuditChunk, upsertSkippedFile, writeAuditProgress, writeAuditResults, writeAuditResultsFromCheckpoint, writeFindingsHistory, writeProjectContext, auditResultsPath, type AuditCheckpoint, type AuditResumeView, type DocsResult, type SkipBreakerState, progressView } from './projectAudit';
import { checkpointScopeVerdict, computeScopeHash, getGitHead, pickResumeTarget, pickResumeProfile } from './auditResume';
import { activeProfile, addKey, addProfile, beginScan, clearKeyBroken, DEFAULT_KEY_ID, deleteProfileSecret, failoverEnabled, failoverMaxCycles, grantWaitOnce, keyLabelFor, markKeyBroken, markKeyHealthy, migrateLegacyKeyToDefault, migrateProfilesToMultiKey, moveProfile, pickActiveKey, profileBaseUrl, readActiveId, readKeySecret, readProfileSecret, readProfiles, removeKey, removeProfile, renameKey, renameProfile, resetRuntime, runtimeSnapshot, runFailover, scanCurrent, secretKeyForProfile, setKeyEnabled, setProfileBaseUrl, storeProfileSecret, updateProfileFromForm, upsertOnboardedProfile, writeActiveId, writeProfiles, profileLabel, type KeychainProfile } from './keychain';
import { buildSettingsHtml, SettingsState } from './settingsHtml';
import { normalizeUiPrefs, type UiPrefs } from './uiPrefs';
import { withReportLanguage } from '../../src/prompt-builder';
import { t } from '../../src/i18n';
import { buildIssueBody, isContactUrlAllowed, redactSecrets, reportIssueUrl } from './reportIssue';
import { platform, release } from 'node:os';

const SECRET_KEY = 'codescout.apiKey';
const SECRET_PROVIDER = 'codescout.provider';
const SECRET_MODEL = 'codescout.model';
const SECRET_MODEL_CHOSEN = 'codescout.model.userChosen';
const SECRET_FULL_AUDIT_WELCOME = 'codescout.fullAuditWelcomeShown';
const CONTEXT_FILE = '.codescout/context.json';
// Батч 21: метки мастера onboardCloud → провайдеры. Метки — собственные
// имена платформ (не переводятся, i18n-вайтлист тех-терминов).
const WIZARD_PROVIDER_LABELS: Record<string, ProviderName> = {
  'Custom (свой адрес)': 'custom',
  'OpenAI': 'openai',
  'Anthropic': 'anthropic',
  'OpenCode Go': 'opencode',
  'Gemini': 'gemini',
  'Groq': 'groq',
  'OpenRouter': 'openrouter',
  'DeepSeek': 'deepseek',
  'Together AI': 'together',
  'SambaNova': 'sambanova',
  'SiliconFlow': 'siliconflow',
  'NVIDIA': 'nvidia',
  'Hyperbolic': 'hyperbolic',
  'Cerebras': 'cerebras'
};
export const KNOWN_SETTINGS_COMMANDS = new Set(['saveKeyProvider', 'saveAppearance', 'saveAll', 'clearApiKey', 'chooseModel', 'testConnection', 'saveDocLinks', 'openRules', 'openLink', 'pickScope', 'reportIssue', 'refreshContext', 'keychainAdd', 'keychainRename', 'keychainDelete', 'keychainSetActive', 'keychainBaseUrl', 'keychainMove', 'keychainAddKey', 'keychainRenameKey', 'keychainDeleteKey', 'keychainToggleKey', 'keychainFormSave', 'keychainFormModels']);

// Батч 20a, п.2: sink предупреждений списка моделей — core (providers.ts)
// про vscode не знает, расширение подставляет свой Output-канал (заполняется
// в activate). До активации предупреждение уходит в console.warn.
let hostOutput: vscode.OutputChannel | undefined;

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
  // Батч 27: id активного профиля keychain (undefined = legacy-одиночный ключ).
  profileId?: string;
  // Батч 28: рабочий ключ активного профиля (id + label для меток чекпоинта).
  keyId?: string;
  keyLabel?: string;
  // Батч 27.1, п.1: override эндпоинта активного профиля (priority в
  // providers.resolveBaseUrl: profile.baseUrl → baseUrl → PROVIDERS).
  profileBaseUrl?: string;
}

function formatIssue(issue: ReviewIssue): string {
  const severity = issue.severity.toUpperCase();
  const location = `${issue.file}:${issue.line}`;
  const code = issue.code ? `\n  code: ${issue.code}` : '';
  const suggestion = issue.suggestion ? `\n  suggestion: ${issue.suggestion}` : '';
  return `[${severity}] ${issue.category} · ${location} · confidence ${confidencePercent(issue.confidence, 0)}%\n  ${issue.description}${code}${suggestion}`;
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

// Батч 22, п.1: на время живого GET /models центр настроек показывает в
// селект-зоне «Загружаем модели…» и блокирует управление (modelsBusy).
function notifyModelsBusy(busy: boolean): void {
  if (!settingsPanel) return;
  void settingsPanel.webview.postMessage({ type: 'modelsBusy', busy, label: t('models.loading', currentReportLanguage()) });
}

async function fetchModels(selection: ProviderSelection, tolerateErrors = true): Promise<string[]> {
  const baseUrl = resolveBaseUrl(selection.provider, selection.baseUrl, selection.profileBaseUrl);
  // Локальный режим (батч 13, п.2): Ollama/LM Studio на localhost работают без ключа.
  if (!selection.key && !isLocalBaseUrl(baseUrl)) return [];
  // Батч 20a, п.2: provider передаётся явно — внутри fetchLiveModels для
  // gemini работает умный мок: живая попытка GET /models (AbortController,
  // 10000ms — батч 22) при любом провале отдаёт GEMINI_STATIC_MODELS; onWarn
  // пишет предупреждение в Output-канал расширения.
  // Батч 21, п.3: tolerateErrors=true (выбор моделей) — 401/404/таймаут/
  // редирект дают пустой список, а не падение UI. Тест подключения и мастер
  // зовут с false: там ошибка — сигнал пользователю.
  // Батч 22: таймаут 10с, sanitizeApiKey в одной точке, Accept: json,
  // кэш списков (TTL 10 мин, только путь выбора), в Output — длительность
  // fetch и размер ответа в байтах (без ключа!).
  notifyModelsBusy(true);
  try {
    return await fetchLiveModelsCached(baseUrl, sanitizeApiKey(selection.key ?? ''), fetch, MODELS_FETCH_TIMEOUT_MS, selection.provider, (message) => (hostOutput ? hostOutput.appendLine(message) : console.warn(message)), tolerateErrors, (message) => hostOutput?.appendLine(message));
  } finally {
    notifyModelsBusy(false);
  }
}

// Батч 21, п.2: голое `sk-` — неоднозначный префикс (OpenAI, DeepSeek,
// Together, SambaNova, SiliconFlow, Hyperbolic, Cerebras выдают ключи
// одинаково). Молча писать openai нельзя — спрашиваем через QuickPick.
// Отмена = undefined (возврат без действия, P0 Astra-3 контракт).
async function pickSkProvider(): Promise<{ provider: ProviderName; model: string } | undefined> {
  const picked = await vscode.window.showQuickPick(
    SK_AMBIGUOUS_OPTIONS.map((option) => ({
      label: option.label,
      description: option.provider === 'custom' ? '' : resolveBaseUrl(option.provider)
    })),
    { placeHolder: t('key.pickSkProvider', currentReportLanguage()), ignoreFocusOut: true, matchOnDescription: true }
  );
  if (!picked) return undefined;
  const chosen = SK_AMBIGUOUS_OPTIONS.find((option) => option.label === picked.label);
  if (!chosen) return undefined;
  return { provider: chosen.provider, model: defaultModel(chosen.provider) };
}

// Возвращает undefined, если пользователь отменил выбор: отмена = возврат
// без действия, модель не меняется (P0 Astra-3).
async function chooseLiveModel(selection: ProviderSelection, placeHolder: string): Promise<{ model: string; userChosen: boolean } | undefined> {
  let models: string[] = [];
  try {
    models = await fetchModels(selection);
  } catch {
    const manual = await vscode.window.showInputBox({ prompt: t('model.inputFetchFailed', currentReportLanguage()), value: selection.model });
    if (manual === undefined) return undefined;
    return { model: manual.trim() || selection.model, userChosen: Boolean(manual.trim()) };
  }
  if (models.length === 0) {
    const manual = await vscode.window.showInputBox({ prompt: t('model.inputEmpty', currentReportLanguage()), value: selection.model });
    if (manual === undefined) return undefined;
    return { model: manual.trim() || selection.model, userChosen: Boolean(manual.trim()) };
  }
  const preferred = preferredLiveModel(models, selection.model);
  const picked = await vscode.window.showQuickPick([preferred, ...models.filter((model) => model !== preferred)], { placeHolder, matchOnDescription: true });
  if (!picked) return undefined;
  return { model: picked, userChosen: true };
}

async function validateDefaultModel(context: vscode.ExtensionContext, selection: ProviderSelection, persistCorrection = false): Promise<{ model: string; userChosen: boolean }> {
  try {
    const models = await fetchModels(selection);
    if (models.includes(selection.model)) return { model: selection.model, userChosen: false };
    if (persistCorrection) {
      const corrected = preferredLiveModel(models, selection.model);
      if (!corrected) return { model: selection.model, userChosen: false };
      // Батч 27: коррекция модели идёт туда, где живёт модель стека —
      // в профиль keychain или в legacy-секреты.
      await persistModelSelection(context, selection, corrected, false);
      return { model: corrected, userChosen: false };
    }
    return (await chooseLiveModel(selection, t('model.pickTitle', currentReportLanguage()))) ?? { model: selection.model, userChosen: false };
  } catch {
    return { model: selection.model, userChosen: false };
  }
}

const TRUSTED_BASE_URLS_KEY = 'codescout.trustedBaseUrls';

function readBaseUrlInfo(config: vscode.WorkspaceConfiguration): { baseUrl: string; fromWorkspace: boolean } {
  const envBaseUrl = process.env.CODESCOUT_BASE_URL?.trim() || '';
  const inspected = config.inspect<string>('baseUrl');
  const workspaceValue = typeof inspected?.workspaceValue === 'string' ? inspected.workspaceValue.trim() : '';
  const effective = config.get<string>('baseUrl')?.trim() || '';
  const fromWorkspace = Boolean(workspaceValue && effective === workspaceValue);
  return { baseUrl: effective || envBaseUrl, fromWorkspace };
}

async function confirmWorkspaceBaseUrl(context: vscode.ExtensionContext, baseUrl: string): Promise<boolean> {
  const trusted = (await context.globalState.get<string[]>(TRUSTED_BASE_URLS_KEY)) ?? [];
  if (trusted.includes(baseUrl)) return true;
  const lang = currentReportLanguage();
  const answer = await vscode.window.showWarningMessage(
    t('trust.prompt', lang, { url: baseUrl }),
    { modal: true },
    t('trust.accept', lang),
    t('trust.reject', lang)
  );
  if (answer === t('trust.accept', lang)) {
    await context.globalState.update(TRUSTED_BASE_URLS_KEY, [...trusted, baseUrl]);
    return true;
  }
  return false;
}

// P0 Astra-1: ключ не должен улетать на origin, который пользователь не подтвердил.
// Если baseUrl пришёл из workspace settings (а не user settings / SecretStorage /
// явного выбора), требуем подтверждения; в untrusted workspace — отказ.
async function resolveTrustedBaseUrl(context: vscode.ExtensionContext, config: vscode.WorkspaceConfiguration): Promise<string> {
  const { baseUrl, fromWorkspace } = readBaseUrlInfo(config);
  if (!baseUrl) return '';
  if (!fromWorkspace) return baseUrl;
  if (!vscode.workspace.isTrusted) throw new Error(t('trust.errUntrusted', currentReportLanguage()));
  if (!(await confirmWorkspaceBaseUrl(context, baseUrl))) throw new Error(t('trust.errNotConfirmed', currentReportLanguage()));
  return baseUrl;
}

// Батч 27: одношаговое перекрытие стека для «Продолжить другими…» — догон
// идёт профилем из пикера, НЕ трогая активный профиль настроек. Снимается
// finally-блоком догона (разовый маршрут, а не смена состояния).
let oneShotSelectionOverride: ProviderSelection | undefined;

async function resolveExtensionSelection(context: vscode.ExtensionContext): Promise<ProviderSelection> {
  const config = vscode.workspace.getConfiguration('codescout');
  const secretKey = await context.secrets.get(SECRET_KEY);
  const secretProvider = await context.secrets.get(SECRET_PROVIDER);
  const secretModel = await context.secrets.get(SECRET_MODEL);
  const userChosenModel = (await context.secrets.get(SECRET_MODEL_CHOSEN)) === 'true';
  const settingsProvider = config.get<string>('provider')?.trim();
  // HOTFIX: манифестный дефолт codescout.model ('gemini-1.5-flash') не должен
  // просачиваться в провайдеры, где он не имеет смысла (custom/ollama/opencode).
  // Учитываем только явно заданное пользователем значение (global/workspace).
  const inspectedModel = config.inspect<string>('model');
  const settingsModel = (inspectedModel?.globalValue ?? inspectedModel?.workspaceValue ?? '').trim();
  const provider = (secretProvider?.trim() || settingsProvider || 'gemini') as ProviderName;
  const model = userChosenModel ? (secretModel?.trim() || settingsModel || defaultModel(provider)) : (settingsModel || secretModel?.trim() || defaultModel(provider));
  // Батч 17: STRICT SecretStorage — никакого фоллбэка на codescout.apiKey из
  // plaintext settings.json. Приоритет: SecretStorage > env (CODESCOUT_API_KEY
  // и т.п.). Старые значения из config уносятся миграцией migrateApiKeyFromSettings.
  const key = resolveApiKeyPriority(secretKey, provider);
  const baseUrl = await resolveTrustedBaseUrl(context, config);
  const legacy: ProviderSelection = {
    provider,
    model,
    key,
    baseUrl,
    userChosenModel
  };
  // Батч 27: keychain важнее одиночных секретов — если есть профили, активный
  // профиль даёт провайдера/модель/ключ (keychain.<id>). Профиля-секрета нет →
  // ключ undefined: молчаливого фолбэка на чужой ключ нет (401-путь честный).
  // Разовый оверрайд догона («Продолжить другими…») приоритетнее профиля —
  // это выбор пользователя для ЭТОГО прогона, он не меняет состояние keychain.
  if (oneShotSelectionOverride) return { ...oneShotSelectionOverride, baseUrl: oneShotSelectionOverride.baseUrl || baseUrl };
  const profiles = readProfiles();
  const active = activeProfile(profiles);
  if (active) {
    // Батч 28: профиль даёт ПЕРВЫЙ enabled-ключ (предпочтительно не broken);
    // секрет — keychain.<profileId>.<keyId>. Молчаливого фолбэка на чужой
    // ключ нет: ключа у рабочего ключа нет → undefined (401-путь честный).
    const keyRef = pickActiveKey(active);
    const profileKey = keyRef ? await readKeySecret(context.secrets, active, keyRef) : undefined;
    const profileModel = active.model?.trim() || settingsModel || defaultModel(active.provider);
    return {
      provider: active.provider,
      model: profileModel,
      key: resolveApiKeyPriority(profileKey, active.provider),
      baseUrl,
      userChosenModel: Boolean(active.model?.trim()),
      profileId: active.id,
      keyId: keyRef?.id,
      keyLabel: keyRef?.label,
      profileBaseUrl: active.baseUrl
    };
  }
  return legacy;
}

// Батч 27: модель хранится там, где жил ключ стека: для профиля keychain —
// в самом профиле (список в settings), для legacy — SecretStorage + флаг
// «выбрано вручную».
async function persistModelSelection(context: vscode.ExtensionContext, selection: ProviderSelection, model: string, userChosen: boolean): Promise<void> {
  if (selection.profileId) {
    await writeProfiles(readProfiles().map((profile) => (profile.id === selection.profileId ? { ...profile, model } : profile)));
    return;
  }
  await context.secrets.store(SECRET_MODEL, model);
  await context.secrets.store(SECRET_MODEL_CHOSEN, userChosen ? 'true' : 'false');
}

function keychainLog(message: string): void {
  if (hostOutput) hostOutput.appendLine(message);
}

// Батч 27: тонкий адаптер keychain → llm-client. Возвращает undefined, если
// failover неактуален: нет профилей, failover.enabled=false (then поведение
// НЕ меняется вообще). Хук вызывает retry-слой на 429; на 401/403 КЛЮЧ
// помечается broken с подсказкой — автопереход по auth запрещён.
// Батч 28: единица ротации — ключ (профиль+ключ), циклы считают по профилям.
async function buildFailoverHooks(context: vscode.ExtensionContext, selection: ProviderSelection): Promise<FailoverHooks | undefined> {
  if (oneShotSelectionOverride) return undefined;
  const profiles = readProfiles();
  if (profiles.length === 0) return undefined;
  if (!failoverEnabled()) return undefined;
  const lang = currentReportLanguage();
  const options = () => ({ autonomous: autoResumeEnabled(), maxCycles: failoverMaxCycles() });
  const switchTo = async (profile: KeychainProfile, key: { id: string; label: string; secretId: string; enabled: boolean }): Promise<FailoverSwitchDecision | undefined> => {
    const keySecret = await readKeySecret(context.secrets, profile, key);
    if (!keySecret) return undefined;
    return { action: 'switch', apiKey: keySecret, baseUrl: resolveBaseUrl(profile.provider, selection.baseUrl, profile.baseUrl), model: profile.model?.trim() || defaultModel(profile.provider) };
  };
  return {
    async onRateLimit(waitSeconds: number | undefined): Promise<FailoverSwitchDecision | undefined> {
      let decision = runFailover(waitSeconds, options());
      if (decision.kind === 'switch') {
        // ключ без секрета не годится: broken и шаг дальше по цепочке
        if (!(await readKeySecret(context.secrets, decision.profile, decision.key))) {
          markKeyBroken(decision.profile.id, decision.key.id);
          keychainLog(`🔑 failover: ключ «${decision.key.label}» профиля «${decision.profile.label}» без секрета — помечен broken`);
          decision = runFailover(undefined, options());
        }
        if (decision.kind === 'switch') {
          const low = await switchTo(decision.profile, decision.key);
          if (!low) return undefined;
          keychainLog(`🔑 failover: ${decision.fromLabel} → ${decision.profile.label}/${decision.key.label} (429; ${decision.fromLabel} спит ${decision.sleepSeconds}с), цикл ${decision.cycle}${decision.profileChanged ? '' : ' (ключ внутри профиля)'}`);
          return low;
        }
      }
      if (decision.kind === 'wait') {
        keychainLog(`⏳ все ключи спят, пробуждение: ${decision.wakeLabel} через ${Math.ceil(decision.waitMs / 1000)}с, цикл ${decision.cycle}`);
        return { action: 'wait', waitMs: decision.waitMs };
      }
      if (decision.kind === 'stop') {
        if (decision.reason === 'noneLeft') {
          keychainLog('🔑 failover: живых ключей нет (все broken/выключены/без секрета) — стоп');
        } else if (decision.reason === 'maxCycles') {
          keychainLog(`🔑 failover: потолок циклов ${failoverMaxCycles()} исчерпан — стоп, нужен человек`);
        } else {
          keychainLog('⏳ все ключи спят, автономный режим выключен — стоп, ждём человека');
        }
        return { action: 'stop', waitMs: decision.waitMs, wakeLabel: decision.wakeLabel };
      }
      return undefined;
    },
    async onAuthError(): Promise<void> {
      const current = scanCurrent();
      if (!current.profileId) return;
      markKeyBroken(current.profileId, current.keyId);
      const label = profileLabel(current.profileId, profiles);
      const keyName = keyLabelFor(current.profileId, current.keyId, profiles);
      keychainLog(`🔑 ключ «${keyName}» профиля «${label}» помечен broken (401/403) — выведен из ротации; проверь ключ ${keyName} профиля ${label}`);
      void vscode.window.showWarningMessage(t('keychain.brokenKeyNotify', lang, { key: keyName, profile: label }));
    }
  };
}

// Агрессивные лимиты free-агрегаторов (B.AI и т.п.) не проходятся короткими
// паузами: лестница удлинена до 2/5/10 минут.
export const RATE_LIMIT_PAUSE_LADDER = [120, 300, 600];
// Cooldown между файлами даже БЕЗ rate-limit: бережёт бакет токенов/запросов.
export const FILE_COOLDOWN_DEFAULT_SECONDS = 5;
export const FILE_COOLDOWN_MULTIPASS_DEFAULT_SECONDS = 10;
export const FILE_COOLDOWN_MAX_SECONDS = 30;
// Пауза между кругами одного файла в мульти-пассе: защита от abuse,
// не настраивается сознательно.
export const PASS_BETWEEN_SECONDS = 15;
const RATE_LIMIT_HIT_WINDOW_MS = 5 * 60_000;
const rateLimitHitTimes: number[] = [];

export function recordRateLimitHit(now = Date.now()): void {
  rateLimitHitTimes.push(now);
}

export function rateLimitHitsLast5min(now = Date.now()): number {
  while (rateLimitHitTimes.length && now - rateLimitHitTimes[0] > RATE_LIMIT_HIT_WINDOW_MS) rateLimitHitTimes.shift();
  return rateLimitHitTimes.length;
}

export function resetRateLimitHits(): void {
  rateLimitHitTimes.length = 0;
}

export function fileCooldownSecondsFromSetting(value: unknown, auditPasses: number): number {
  const fallback = auditPasses >= 2 ? FILE_COOLDOWN_MULTIPASS_DEFAULT_SECONDS : FILE_COOLDOWN_DEFAULT_SECONDS;
  const n = Math.round(Number(value));
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(FILE_COOLDOWN_MAX_SECONDS, Math.max(0, n));
}

// Адаптивные чанки (v1.4b-17): preSplitTokens — бюджет токенов на запрос
// (maxRequestKTokens*1000); onPreSplit/onAdaptiveSplit/onQuarantineSkip —
// Output-логи (RU, не UI); quarantine — включать перекладывание в конец
// очереди (только для аудитов, которые не бросают на первой ошибке).
export interface AdaptiveChunkOptions {
  preSplitTokens?: number;
  quarantine?: boolean;
  onAdaptiveSplit?: (filename: string, fromLines: number, toLines: number) => void;
  onPreSplit?: (filename: string, fromLines: number, toLines: number) => void;
  onQuarantineSkip?: (filename: string) => void;
}

function isNetworkError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|socket hang up|EAI_AGAIN/i.test(msg);
}

// Ключевой фикс пропуска файлов: агрегаторы отдают перелимит НЕ только как
// 429/RateLimitError — текст 'too many requests'/'overloaded'/'quota' часто
// прилетает обычным Error (HTTP 502/503 или текст в 200-теле). Раньше такие
// ошибки не считались retriable и файл скипался СРАЗУ, без пауз лестницы.
function isRateLimitText(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /rate.?limit|too many requests|overloaded|quota|exceeded|\b429\b|\b503\b/i.test(msg);
}

function rateLimitPausesFromSetting(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) return 3;
  return Math.min(5, n);
}

// Батч 15: вся категоризация ошибок живёт в src/error-classifier. Здесь —
// единственный выход сбоя скана: локализованная карточка в панели, понятная
// нотификация и ОДИНАКОВЫЙ redactSecrets-путь для raw-сообщения в Output.
// Батч 17: значения API-ключа, найденные в plaintext settings.json и удалённые
// оттуда миграцией. Держим их только в памяти процесса — чтобы redactSecrets
// гарантированно вычищал старый ключ из Output-логов и тела Issue. В auth-пути
// они НЕ участвуют: аутентификация — строго через context.secrets.
const migratedLegacyApiKeys: string[] = [];

// Одноразовая миграция при активации: ключ из settings.json переезжает в
// SecretStorage (если секрета ещё нет) и БЕЗЖАЛОСТНО удаляется из config.
// Читаем через inspect только ради самого переноса — это путь удаления,
// а не аутентификационный фоллбэк.
export async function migrateApiKeyFromSettings(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('codescout');
  const inspected = config.inspect<string>('apiKey');
  const layers: Array<{ value: string | undefined; target: vscode.ConfigurationTarget }> = [
    { value: inspected?.workspaceFolderValue, target: vscode.ConfigurationTarget.WorkspaceFolder },
    { value: inspected?.workspaceValue, target: vscode.ConfigurationTarget.Workspace },
    { value: inspected?.globalValue, target: vscode.ConfigurationTarget.Global }
  ];
  const found = layers.filter((layer) => Boolean(layer.value?.trim()));
  if (found.length === 0) return;
  const secret = (await context.secrets.get(SECRET_KEY))?.trim();
  if (!secret) {
    const first = found[0]?.value?.trim();
    if (first) await context.secrets.store(SECRET_KEY, first);
  }
  for (const layer of found) {
    const value = layer.value?.trim() ?? '';
    if (value && !migratedLegacyApiKeys.includes(value)) migratedLegacyApiKeys.push(value);
    await config.update('apiKey', undefined, layer.target);
  }
}

async function secretKeyValues(context: vscode.ExtensionContext): Promise<string[]> {
  const secretKey = await context.secrets.get(SECRET_KEY) ?? '';
  // Батч 27: ключи всех профилей keychain — тоже секреты: redactSecrets обязан
  // вычищать ИХ из Output-хвоста и тела Issue, иначе профильный ключ утечёт
  // в публичный GitHub.
  const values = [secretKey, ...migratedLegacyApiKeys];
  // Батч 27/28: ключи ВСЕХ профилей и ВСЕХ их ключей — тоже секреты:
  // redactSecrets обязан вычищать их из Output-хвоста и тела Issue.
  for (const profile of readProfiles()) {
    for (const key of profile.keys) {
      const keyValue = await readKeySecret(context.secrets, profile, key);
      if (keyValue?.trim()) values.push(keyValue.trim());
    }
    const legacyValue = await context.secrets.get(secretKeyForProfile(profile.id));
    if (legacyValue?.trim()) values.push(legacyValue.trim());
  }
  return values.filter((key) => key.trim().length > 0);
}

function structuredError(error: unknown): ReturnType<typeof formatError> {
  return formatError(error, currentReportLanguage());
}

async function reportScanFailure(context: vscode.ExtensionContext, output: vscode.OutputChannel, panel: CodeScoutPanel, error: unknown, logPrefix = 'Error'): Promise<void> {
  const formatted = structuredError(error);
  const raw = formatted.rawMessage ?? '';
  lastScanError = raw;
  const redacted = raw ? redactSecrets(raw, await secretKeyValues(context)) : '';
  output.appendLine(`${logPrefix}: ${redacted || formatted.title}`);
  panel.setError(formatted.message, redacted || undefined, { category: formatted.category, title: formatted.title, hint: formatted.actionHint });
  void vscode.window.showErrorMessage(`CodeScout: ${formatted.title} — ${formatted.message}`);
}

// Батч 27: общий обработчик «все профили спят» для обычных/кастомных сканов —
// баннер в панели вместо красной модалки ошибки (решает пользователь).
function handleAllProfilesAsleep(panel: CodeScoutPanel, error: AllProfilesAsleepError): void {
  panel.setScanning(false);
  panel.setFailoverSleep({ wakeSeconds: Math.ceil(error.waitMs / 1000), wakeLabel: error.wakeLabel });
}

// Батч 15: дедлайн инференса (codescout.requestTimeoutSeconds, 10-600,
// дефолт 60с) применяется к модульному значению в llm-client — новый
// параметр reviewFiles не нужен, зависшие чанки падают в категорию timeout.
function applyRequestTimeoutSetting(): void {
  const seconds = requestTimeoutSecondsFromSetting(vscode.workspace.getConfiguration('codescout').get<number>('requestTimeoutSeconds'));
  setDefaultRequestTimeoutMs(seconds * 1000);
}

export async function reviewFiles(context: vscode.ExtensionContext, files: Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }>, workspaceRoot: string | undefined, onRetry: (event: RetryEvent, model: string) => void, onProgress?: (index: number, total: number, filename: string, elapsedMs: number) => void, onThinking?: (elapsedMs: number) => void, signal?: AbortSignal, systemPrompt = SYSTEM_PROMPT, continueOnFileError = false, onFileSkipped?: (filename: string, error: unknown) => void, onFileChecked?: (filename: string, fileIssues: ReviewIssue[]) => void, importsResolver?: (filename: string) => string, passes = 1, onPass?: (filename: string, pass: number, totalPasses: number) => void, rateLimitPauses = 0, onRatePause?: (filename: string, waitSeconds: number, pauseNumber: number, maxPauses: number) => void, sleeper: (ms: number, signal?: AbortSignal) => Promise<void> = sleep, promptLang: 'ru' | 'en' = 'ru', fileCooldown = 0, onFileCooldown?: (seconds: number) => void,   docsResolver?: (filename: string, text: string) => { section: string; used: number; bytes: number }, adaptive: AdaptiveChunkOptions = {}): Promise<ScanResult> {
  const startedAt = Date.now();
  const selection = await resolveExtensionSelection(context);
  // Локальный режим (батч 13, п.2): Ollama/LM Studio на localhost не требуют ключ.
  // Батч 27.1: локальный эндпоинт может жить в профиле (profile.baseUrl).
  if (!selection.key && !isLocalBaseUrl(selection.profileBaseUrl || selection.baseUrl)) {
    throw new Error(`${t('panel.errNoKey', promptLang, { p: selection.provider })}${t('panel.keyGet', promptLang, { x: keyUrl(selection.provider) ?? t('panel.keyGetAlt', promptLang) })}`);
  }
  if (files.length === 0) return { issues: [], filesAnalyzed: 0, skippedFiles: 0, durationMs: Date.now() - startedAt };
  // Батч 27: beginScan фиксирует профиль, которым стартует скан (метки в
  // чекпоинте), и сбрасывает циклы ротации. failover-хук — undefined при
  // выключенном failover.enabled: поведение retry-слоя не меняется вообще.
  // Батч 28: += рабочий ключ профиля — единица ротации теперь ключ.
  beginScan(selection.profileId ?? '', selection.keyId ?? DEFAULT_KEY_ID);
  const failover = await buildFailoverHooks(context, selection);
  const provider = createProvider(selection.provider, selection.key ?? 'local-no-key', selection.model, (event) => onRetry(event, selection.model), selection.baseUrl, signal, failover, selection.profileBaseUrl);
  const issues: ReviewIssue[] = [];
  // Legacy contracts: onProgress?.(fileIndex + 1, files.length, file.filename), onThinking?.(), panel.setProgress(index, total, filename), panel.setModelThinking().
  let skippedFiles = 0;
  // Очередь вместо простого прохода: карантин перекладывает тяжёлый файл
  // в конец, чтобы лёгкие не ждали его 30 пауз.
  const queue = files.map((_file, index) => index);
  const ladderCycles = new Map<number, number>();
  let processedCount = 0;
  while (queue.length > 0) {
    const fileIndex = queue.shift() as number;
    const file = files[fileIndex];
    if (processedCount > 0 && fileCooldown > 0) {
      if (signal?.aborted) throw abortError();
      onFileCooldown?.(fileCooldown);
      await sleeper(fileCooldown * 1000, signal);
    }
    processedCount += 1;
    let completed = false;
    let quarantined = false;
    let lastError: unknown;
    let pauses = 0;
    let quickRetries = 0;
    const docPick = docsResolver?.(file.filename, file.patch);
    const fileSystemPrompt = docPick?.section ? `${systemPrompt}\n\n${docPick.section}` : systemPrompt;
    // Рекурсивный обзор чанка: перелимит → делим этот чанк пополам (min 200
    // строк, overlap 50, абсолютные номера сохраняются) и ретрим половинки;
    // пред-оценка по токенам делит ещё ДО первой отправки.
    const reviewChunk = async (chunk: string, importsLine: string, passLine: string): Promise<ReviewIssue[]> => {
      if (signal?.aborted) throw abortError();
      const preBudget = adaptive.preSplitTokens ?? 0;
      if (preBudget > 0 && estimateRequestTokens(fileSystemPrompt.length + importsLine.length + passLine.length, chunk.length) > preBudget) {
        const pre = splitAuditChunk(chunk);
        if (pre) {
          adaptive.onPreSplit?.(file.filename, chunkLineCount(chunk), chunkLineCount(pre[0]));
          return [...await reviewChunk(pre[0], importsLine, passLine), ...await reviewChunk(pre[1], importsLine, passLine)];
        }
      }
      try {
        const elapsedMs = Date.now() - startedAt;
        onProgress?.(fileIndex + 1, files.length, file.filename, elapsedMs);
        onThinking?.(elapsedMs);
        const raw = await provider.review(fileSystemPrompt, buildReviewPrompt(file, chunk, importsLine, passLine, promptLang));
        return parseReviewResponse(raw, file.filename).issues;
      } catch (error) {
        if (isAbortError(error)) throw error;
        const retriable = error instanceof RateLimitError || isNetworkError(error) || isRateLimitText(error);
        const halves = retriable ? splitAuditChunk(chunk) : undefined;
        if (halves) {
          adaptive.onAdaptiveSplit?.(file.filename, chunkLineCount(chunk), chunkLineCount(halves[0]));
          return [...await reviewChunk(halves[0], importsLine, passLine), ...await reviewChunk(halves[1], importsLine, passLine)];
        }
        throw error;
      }
    };
    for (;;) {
      const fileIssues: ReviewIssue[] = [];
      try {
        const importsLine = importsResolver?.(file.filename) ?? '';
        for (let pass = 1; pass <= passes; pass++) {
          const passLine = pass > 1 ? passFindingsSummary(dedupeIssues(fileIssues)) : '';
          if (pass > 1) {
            onPass?.(file.filename, pass, passes);
            // abuse-guard: круги одного файла разнесены фиксированно
            await sleeper(PASS_BETWEEN_SECONDS * 1000, signal);
          }
          for (const chunk of splitPatch(file.patch, 45_000)) {
            const found = await reviewChunk(chunk, importsLine, passLine);
            fileIssues.push(...found.map((issue) => workspaceRoot ? correctIssueLine(issue, workspaceRoot) : issue));
          }
        }
        const deduped = dedupeIssues(fileIssues);
        issues.push(...deduped);
        // Батч 27: успешный файл — лестница сна текущего ключа сбрасывается
        // (квота живая), следующая 429 на этом ключе снова начнёт с 120с.
        const healthy = scanCurrent();
        if (healthy.profileId) markKeyHealthy(healthy.profileId, healthy.keyId);
        onFileChecked?.(file.filename, deduped);
        completed = true;
        break;
      } catch (error) {
        lastError = error;
        if (isAbortError(error)) throw error;
        const retriable = error instanceof RateLimitError || isNetworkError(error) || isRateLimitText(error);
        if (retriable && rateLimitPauses > 0 && pauses < rateLimitPauses) {
          const waitSeconds = RATE_LIMIT_PAUSE_LADDER[Math.min(pauses, RATE_LIMIT_PAUSE_LADDER.length - 1)];
          pauses += 1;
          onRatePause?.(file.filename, waitSeconds, pauses, rateLimitPauses);
          await sleeper(waitSeconds * 1000, signal);
          continue;
        }
        if (retriable && rateLimitPauses === 0 && quickRetries < 1) {
          quickRetries += 1;
          continue;
        }
        // Карантин: ladder-цикл = один полный проход пауз (rateLimitPauses).
        // Каждые 3 цикла = круг карантина (файл едет в конец очереди); после
        // 3 кругов (9 циклов) на 10-м цикле — скип с подсказкой.
        if (retriable && adaptive.quarantine && rateLimitPauses > 0 && continueOnFileError) {
          const cycles = (ladderCycles.get(fileIndex) ?? 0) + 1;
          ladderCycles.set(fileIndex, cycles);
          const rounds = Math.ceil(cycles / QUARANTINE_CYCLES_PER_ROUND);
          if (rounds > QUARANTINE_MAX_ROUNDS) {
            adaptive.onQuarantineSkip?.(file.filename);
          } else {
            quarantined = true;
            queue.push(fileIndex);
          }
          break;
        }
        break;
      }
    }
    if (quarantined) continue;
    if (!completed) {
      if (!continueOnFileError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
      skippedFiles++;
      onFileSkipped?.(file.filename, lastError);
    }
  }
  return { issues, filesAnalyzed: files.length - skippedFiles, skippedFiles, durationMs: Date.now() - startedAt };
}

async function reviewWorkspace(context: vscode.ExtensionContext, lastCommit: boolean, onRetry: (event: RetryEvent, model: string) => void, onProgress?: (index: number, total: number, filename: string, elapsedMs: number) => void, onThinking?: (elapsedMs: number) => void, signal?: AbortSignal, systemPrompt = SYSTEM_PROMPT, fileCooldown = 0, onFileCooldown?: (seconds: number) => void, onFileSkipped?: (filename: string, error: unknown) => void): Promise<ScanResult> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) throw new Error(t('panel.errNoGit', currentReportLanguage()));
  if (signal?.aborted) throw abortError();
  // Батч 19: как и в аудите, ошибка одного файла не прерывает ревью git-диффа.
  // Пропуски не теряются: они уходят в onFileSkipped и в итоговый лог.
  return reviewFiles(context, readGitDiff(workspaceRoot, { lastCommit }), workspaceRoot, onRetry, onProgress, onThinking, signal, systemPrompt, true, onFileSkipped, undefined, (filename) => importsContextLine(workspaceRoot, filename), 1, undefined, 0, undefined, undefined, currentReportLanguage(), fileCooldown, onFileCooldown);
}

let activeAbortController: AbortController | undefined;
let lastScanError: string | undefined;
// Батч 26: живой чекпоинт текущего аудита + флаг «аудит идёт». Нужны, чтобы
// команда cancelScan рисовала баннер догона СРАЗУ, не дожидаясь, пока abort
// дойдёт до catch в runFullAuditOnce (немедленный баннер без reload).
let liveAuditCheckpoint: AuditCheckpoint | undefined;
let auditRunActive = false;

async function runSampleReview(context: vscode.ExtensionContext, output: vscode.OutputChannel, panel: CodeScoutPanel): Promise<void> {
  const controller = new AbortController();
  activeAbortController?.abort();
  activeAbortController = controller;
  output.clear();
  output.show(true);
  output.appendLine('CodeScout: running built-in self-test...');
  panel.setScanning(true);
  try {
    const result = await reviewFiles(context, [SAMPLE_FILE], undefined, (event, model) => panel.setRetry(event, model), (index, total, filename, elapsedMs) => { panel.setProgress(index, total, filename, t('progress.file.check', currentReportLanguage()), elapsedMs); output.appendLine(`🔎 Проверяю: файл ${index}/${total}: ${filename} · ⏱ ${Math.floor(elapsedMs / 1000)}с`); }, (elapsedMs) => panel.setModelThinking(elapsedMs), controller.signal, withReportLanguage(SYSTEM_PROMPT, currentReportLanguage()));
    const summary = sampleTestSummary(result.issues.length, currentReportLanguage());
    panel.update(result.issues, buildStats(result.issues, result.filesAnalyzed, result.durationMs), true, summary, result.issues.length === 0);
    output.appendLine(`${summary}`);
    for (const issue of result.issues) output.appendLine(formatIssue(issue));
    void vscode.window.showInformationMessage(`CodeScout self-test: ${result.issues.length} issues found`);
  } catch (error) {
    if (isAbortError(error)) {
      panel.setCancelled();
      return;
    }
    if (error instanceof AllProfilesAsleepError) { handleAllProfilesAsleep(panel, error); return; }
    await reportScanFailure(context, output, panel, error, 'Self-test error');
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
  auditRunActive = true;
  panel.setAutoResume(undefined);
  let isResume = resume;
  let autonomyStartedAt = Date.now();
  let lastAttempt = 0;
  try {
  for (;;) {
    const outcome = await runFullAuditOnce(context, output, panel, isResume);
    if (outcome.kind === 'done') { panel.setAutoResume(undefined); return; }
    if (!autoResumeEnabled() || autoResumeCancelled || !outcome.view) { panel.setAutoResume(undefined); return; }
    const config = vscode.workspace.getConfiguration('codescout');
    const maxAttempts = autoResumeLimitFromSetting(config.get<number>('autoResumeMaxAttempts'), 1000);
    const maxMinutes = autoResumeLimitFromSetting(config.get<number>('autoResumeMaxMinutes'), 10000);
    const decision = autoResumeDecision(lastAttempt + 1, autonomyStartedAt, Date.now(), maxAttempts, maxMinutes);
    if (!decision) {
      output.appendLine(`🤖 автономный лимит исчерпан (${maxAttempts > 0 ? `${maxAttempts} попыток` : ''}${maxAttempts > 0 && maxMinutes > 0 ? ' / ' : ''}${maxMinutes > 0 ? `${maxMinutes} мин` : ''}) — нужен человек: кнопки «▶️ Продолжить» в баннере`);
      panel.setAutoResume(undefined);
      return;
    }
    lastAttempt = decision.attempt;
    output.appendLine(`🤖 rate-limit:_resume через ${decision.waitSeconds}с (попытка ${decision.attempt}${maxAttempts > 0 ? `/${maxAttempts}` : ''})`);
    const etaRemaining = Math.max(0, outcome.view.total - outcome.view.done);
    const etaSeconds = auditEtaSeconds(panel.getFileDurations(), etaRemaining, decision.waitSeconds, ladderRemainingSeconds(AUTO_RESUME_LADDER_SECONDS, decision.attempt));
    // Хост — единственный источник правды: пауза авто-догона — часть живого
    // скана, поэтому панель переводится в скан-режим ДО ухода в sleep
    // (Стоп кликабелен, «остановлено»/resume-баннеры скрыты, прогресс/ETA видны).
    panel.setScanning(true, true);
    panel.setAutoResume({ done: outcome.view.done, total: outcome.view.total, secondsLeft: decision.waitSeconds, attempt: decision.attempt, maxAttempts, etaSeconds });
    const waitController = new AbortController();
    activeAbortController?.abort();
    activeAbortController = waitController;
    // Батч 25: «Стоп» в паузе авто-догона — чекпоинт помечается 'cancelled'
    // и НЕ удаляется: остаток можно догнать любым провайдером.
    // Батч 26: и при 0 проверенных (остаток = весь план) — reload обязан
    // восстановить баннер, поэтому состояние пишем, пока есть remaining.
    const markCancelled = (): void => {
      const root = getWorkspaceRoot();
      if (!root) return;
      const saved = readAuditProgress(root);
      if (saved && (saved.checked.length > 0 || saved.remaining.length > 0)) {
        saved.state = 'cancelled';
        try {
          writeAuditProgress(root, saved);
        } catch {
          // диск недоступен — память панели уже показывает баннер
        }
      }
    };
    try {
      await sleep(decision.waitSeconds * 1000, waitController.signal);
    } catch {
      markCancelled();
      output.appendLine('🤖 авто-догон остановлен пользователем');
      panel.setAutoResume(undefined);
      return;
    } finally {
      if (activeAbortController === waitController) activeAbortController = undefined;
    }
    if (autoResumeCancelled) { markCancelled(); panel.setAutoResume(undefined); return; }
    isResume = true;
  }
  } finally {
    auditRunActive = false;
  }
}

async function runFullAuditOnce(context: vscode.ExtensionContext, output: vscode.OutputChannel, panel: CodeScoutPanel, resume = false): Promise<AuditOutcome> {
  const controller = new AbortController();
  activeAbortController?.abort();
  activeAbortController = controller;
  const workspaceRoot = getWorkspaceRoot();
  output.clear();
  output.show(true);
  panel.setScanning(true, resume);
  if (!workspaceRoot) {
    panel.setError(t('panel.errNoWorkspaceAudit', currentReportLanguage()));
    if (activeAbortController === controller) activeAbortController = undefined;
    return { kind: 'done' };
  }
  output.appendLine(resume ? 'CodeScout: resuming full project audit...' : 'CodeScout: starting full project audit...');
  let progress: AuditCheckpoint | undefined;
  liveAuditCheckpoint = undefined;
  let planFiles: string[] = [];
  // Батч 26: circuit breaker — N подряд скипов одной категории останавливают
  // аудит; 0 = выключен (codescout.skipBreakerLimit, дефолт 4).
  const auditBreakerLimit = skipBreakerLimitFromSetting(vscode.workspace.getConfiguration('codescout').get<number>('skipBreakerLimit'));
  const breakerState: SkipBreakerState = { count: 0 };
  try {
    const auditConfig = vscode.workspace.getConfiguration('codescout');
    const auditMaxFiles = auditConfig.get<number>('maxFiles', 100);
    const auditMaxLines = auditConfig.get<number>('maxLines', 0);
    const auditPasses = auditPassesFromSetting(auditConfig.get<number>('auditPasses'));
    const auditRateLimitPauses = rateLimitPausesFromSetting(auditConfig.get<number>('rateLimitPauses'));
    const auditChunkLines = chunkLinesFromSetting(auditConfig.get<number>('chunkLines'));
    const adaptive: AdaptiveChunkOptions = {
      preSplitTokens: maxRequestKTokensFromSetting(auditConfig.get<number>('maxRequestKTokens')) * 1000,
      quarantine: true,
      onAdaptiveSplit: (filename, from, to) => output.appendLine(`🪶 чанк тяжёл: делю ${from}→${to} строк, файл ${filename}`),
      onPreSplit: (filename, from, to) => output.appendLine(`📏 пред-деление: чанк ${from}→${to} по бюджету токенов`),
      onQuarantineSkip: (filename) => output.appendLine(`⛳ файл слишком тяжёл: снизь chunkLines или maxRequestKTokens (${filename})`)
    };
    const auditSelection = await resolveExtensionSelection(context);
    const previousHistory = readFindingsHistory(workspaceRoot);
    const auditScopeText = auditConfig.get<string>('auditScope') ?? '';
    const audit = collectAuditFiles(workspaceRoot, auditMaxFiles, auditMaxLines, auditScopeText, (message) => output.appendLine(message), auditChunkLines);
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
    const projectPrompt = buildProjectSystemPrompt(SYSTEM_PROMPT, workspaceRoot, docLinks, '');
    // Секционный RAG: вместо «весь док всем файлам» — per-file выбор секций
    // по пересечению токенов в бюджете codescout.docBudgetKb (buildProjectSystemPrompt
    // получает только ссылки; тела доков добавляются reviewFiles пофайлово).
    const docBudgetBytes = docBudgetBytesFromSetting(auditConfig.get<number>('docBudgetKb'));
    const docsForFile = (docs.sections?.length ?? 0) > 0 ? makeDocsResolver(docs.sections ?? [], docBudgetBytes, (message) => output.appendLine(message)) : undefined;
    if (projectPrompt.rulesLoaded) output.appendLine('📚 Загружены правила проекта');
    else output.appendLine('ℹ️ Правил нет — дефолт');
    // Батч 25: scopeHash = git HEAD + план файлов аудита. Догон разрешён
    // ЛЮБЫМ провайдером/моделью (tags в чекпоинте), но только на неизменном
    // скоупе; старый чекпоинт без hash = 'untracked' — не блокируем.
    const currentScopeHash = computeScopeHash(getGitHead(workspaceRoot), planFiles);
    let initial: AuditCheckpoint = { startedAt: Date.now(), model: auditSelection.model, provider: auditSelection.provider, scopeHash: currentScopeHash, state: 'running', checked: [], remaining: planFiles };
    if (resume) {
      const saved = readAuditProgress(workspaceRoot);
      if (!saved) output.appendLine('ℹ️ Прогресса не найдено — запускаю с нуля');
      else {
        const verdict = checkpointScopeVerdict(saved, currentScopeHash);
        if (verdict === 'changed' && !checkpointHasFileHashes(saved)) {
          // Батч 28: КРАСНЫЙ баннер остаётся ТОЛЬКО за legacy-чекпоинтами без
          // пер-файловых хэшей — там нечем отличить изменённый файл от целого.
          output.appendLine(`⛔ Скоуп изменился после остановки (${saved.scopeHash} → ${currentScopeHash}) — догон некорректен, нужен новый аудит`);
          panel.setScanning(false);
          const blocked = progressView(saved, auditBreakerLimit);
          if (blocked) panel.setAuditResume({ ...blocked, scopeMismatch: true });
          return { kind: 'done' };
        }
        if (verdict === 'changed') {
          // Батч 28: умный догон. Перепроверяются ТОЛЬКО файлы, чей хэш не
          // совпал (изменённые/новые); совпавшие находки сохраняются; файлы,
          // выпавшие из скоупа, уносят свои findings из результатов.
          const rec = reconcileCheckedHashes(saved, planFiles, (file) => hashAuditFile(workspaceRoot, file));
          initial = { ...saved, checked: rec.kept, remaining: planFiles.filter((file) => !rec.kept.some((entry) => entry.file === file)), provider: saved.provider ?? auditSelection.provider, scopeHash: currentScopeHash, state: 'running' };
          output.appendLine(`🟡 Скоуп изменился: ${rec.requeued.length} файлов обновлено — догон перепроверит их, ${rec.keptFindings} результатов сохранено${rec.dropped.length ? ` (выпало из скоупа: ${rec.dropped.length})` : ''}`);
          if (saved.checked.length > 0) {
            panel.setAuditResume({
              done: rec.kept.length,
              total: planFiles.length,
              model: initial.model,
              startedAt: saved.startedAt,
              ...(initial.provider ? { provider: initial.provider } : {}),
              scopeUpdate: { files: rec.requeued.length, findings: rec.keptFindings }
            });
          }
        } else {
          initial = { ...pruneAuditCheckpoint(saved, planFiles), provider: saved.provider ?? auditSelection.provider, scopeHash: saved.scopeHash ?? currentScopeHash, state: 'running' };
        }
        const tag = lastCheckpointTag(saved);
        if (tag.provider && tag.provider !== auditSelection.provider) output.appendLine(`🔀 Догон другим провайдером: было ${tag.provider} · ${tag.model ?? '?'}, стало ${auditSelection.provider} · ${auditSelection.model} — проверенные файлы НЕ перепроверяются`);
        else if (tag.model && tag.model !== auditSelection.model) output.appendLine(`🔀 Догон другой моделью: ${tag.model} → ${auditSelection.model} — проверенные файлы НЕ перепроверяются`);
        output.appendLine(`▶️ Продолжаю аудит: проверено ${initial.checked.length} файлов, осталось ${planFiles.length - initial.checked.length}`);
      }
    } else {
      clearAuditProgress(workspaceRoot);
      // Батч 26 last-good: audit-results.json на старте НЕ трогаем — пустой
      // или сорванный прогон не должен затирать находки предыдущего_good_
      // аудита. «Начать заново» (restartAudit) чистит их явно, с модалкой.
    }
    progress = initial;
    const state = initial;
    liveAuditCheckpoint = progress;
    const doneNames = new Set(state.checked.map((entry) => entry.file));
    const toReview = audit.files.filter((file) => !doneNames.has(file.filename));
    const chunkTotals = new Map<string, number>();
    for (const file of audit.files) chunkTotals.set(file.filename, (chunkTotals.get(file.filename) ?? 0) + 1);
    const chunkProgress = new Map<string, { done: number; issues: ReviewIssue[] }>();
    const loggedStart = new Set<string>();
    const fileStartedAt = new Map<string, number>();
    const pauseByFile = new Map<string, number>();
    const auditEta = (): number | null => auditEtaSeconds(panel.getFileDurations(), Math.max(0, planFiles.length - doneNames.size));
    if (auditPasses > 1) output.appendLine(`🔁 Мульти-пасс аудит: ${auditPasses} круга на файл (codescout.auditPasses)`);
    const persist = (): void => {
      state.remaining = planFiles.filter((file) => !doneNames.has(file));
      writeAuditProgress(workspaceRoot, state);
      // Персистентный частичный отчёт после КАЖДОГО завершённого файла:
      // атомарно (temp+rename), переживёт reload/выключение; панель на
      // старте рисует именно эти findings (единый источник).
      // Батч 26 last-good: при 0 проверенных НЕ пишем — пустой прогон
      // обязан сохранить непустой audit-results.json предыдущего аудита.
      if (state.checked.length > 0) writeAuditResultsFromCheckpoint(workspaceRoot, state, planFiles.length);
    };
    persist();
    const result = await reviewFiles(context, toReview, workspaceRoot, (event, model) => panel.setRetry(event, model), (index, total, filename, elapsedMs) => { panel.setProgress(index, total, filename, t('progress.file.audit', currentReportLanguage()), elapsedMs, auditEta()); if (!loggedStart.has(filename)) { loggedStart.add(filename); fileStartedAt.set(filename, Date.now()); output.appendLine(`🔎 файл ${index}/${total}: ${filename} — старт…`); } }, (elapsedMs) => panel.setModelThinking(elapsedMs), controller.signal, withReportLanguage(projectPrompt.prompt, currentReportLanguage()), true, (filename, error) => { const reason = formatSkipReason(error); state.skippedFiles = upsertSkippedFile(state.skippedFiles, { file: filename, category: reason.category, ...(reason.http !== undefined ? { http: reason.http } : {}), ts: Date.now() }); output.appendLine(skipReasonLine(filename, reason)); if (skipBreakerFeed(breakerState, reason.category, auditBreakerLimit)) throw new AuditCircuitBreakerError(reason.category, breakerState.count); }, (filename, fileIssues) => {
      const acc = chunkProgress.get(filename) ?? { done: 0, issues: [] as ReviewIssue[] };
      acc.done += 1;
      acc.issues.push(...fileIssues);
      chunkProgress.set(filename, acc);
      if (acc.done >= (chunkTotals.get(filename) ?? 1)) {
        doneNames.add(filename);
        skipBreakerReset(breakerState);
        // Батч 27: у каждого файла чекпоинта — метки профиля ключа, которым
        // он проверен (после failover-switch провайдер/модель тоже новые).
        // Метку профиля ставим ТОЛЬКО когда профилей реально >1: единственный
        // «default» от миграции — не различим с legacy-одиночным ключом, и
        // вешать «· default» на каждую находку было бы шумом (контракт 25).
        // Батч 28: += метка КЛЮЧА (когда в профиле >1 enabled-ключа) и
        // SHA-256 содержимого файла на момент проверки — основа умного догона.
        const allProfiles = readProfiles();
        const currentRef = scanCurrent();
        const currentProfile = allProfiles.length > 1 ? allProfiles.find((profile) => profile.id === currentRef.profileId) : undefined;
        const profileTag = allProfiles.length > 1 ? profileLabel(currentRef.profileId) : '';
        const enabledKeyCount = allProfiles.find((profile) => profile.id === currentRef.profileId)?.keys.filter((k) => k.enabled).length ?? 0;
        const keyTag = enabledKeyCount > 1 ? keyLabelFor(currentRef.profileId, currentRef.keyId) : '';
        const tagProvider = currentProfile?.provider ?? auditSelection.provider;
        const tagModel = currentProfile?.model?.trim() || auditSelection.model;
        state.checked.push({ file: filename, issues: dedupeIssues(acc.issues), provider: tagProvider, model: tagModel, ...(profileTag ? { profile: profileTag } : {}), ...(keyTag ? { key: keyTag } : {}), ts: Date.now(), hash: hashAuditFile(workspaceRoot, filename) });
        persist();
        // В медиану ETA попадает ЧИСТАЯ длительность файла: время пауз
        // rate-limit вычитается и учитывается отдельно (лестница в ETA).
        const pausedMs = (pauseByFile.get(filename) ?? 0) * 1000;
        pauseByFile.delete(filename);
        const seconds = Math.max(0, Math.round((((Date.now() - (fileStartedAt.get(filename) ?? Date.now())) - pausedMs) / 1000) * 10) / 10);
        panel.recordFileDuration(seconds);
        output.appendLine(`✅ файл ${doneNames.size}/${planFiles.length}: ${filename} — готово за ${seconds}с`);
      }
    }, (filename) => importsContextLine(workspaceRoot, filename), auditPasses, (filename, pass, totalPasses) => { panel.setAuditPass(pass, totalPasses); output.appendLine(`🔄 круг ${pass}/${totalPasses}: файл ${filename}`); }, auditRateLimitPauses, (filename, waitSeconds, pauseNumber, maxPauses) => { pauseByFile.set(filename, (pauseByFile.get(filename) ?? 0) + waitSeconds); recordRateLimitHit(); const hits = rateLimitHitsLast5min(); output.appendLine(`⏸ rate-limit: пауза ${waitSeconds}с, ретри файл ${filename} (пауза ${pauseNumber}/${maxPauses}) · 429 за 5 мин: ${hits}${hits > 10 ? ' ⚠️ агрегатор банит надолго — нужен часовой отдых' : ''}`); }, undefined, currentReportLanguage(), effectiveFileCooldownSeconds(auditPasses), (seconds) => output.appendLine(`⏸ cooldown ${seconds}с перед следующим файлом`), docsForFile, adaptive);
    // Батч 25: находки с метками нахождателей + zone-мердж (±3) — догон
    // другим провайдером не дублирует то, что уже лежит в чекпоинте.
    const mergedIssues = collectCheckpointFindings(state);
    const filesAnalyzed = state.checked.length;
    const auditMeta = { provider: auditSelection.provider, model: auditSelection.model, timestamp: Date.now() };
    // Батч 26 last-good: прогон с 0 проверенных файлов НЕ перезаписывает
    // непустые audit-results.json / history / context. Панель и динамика
    // «новых/починено/осталось» считаются против last-good: старые находки
    // показываем как текущие, «починено» при 0 проверенных — всегда 0.
    const lastGood = filesAnalyzed === 0 ? readAuditResults(workspaceRoot) : undefined;
    const carriedIssues = filesAnalyzed === 0 && lastGood && lastGood.findings.length > 0 ? lastGood.findings : mergedIssues;
    if (filesAnalyzed > 0) {
      writeProjectContext(workspaceRoot, filesAnalyzed, mergedIssues, auditMeta);
      writeFindingsHistory(workspaceRoot, mergedIssues, 'full-audit', auditMeta);
      // Финальный отчёт = единый источник для панели (task 5).
      writeAuditResults(workspaceRoot, { findings: mergedIssues, checkedFiles: filesAnalyzed, total: planFiles.length, model: auditSelection.model, updatedAt: Date.now() });
    } else if (lastGood && lastGood.findings.length > 0) {
      output.appendLine(`ℹ️ Проверено 0 файлов — last-good результаты (${lastGood.findings.length} находок) НЕ перезаписаны`);
    }
    if (result.skippedFiles > 0) {
      // Батч 25: остановка rate-limit — чекпоинт остаётся с состоянием
      // 'interrupted'; догон возможен любым провайдером (см. resume-ветку).
      state.state = 'interrupted';
      persist();
      output.appendLine(`ℹ️ Скипнуто ${result.skippedFiles} файлов (rate-limit/ошибки) — чекпоинт сохранён, можно догнать кнопкой «▶️ Продолжить»`);
    } else {
      clearAuditProgress(workspaceRoot);
      liveAuditCheckpoint = undefined;
    }
    const findingsDiff = buildFindingsDiff(previousHistory, carriedIssues, currentReportLanguage(), new Set(state.checked.map((entry) => entry.file)));
    // Батч 14: панель получает только непдавленные находки; диск (context/
    // history/results) остаётся полным единым источником правды.
    const visibleIssues = filterSuppressed(carriedIssues, context.workspaceState);
    panel.update(visibleIssues, buildStats(visibleIssues, filesAnalyzed, result.durationMs), false, '', false, findingsDiff);
    panel.setFirstAuditDone(true);
    if (filesAnalyzed > 0) panel.showAuditSummary({ issues: visibleIssues.length, files: filesAnalyzed, seconds: Math.round(result.durationMs / 100) / 10 });
    const resumeView = result.skippedFiles > 0 ? progressView(state, auditBreakerLimit) : undefined;
    // Батч 26 last-good: при 0 проверенных в чекпоинте находок нет — в
    // баннере показываем счётчик last-good, чтобы он не противоречил отчёту.
    if (resumeView && filesAnalyzed === 0 && carriedIssues.length > 0) {
      resumeView.findings = carriedIssues.length;
    }
    if (resumeView) panel.setAuditResume(resumeView);
    await vscode.commands.executeCommand('codescout.panel.focus');
    output.appendLine(filesAnalyzed > 0 ? `Контекст проекта сохранён: .codescout/context.json (${mergedIssues.length} findings)` : 'ℹ️ Контекст/история не обновлены: проверено 0 файлов (last-good цел)');
    output.appendLine(findingsDiff ? `Динамика относительно прошлого аудита: ${findingsDiff.summary}` : 'ℹ️ Первый аудит — сравнение недоступно, история заведена');
    output.appendLine(`Аудит завершён: проверено ${filesAnalyzed}, пропущено ${audit.skippedLarge.length + audit.skippedUnreadable.length + result.skippedFiles + audit.ignored.length + audit.skippedLimit}`);
    dumpFindings(output, carriedIssues, `Итог аудита: ${carriedIssues.length} находок, проверено файлов: ${filesAnalyzed}`);
    return resumeView ? { kind: 'interrupted', view: resumeView } : { kind: 'done' };
  } catch (error) {
    // Батч 25: ЛЮБАЯ остановка (cancel пользователя, crash) оставляет
    // чекпоинт с честным состоянием — 'cancelled'/'interrupted', НЕ удаление.
    // Батч 26: и при 0 проверенных файлов — чекпоинт уже лежит на диске
    // (persist в начале), помечаем состояние всегда, иначе reload теряет баннер.
    if (progress && workspaceRoot) {
      progress.state = isAbortError(error) ? 'cancelled' : 'interrupted';
      try {
        writeAuditProgress(workspaceRoot, progress);
      } catch {
        // диск мог отвалиться — в памяти состояние уже проставлено
      }
    }
    const resumeView = progressView(progress, auditBreakerLimit);
    if (isAbortError(error)) {
      // Батч 26: cancel — баннер догона обязателен даже при 0 проверенных;
      // setCancelled рисует красную карточку, она остаётся ВЫШЕ баннера.
      if (resumeView) panel.setAuditResume(resumeView);
      panel.setCancelled();
      return { kind: 'done' };
    }
    // Батч 26: circuit breaker — стоп аудита с баннером и подсказкой по
    // категории; НЕ показываем модалку ошибки (причина уже в баннере),
    // авто-догон не запускаем (провайдер сломан — нужен человек).
    if (error instanceof AuditCircuitBreakerError) {
      autoResumeCancelled = true;
      output.appendLine(`🛑 Circuit breaker: ${error.skippedCount} скипа подряд одной категории «${error.category}» — аудит остановлен (подсказка в баннере, codescout.skipBreakerLimit)`);
      panel.setScanning(false);
      if (resumeView) panel.setAuditResume(resumeView);
      return { kind: 'interrupted', view: resumeView };
    }
    // Батч 27: failover упёрся в «все профили спят» (автономный выключен) или
    // в потолок циклов — баннер с «Подождать и продолжить» / «Стоп», чекпоинт
    // цел, авто-догон НЕ запускаем (решение за человеком).
    if (error instanceof AllProfilesAsleepError) {
      autoResumeCancelled = true;
      panel.setScanning(false);
      if (resumeView) panel.setAuditResume(resumeView);
      panel.setFailoverSleep({ wakeSeconds: Math.ceil(error.waitMs / 1000), wakeLabel: error.wakeLabel });
      return { kind: 'done' };
    }
    if (resumeView) panel.setAuditResume(resumeView);
    await reportScanFailure(context, output, panel, error);
    return { kind: 'interrupted', view: resumeView };
  } finally {
    if (activeAbortController === controller) activeAbortController = undefined;
  }
}

async function runCustomReview(context: vscode.ExtensionContext, output: vscode.OutputChannel, panel: CodeScoutPanel, focusArg?: string, scopeArg?: string, globsArg?: string): Promise<void> {
  autoResumeCancelled = false;
  const lang = currentReportLanguage();
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(t('panel.errNoWorkspaceCustom', lang));
    return;
  }
  let focus = (focusArg ?? '').trim();
  let scope = scopeArg === 'active' || scopeArg === 'list' ? scopeArg : 'all';
  const globs = scopeArg === undefined && focusArg === undefined
    ? []
    : (globsArg ?? '').split(',').map((glob) => glob.trim()).filter(Boolean);
  if (!focus) {
    focus = (await vscode.window.showInputBox({ prompt: t('custom.focusPrompt', lang), placeHolder: t('custom.focusPlaceholder', lang) }))?.trim() ?? '';
    if (!focus) return;
    const picked = await vscode.window.showQuickPick(
      [
        { label: t('form.scopeAll', lang), value: 'all' },
        { label: t('form.scopeActive', lang), value: 'active' },
        { label: t('form.scopeList', lang), value: 'list' }
      ],
      { placeHolder: t('custom.scopePlaceholder', lang) }
    );
    if (!picked) return;
    scope = picked.value;
    if (scope === 'list') {
      const globsInput = await vscode.window.showInputBox({ prompt: t('custom.globsPrompt', lang), placeHolder: 'src/**/*.ts, tests/*.py' });
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
    const customPauses = rateLimitPausesFromSetting(reviewConfig.get<number>('rateLimitPauses'));
    const customChunkLines = chunkLinesFromSetting(reviewConfig.get<number>('chunkLines'));
    const customAdaptive: AdaptiveChunkOptions = {
      preSplitTokens: maxRequestKTokensFromSetting(reviewConfig.get<number>('maxRequestKTokens')) * 1000,
      onAdaptiveSplit: (filename, from, to) => output.appendLine(`🪶 чанк тяжёл: делю ${from}→${to} строк, файл ${filename}`),
      onPreSplit: (filename, from, to) => output.appendLine(`📏 пред-деление: чанк ${from}→${to} по бюджету токенов`)
    };
    const collection = collectFilesForScope(workspaceRoot, scope as ReviewScope, globs, vscode.window.activeTextEditor?.document.uri.fsPath, maxFiles, maxLines, (message) => output.appendLine(message), customChunkLines);
    for (const entry of collection.chunked) output.appendLine(`📄 файл ${entry.file}: ${entry.chunks} чанков (перекрытие ${AUDIT_CHUNK_OVERLAP} строк)`);
    if (collection.files.length === 0) {
      panel.setError(scope === 'list' ? t('panel.errNoGlobMatch', lang, { globs: globs.join(', ') }) : t('panel.errNoFiles', lang));
      output.appendLine('Своё ревью не запущено: файлов для проверки не найдено.');
      return;
    }
    if (collection.skippedLimit > 0) output.appendLine(`⚠️ Пропущено ${collection.skippedLimit} файлов по лимиту (codescout.maxFiles=${maxFiles})`);
    const projectPrompt = buildProjectSystemPrompt(SYSTEM_PROMPT, workspaceRoot);
    const prompt = withReportLanguage(withFocusInstructions(projectPrompt.prompt, focus), currentReportLanguage());
    const result = await reviewFiles(context, collection.files, workspaceRoot, (event, model) => panel.setRetry(event, model), (index, total, filename, elapsedMs) => { panel.setProgress(index, total, filename, t('progress.file.custom', lang), elapsedMs); output.appendLine(`🎯 Своё ревью: файл ${index}/${total}: ${filename} · ⏱ ${Math.floor(elapsedMs / 1000)}с`); }, (elapsedMs) => panel.setModelThinking(elapsedMs), controller.signal, prompt, false, (filename, error) => output.appendLine(skipReasonLine(filename, formatSkipReason(error))), undefined, (filename) => importsContextLine(workspaceRoot, filename), 1, undefined, customPauses, (filename, waitSeconds, pauseNumber, maxPauses) => { recordRateLimitHit(); const hits = rateLimitHitsLast5min(); output.appendLine(`⏸ rate-limit: пауза ${waitSeconds}с, ретри файл ${filename} (пауза ${pauseNumber}/${maxPauses}) · 429 за 5 мин: ${hits}${hits > 10 ? ' ⚠️ агрегатор банит надолго — нужен часовой отдых' : ''}`); }, undefined, lang, effectiveFileCooldownSeconds(1), (seconds) => output.appendLine(`⏸ cooldown ${seconds}с перед следующим файлом`), undefined, customAdaptive);
    // Батч 14: скрытые находки не попадают в панель (пост-обработка).
    const visibleIssues = filterSuppressed(dedupeIssues(result.issues), context.workspaceState);
    panel.update(visibleIssues, buildStats(visibleIssues, result.filesAnalyzed, result.durationMs), false, '', false, undefined, focus);
    await vscode.commands.executeCommand('codescout.panel.focus');
    dumpFindings(output, result.issues, `Итог кастомного ревью: ${result.issues.length} находок, проверено файлов: ${result.filesAnalyzed}`);
    void vscode.window.showInformationMessage(t('notify.customDone', lang, { n: result.issues.length }));
  } catch (error) {
    if (isAbortError(error)) { panel.setCancelled(); return; }
    if (error instanceof AllProfilesAsleepError) { handleAllProfilesAsleep(panel, error); return; }
    await reportScanFailure(context, output, panel, error);
  } finally {
    if (activeAbortController === controller) activeAbortController = undefined;
  }
}

async function runSelectionReview(context: vscode.ExtensionContext, output: vscode.OutputChannel, panel: CodeScoutPanel, uri?: vscode.Uri): Promise<void> {
  const lang = currentReportLanguage();
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(t('panel.errNoWorkspaceReview', lang));
    return;
  }
  if (!uri) {
    void vscode.window.showErrorMessage(t('panel.errUseExplorer', lang));
    return;
  }
  const target = uri.fsPath;
  let isDirectory = false;
  try {
    isDirectory = statSync(target).isDirectory();
  } catch {
    void vscode.window.showErrorMessage(t('panel.errPathUnreadable', lang, { path: target }));
    return;
  }
  const rel = relative(workspaceRoot, resolve(target)).replaceAll('\\', '/');
  if (!rel || rel.startsWith('..')) {
    void vscode.window.showErrorMessage(t('panel.errPathOutside', lang));
    return;
  }
  const globs = isDirectory ? `${rel}/**` : rel;
  // разовая проверка выбора: codescout.auditScope здесь сознательно игнорируется
  await runCustomReview(context, output, panel, t('custom.explorerFocus', lang, { rel }), 'list', globs);
}

async function runReview(context: vscode.ExtensionContext, lastCommit: boolean, output: vscode.OutputChannel, panel: CodeScoutPanel, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  // P0 Astra-2: «Стоп» ставит autoResumeCancelled, но он не должен блокировать
  // последующие обычные ревью — сбрасываем при любом новом старте.
  autoResumeCancelled = false;
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
    const result = await reviewWorkspace(context, lastCommit, (event, model) => panel.setRetry(event, model), (index, total, filename, elapsedMs) => { panel.setProgress(index, total, filename, t('progress.file.check', currentReportLanguage()), elapsedMs); output.appendLine(`🔎 Проверяю: файл ${index}/${total}: ${filename} · ⏱ ${Math.floor(elapsedMs / 1000)}с`); }, (elapsedMs) => panel.setModelThinking(elapsedMs), controller.signal, withReportLanguage(projectPrompt.prompt, currentReportLanguage()), effectiveFileCooldownSeconds(1), (seconds) => output.appendLine(`⏸ cooldown ${seconds}с перед следующим файлом`), (filename, error) => output.appendLine(skipReasonLine(filename, formatSkipReason(error))));
    if (result.skippedFiles > 0) {
      output.appendLine(`⚠️ Пропущено файлов: ${result.skippedFiles} (ошибки или rate-limit) — см. строки «Пропущен файл» выше.`);
    }
    // Батч 14: пост-обработка перед передачей в вебвью — скрытые (FP) находки
    // не попадают в панель; Output-лог остаётся полным (сырые данные).
    const visibleIssues = filterSuppressed(result.issues, context.workspaceState);
    const stats = buildStats(visibleIssues, result.filesAnalyzed, result.durationMs);
    panel.update(visibleIssues, stats);
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
    if (error instanceof AllProfilesAsleepError) { handleAllProfilesAsleep(panel, error); return; }
    await reportScanFailure(context, output, panel, error);
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
  autoResumeMaxAttempts?: number;
  autoResumeMaxMinutes?: number;
  auditScope?: string;
  auditPasses?: number;
  maxFiles?: number;
  uiTheme?: string;
  accentColor?: string;
  uiDensity?: string;
  uiFontSize?: string;
  findingsSort?: string;
  reportTheme?: string;
  showConfidence?: boolean;
  customColors?: string;
  rateLimitPauses?: number;
  requestTimeoutSeconds?: number;
  url?: string;
  // Батч 27: failover-ручки + id профиля для keychain-кнопок центра.
  failoverEnabled?: boolean;
  failoverMaxCycles?: number;
  id?: string;
  // Батч 28: id ключа внутри профиля (кнопки ключей) и направление стрелки.
  keyId?: string;
  dir?: number;
  // МИКРО-БАТЧ 28.2: поля инлайн-формы профиля (keychainFormSave/Models).
  provider?: string;
  profileId?: string;
  label?: string;
  model?: string;
}

const RULES_TEMPLATE = '# Правила проекта CodeScout\n\nМодель подмешивает этот файл в каждый промт ревью.\n\n## Примеры\n- Не флагать tenant-scoped чтения через Prisma.\n- Все внешние HTTP-вызовы — с таймаутом и ретраями.\n- Миграции БД — только через папку prisma/migrations.\n';

async function openOrCreateRules(workspaceRoot: string | undefined): Promise<string> {
  if (!workspaceRoot) throw new Error(t('rules.errNoWorkspace', currentReportLanguage()));
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
  return vscode.workspace.getConfiguration('codescout').get<string>('language') === 'en' ? 'en' : 'ru';
}

function effectiveFileCooldownSeconds(auditPasses: number): number {
  const explicit = vscode.workspace.getConfiguration('codescout').inspect<number>('fileCooldownSeconds')?.globalValue;
  return fileCooldownSecondsFromSetting(explicit, auditPasses);
}

function auditBannerEnabled(): boolean {
  return vscode.workspace.getConfiguration('codescout').get<boolean>('showAuditBanner', true);
}

function readUiPrefs(): UiPrefs {
  const config = vscode.workspace.getConfiguration('codescout');
  return normalizeUiPrefs({
    theme: config.get<string>('uiTheme', 'auto') as UiPrefs['theme'],
    accent: config.get<string>('accentColor', 'auto') as UiPrefs['accent'],
    density: config.get<string>('uiDensity', 'standard') as UiPrefs['density'],
    fontSize: config.get<string>('uiFontSize', 'm') as UiPrefs['fontSize'],
    showConfidence: config.get<boolean>('showConfidence', true),
    findingsSort: config.get<string>('findingsSort', 'severity') as UiPrefs['findingsSort'],
    reportTheme: config.get<string>('reportTheme', 'auto') as UiPrefs['reportTheme'],
    customColors: config.get<string>('customColors', '')
  });
}

let settingsPanel: vscode.WebviewPanel | undefined;
let settingsConfigSubscription: vscode.Disposable | undefined;
let rerenderSettings: () => void = () => {};

async function migrateLanguageSetting(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('codescout');
  const done = (await context.secrets.get('codescout.languageMigrated')) === 'true';
  if (done) return;
  const legacy = config.inspect<string>('reportLanguage');
  const legacyValue = legacy?.globalValue ?? legacy?.workspaceValue;
  const currentLang = config.inspect<string>('language');
  const hasLang = Boolean(currentLang?.globalValue || currentLang?.workspaceValue);
  if (legacyValue && !hasLang) await config.update('language', legacyValue === 'en' ? 'en' : 'ru', vscode.ConfigurationTarget.Global);
  if (legacyValue) await config.update('reportLanguage', undefined, vscode.ConfigurationTarget.Global);
  await context.secrets.store('codescout.languageMigrated', 'true');
}

// Батч 13: тест подключения возвращает результат вызывающей стороне —
// палитра показывает нативное уведомление, центр настроек получает
// connResult postMessage-ем (форма не перерисовывается, правки не теряются).
// Батч 15: результат дополнен структурой (title/hint/category) из
// error-classifier — центр рисует красный бейдж категории + совет.
interface ConnectionTestResult {
  ok: boolean;
  message: string;
  title?: string;
  hint?: string;
  category?: string;
}

async function runConnectionTest(context: vscode.ExtensionContext): Promise<ConnectionTestResult> {
  const lang = currentReportLanguage();
  const selection = await resolveExtensionSelection(context);
  if (!selection.baseUrl && selection.provider !== 'custom') {
    return { ok: true, message: t('center.connected', lang, { n: 0 }) };
  }
  const testSel = { provider: selection.provider, model: selection.model, key: selection.key ?? '', baseUrl: selection.baseUrl, userChosenModel: false };
  try {
    // Батч 21: тест подключения — строгий (tolerateErrors=false): 401/404
    // должны вернуться rich-ошибкой с категорией, а не «подключено, 0 моделей».
    const models = await fetchModels(testSel, false);
    return { ok: true, message: t('center.connected', lang, { n: models.length }) };
  } catch (error) {
    const formatted = formatError(error, lang);
    return { ok: false, message: `${formatted.title} — ${formatted.message}`, title: formatted.title, hint: formatted.actionHint, category: formatted.category };
  }
}

async function fileIsDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}

async function readSettingsState(context: vscode.ExtensionContext): Promise<SettingsState> {
  const selection = await resolveExtensionSelection(context);
  // Батч 27: маска и факт ключа — от активного профиля keychain, иначе от
  // одиночного секрета (иначе центр показывает «ключа нет» при активном профиле).
  const key = selection.key ?? await context.secrets.get(SECRET_KEY);
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
    maxFiles: Math.max(1, Math.round(vscode.workspace.getConfiguration('codescout').get<number>('maxFiles', 100) || 100)),
    autoResume: vscode.workspace.getConfiguration('codescout').get<boolean>('autoResume', false),
    autoResumeMaxAttempts: autoResumeLimitFromSetting(vscode.workspace.getConfiguration('codescout').get<number>('autoResumeMaxAttempts'), 1000),
    autoResumeMaxMinutes: autoResumeLimitFromSetting(vscode.workspace.getConfiguration('codescout').get<number>('autoResumeMaxMinutes'), 10000),
    auditScope: vscode.workspace.getConfiguration('codescout').get<string>('auditScope') ?? '',
    auditPasses: auditPassesFromSetting(vscode.workspace.getConfiguration('codescout').get<number>('auditPasses')),
    rateLimitPauses: rateLimitPausesFromSetting(vscode.workspace.getConfiguration('codescout').get<number>('rateLimitPauses')),
    requestTimeoutSeconds: requestTimeoutSecondsFromSetting(vscode.workspace.getConfiguration('codescout').get<number>('requestTimeoutSeconds')),
    version: String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0'),
    uiTheme: readUiPrefs().theme,
    accentColor: readUiPrefs().accent,
    uiDensity: readUiPrefs().density,
    uiFontSize: readUiPrefs().fontSize,
    showConfidence: readUiPrefs().showConfidence,
    findingsSort: readUiPrefs().findingsSort,
    reportTheme: readUiPrefs().reportTheme,
    customColors: JSON.stringify(readUiPrefs().customColors),
    keychainProfiles: readProfiles(),
    keychainActiveId: readActiveId(),
    // Батч 28: состояние ключей (asleep/broken) для бейджей в центре.
    keychainRuntime: runtimeSnapshot(),
    failoverEnabled: failoverEnabled(),
    failoverMaxCycles: failoverMaxCycles()
  };
}

async function saveKeyProvider(context: vscode.ExtensionContext, message: SettingsMessage): Promise<{ status: string; providerChanged: boolean }> {
  const lang = currentReportLanguage();
  const selection = await resolveExtensionSelection(context);
  // Батч 27: есть активный профиль keychain → весь стек (ключ/provider/model)
  // сохраняется В ПРОФИЛЬ, одиночные секреты не дублируем.
  const profileId = selection.profileId;
  // Батч 18.9: oldProvider = реально сохранённый провайдер ДО сохранения
  // (профиль > SecretStorage > манифестный default), а не «gemini» из конфига.
  const oldProviderSecret = await context.secrets.get(SECRET_PROVIDER);
  const oldProvider = profileId ? selection.provider : (oldProviderSecret?.trim() || selection.provider);
  const key = message.apiKey?.trim();
  const notes: string[] = [];
  let provider: ProviderName = selection.provider;
  let model = selection.model;
  if (key) {
    if (profileId) await storeProfileSecret(context.secrets, profileId, key);
    else await context.secrets.store(SECRET_KEY, key);
    notes.push(t('center.noteKey', lang));
  }
  // Батч 17.5: префикс ключа сильнее выбора в селекте. Селект по умолчанию
  // показывает provider из конфига (manifest default 'gemini'), и раньше
  // вставленный oc_sk_ ключ сохранялся как gemini — автодетект никогда не
  // срабатывал. Теперь распознанный ключ строго выставляет своего провайдера.
  const detected = key ? detectProvider(key) : undefined;
  // Батч 21, п.2: голое sk- — не автодетект, а догадка. Спрашиваем через
  // QuickPick; отмена меню = сохранить так, как выбрано в селекте вручную.
  const skChosen = detected?.ambiguous ? await pickSkProvider() : undefined;
  if (detected && !detected.ambiguous) {
    provider = detected.provider;
    model = selection.userChosenModel ? model : detected.model;
    notes.push(t('center.noteProviderAuto', lang, { p: provider }));
  } else if (skChosen) {
    provider = skChosen.provider;
    model = selection.userChosenModel ? model : skChosen.model;
    await context.secrets.store(SECRET_MODEL_CHOSEN, 'false');
    notes.push(t('center.noteProviderManual', lang));
  } else if (message.providerKey && message.providerKey !== 'auto') {
    provider = message.providerKey as ProviderName;
    if (provider !== selection.provider || key) {
      model = defaultModel(provider);
      await context.secrets.store(SECRET_MODEL_CHOSEN, 'false');
    }
  } else if (key) {
    notes.push(t('center.noteProviderManual', lang));
  }
  if (!profileId) await context.secrets.store(SECRET_PROVIDER, provider);
  const baseUrl = message.baseUrl?.trim() || '';
  await vscode.workspace.getConfiguration('codescout').update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
  if (provider === 'custom' && !baseUrl) notes.push(t('center.noteCustomNoUrl', lang));
  const storedKey = key || (profileId ? await readProfileSecret(context.secrets, profileId) : await context.secrets.get(SECRET_KEY));
  if (storedKey) {
    const validated = await validateDefaultModel(context, { provider, model, key: storedKey, baseUrl: baseUrl || selection.baseUrl, profileId }, true);
    model = validated.model;
  }
  if (profileId) {
    await writeProfiles(readProfiles().map((profile) => (profile.id === profileId ? { ...profile, provider, ...(model.trim() ? { model: model.trim() } : {}) } : profile)));
  } else {
    await context.secrets.store(SECRET_MODEL, model);
  }
  const providerChanged = provider !== oldProvider;
  return { status: `${t('center.savedKey', lang, { p: provider, m: model || t('center.nowModelMissing', lang) })}${notes.length ? ` (${notes.join('; ')})` : ''}`, providerChanged };
}

// Батч 18.9: провайдер сменился — модель прежнего провайдера гарантированно
// невалидна, поэтому после применения настроек сами открываем меню выбора
// модели (codescout.chooseModel). Только когда ключ есть: без ключа команда
// показывает «сначала ключ» и не должна шуметь.
async function autoSelectModelAfterProviderChange(context: vscode.ExtensionContext, providerChanged: boolean): Promise<void> {
  if (!providerChanged) return;
  // Батч 27: ключ может жить в профиле keychain — проверяем оба пути.
  const selection = await resolveExtensionSelection(context);
  if (!(selection.key || (await context.secrets.get(SECRET_KEY)))) return;
  await vscode.commands.executeCommand('codescout.chooseModel');
}

// Батч 27: ручное переключение активного профиля с МОДАЛЬНЫМ подтверждением
// (база, всегда). Возвращает выбранный профиль или undefined (отмена/нет
// такого). Успешный вызов уже записал codescout.keychain.active и почистил
// кэш моделей — кэш изолирован между профилями.
async function confirmAndActivateProfile(profileId: string): Promise<KeychainProfile | undefined> {
  const lang = currentReportLanguage();
  const profiles = readProfiles();
  const target = profiles.find((profile) => profile.id === profileId);
  if (!target) return undefined;
  if (profileId === readActiveId()) return undefined;
  const modelLabel = target.model?.trim() || defaultModel(target.provider);
  const answer = await vscode.window.showWarningMessage(
    t('keychain.switchConfirm', lang, { label: target.label, p: target.provider, m: modelLabel }),
    { modal: true },
    t('keychain.switchConfirmBtn', lang)
  );
  if (answer !== t('keychain.switchConfirmBtn', lang)) return undefined;
  await writeActiveId(target.id);
  clearModelsCache();
  // Явный выбор профиля сбрасывает флаг broken: пользователь мог обновить ключ.
  // Батч 28: чистим по всем ключам профиля.
  for (const key of target.keys) clearKeyBroken(target.id, key.id);
  return target;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CodeScout');
  hostOutput = output;
  // Хвост Output (последние 50 строк) нужен диагностику reportIssue; сам
  // канал VS Code не отдаёт содержимое обратно, поэтому зеркалируем appendLine.
  const outputTail: string[] = [];
  const realAppendLine = output.appendLine.bind(output);
  const realClear = output.clear.bind(output);
  output.appendLine = (value?: string): void => {
    outputTail.push(String(value ?? ''));
    if (outputTail.length > 50) outputTail.splice(0, outputTail.length - 50);
    realAppendLine(value ?? '');
  };
  output.clear = (): void => {
    outputTail.length = 0;
    realClear();
  };
  const panel = new CodeScoutPanel(context.extensionUri);
  // Батч 14: панель умеет скрывать находки («Ложное срабатывание») — ей
  // нужен workspaceState; вся логика хранения в findingsStore.
  panel.attachWorkspaceState(context.workspaceState);
  // The old one-time flow used: await context.secrets.store(SECRET_FULL_AUDIT_WELCOME, 'true')
  // 👋 Запустить полный аудит для контекста?
  panel.setWelcomeChoiceHandler(() => { void context.secrets.store(SECRET_FULL_AUDIT_WELCOME, 'true'); });
  let lastScanWasLastCommit = false;
  // Батч 15: карточка ошибки предлагает «Повторить попытку» — хост знает,
  // какой скан был последним, и перезапускает именно его.
  let lastScanKind: 'review' | 'audit' | 'custom' | 'sample' = 'review';
  let lastCustomArgs: { focus: string; scope: string; globs: string } | undefined;
  let pendingScans = 0;
  // Keep clearing blocked through preflight, auto-resume waits and abort cleanup.
  const runScan = async (task: () => Promise<void>): Promise<void> => {
    pendingScans++;
    try { await task(); } finally { pendingScans--; }
  };
  context.subscriptions.push(output);
  // Батч 15: стартовый дедлайн запросов + реакция на смену настройки без
  // перезагрузки окна (значения вне 10-600 клампятся в llm-client).
  applyRequestTimeoutSetting();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('codescout.requestTimeoutSeconds')) applyRequestTimeoutSetting();
  }));
  const syncKeyStatus = async (): Promise<void> => {
    try {
      const selection = await resolveExtensionSelection(context);
      const validated = selection.key && !selection.userChosenModel
        ? await validateDefaultModel(context, selection, true)
        : { model: selection.model, userChosen: Boolean(selection.userChosenModel) };
      panel.setKey(selection.key ? maskApiKey(selection.key) : false, selection.provider, validated.model);
    } catch (error) {
      // Ошибка доверия workspace baseUrl не должна ронять активацию расширения.
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Ключ/модель не загружены: ${message}`);
      panel.setKey(undefined);
    }
  };
  // Батч 17: миграция ключа из settings.json в SecretStorage ОБЯЗАТЕЛЬНО до
  // первого resolveExtensionSelection — иначе панель на долю секунды останется
  // без ключа, который лежал в открытом config. syncKeyStatus запускаем уже
  // после переноса/очистки.
  // Батч 27: затем keychain-миграция — одиночный ключ превращается в профиль
  // «default» без потери: после обновления старый ключ продолжает работать.
  // Батч 28: затем миграция «профиль с одним секретом» → «профиль с keys[0]»
  // (keychain.<id> → keychain.<id>.default); профили батча 27 работают без
  // действий пользователя.
  void migrateApiKeyFromSettings(context).catch(() => {}).then(() => migrateLegacyKeyToDefault(context)).catch(() => {}).then(() => migrateProfilesToMultiKey(context)).catch(() => {}).then(() => syncKeyStatus());
  void migrateLanguageSetting(context).catch(() => {});
  panel.setOnboardingHidden(context.globalState.get<boolean>('codescout.onboardingDismissed') === true);
  const activateRoot = getWorkspaceRoot();
  panel.setFirstAuditDone(activateRoot ? existsSync(join(activateRoot, CONTEXT_FILE)) : undefined);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codescout.panel', panel),
    vscode.commands.registerCommand('codescout.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'codescout')),
    vscode.commands.registerCommand('codescout.dismissOnboarding', async () => {
      await context.globalState.update('codescout.onboardingDismissed', true);
      panel.setOnboardingHidden(true);
    }),
    vscode.commands.registerCommand('codescout.openAuditReport', async () => {
      output.show(true);
      await vscode.commands.executeCommand('codescout.panel.focus');
    }),
    vscode.commands.registerCommand('codescout.reportIssue', async () => {
      // Батч 17.5 (Privacy): логи аудита уезжают в публичный Issue — сначала
      // модальное предупреждение с явным согласием, без «слепой» отправки.
      const confirmLang = currentReportLanguage();
      const answer = await vscode.window.showWarningMessage(t('issue.logsWarn', confirmLang), { modal: true }, t('issue.logsWarnBtn', confirmLang));
      if (answer !== t('issue.logsWarnBtn', confirmLang)) return;
      const cfg = vscode.workspace.getConfiguration('codescout');
      // Батч 17: только SecretStorage + in-memory значения после миграции;
      // чтение ключа из settings.json здесь упразднено.
      const keyValues = await secretKeyValues(context);
      const safe = (value: string) => redactSecrets(value, keyValues);
      const preRedactedOutputTail = outputTail.map((line) => redactSecrets(line, keyValues));
      const preRedactedLastScanError = lastScanError ? redactSecrets(lastScanError, keyValues) : undefined;
      const body = buildIssueBody(currentReportLanguage(), {
        extVersion: safe(String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0')),
        vscodeVersion: safe(vscode.version),
        os: safe(`${platform()} ${release()}`),
        provider: safe(cfg.get<string>('provider') || 'auto'),
        model: safe(cfg.get<string>('model') || ''),
        language: safe(currentReportLanguage()),
        uiTheme: safe(cfg.get<string>('uiTheme', 'auto')),
        auditPasses: auditPassesFromSetting(cfg.get<number>('auditPasses')),
        rateLimitPauses: rateLimitPausesFromSetting(cfg.get<number>('rateLimitPauses')),
        hasKey: keyValues.some((key) => Boolean(key.trim())),
        outputTail: preRedactedOutputTail,
        lastScanError: preRedactedLastScanError
      });
      await vscode.env.openExternal(vscode.Uri.parse(reportIssueUrl(body)));
    }),
    vscode.commands.registerCommand('codescout.toggleLanguage', async () => {
      const config = vscode.workspace.getConfiguration('codescout');
      const next = config.get<string>('language') === 'en' ? 'ru' : 'en';
      await config.update('language', next, vscode.ConfigurationTarget.Global);
      // Явная перезагрузка без опоры на тайминг onDidChangeConfiguration:
      // панель и центр перерисовываются сразу, клик по глобусу не может
      // «потеряться», если событие конфига не дошло.
      panel.forceLanguageRefresh();
      rerenderSettings();
    }),
    vscode.commands.registerCommand('codescout.openSettingsPage', async (anchor?: string) => {
      const render = async (status = '', statusKind: 'ok' | 'error' | 'retry' = 'ok', formPatch?: Partial<SettingsState>): Promise<void> => {
        if (settingsPanel) {
          settingsPanel.title = t('title.center', currentReportLanguage());
          const assets = { codiconCss: settingsPanel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'codicon.css')).toString(), cspSource: settingsPanel.webview.cspSource };
          // Батч 28.1: рендер центра не должен ронять webview целиком; деградации
          // блоков (try/catch в settingsHtml) печатаются в Output хоста.
          // Батч 28.2: formPatch — перерисовка с ОТКРЫТОЙ формой (ошибка
          // валидации внутри карточки + введённые значения остаются в полях).
          const snapshot = await readSettingsState(context);
          settingsPanel.webview.html = buildSettingsHtml(formPatch ? { ...snapshot, ...formPatch } : snapshot, status, statusKind, randomBytes(16).toString('hex'), anchor ?? '', assets, currentReportLanguage(), (issue) => output.appendLine(`⚠️ Центр настроек: ${issue}`));
        }
      };
      rerenderSettings = () => { void render(); };
      // HOTFIX: панель могли закрыть без корректного onDidDispose (reload
      // окна). WebviewPanel.disposed появился позже наших типов 1.85 —
      // читаем defensively: undefined у старых VS Code просто не мешает.
      const panelDisposed = (settingsPanel as unknown as { disposed?: boolean } | undefined)?.disposed === true;
      if (!settingsPanel || panelDisposed) {
        settingsPanel = vscode.window.createWebviewPanel('codescout.settings', t('title.center', currentReportLanguage()), vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [context.extensionUri] });
        settingsPanel.onDidDispose(() => {
          settingsConfigSubscription?.dispose();
          settingsConfigSubscription = undefined;
          settingsPanel = undefined;
        });
        settingsConfigSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
          const watched = ['uiTheme', 'accentColor', 'uiDensity', 'uiFontSize', 'showConfidence', 'findingsSort', 'reportTheme', 'customColors', 'autoResume', 'autoResumeMaxAttempts', 'autoResumeMaxMinutes', 'auditScope', 'auditPasses', 'maxLines', 'maxFiles', 'docLinks', 'docMaxKb', 'docMaxLinks', 'rateLimitPauses', 'requestTimeoutSeconds', 'language', 'showAuditBanner', 'keychain', 'failover.enabled', 'failover.maxCycles'];
          if (!watched.some((key) => event.affectsConfiguration(`codescout.${key}`))) return;
          void render();
        });
        settingsPanel.webview.onDidReceiveMessage((message: SettingsMessage) => {
          if (!message || typeof message.command !== 'string') return;
          if (!KNOWN_SETTINGS_COMMANDS.has(message.command)) return;
          void (async () => {
            if (message.command === 'refreshContext') {
              const lang = currentReportLanguage();
              if (pendingScans || activeAbortController || panel.isScanRunning()) {
                await render(t('project.contextBusy', lang), 'error');
                return;
              }
              const root = getWorkspaceRoot();
              if (!root) {
                await render(t('project.contextNoWorkspace', lang), 'error');
                return;
              }
              clearAuditProgress(root);
              clearAuditResults(root);
              const contextPath = join(root, CONTEXT_FILE);
              if (existsSync(contextPath)) unlinkSync(contextPath);
              panel.clearProjectContext();
              await render(t('project.contextCleared', lang));
              return;
            }
            if (message.command === 'pickScope') {
              const workspaceRoot = getWorkspaceRoot();
              if (!workspaceRoot) { await settingsPanel?.webview.postMessage({ type: 'scopePickResult', globs: [], outside: [], noWorkspace: true }); return; }
              const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, defaultUri: vscode.Uri.file(workspaceRoot), openLabel: t('dialog.addToScope', currentReportLanguage()) });
              const globs: string[] = [];
              const outside: string[] = [];
              for (const uri of picked ?? []) {
                const rel = relative(workspaceRoot, resolve(uri.fsPath)).replaceAll('\\', '/');
                if (!rel || rel.startsWith('..') || isAbsolute(rel)) { outside.push(uri.fsPath); continue; }
                globs.push(uri.fsPath === resolve(workspaceRoot) || (await fileIsDirectory(uri)) ? `${rel}/**` : rel);
              }
              await settingsPanel?.webview.postMessage({ type: 'scopePickResult', globs, outside });
              return;
            }
            // ── Батч 27: keychain-кнопки центра настроек ────────────────────
            if (message.command === 'keychainAdd') {
              const lang = currentReportLanguage();
              const label = (await vscode.window.showInputBox({ prompt: t('keychain.newLabelPrompt', lang), ignoreFocusOut: true }))?.trim();
              if (!label) { await render(t('keychain.actionCancelled', lang)); return; }
              const providerPicked = await vscode.window.showQuickPick([...PROVIDER_ORDER], { placeHolder: t('keychain.pickProviderForProfile', lang), ignoreFocusOut: true });
              if (!providerPicked) { await render(t('keychain.actionCancelled', lang)); return; }
              let provider = providerPicked as ProviderName;
              const keyInput = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true, prompt: t('keychain.newKeyPrompt', lang) });
              if (!keyInput?.trim()) { await render(t('keychain.actionCancelled', lang)); return; }
              // Префикс ключа сильнее селекта (тот же контракт, что в saveKeyProvider).
              const detected = detectProvider(keyInput);
              let model = defaultModel(provider);
              if (detected && !detected.ambiguous) { provider = detected.provider; model = detected.model; }
              const validated = await validateDefaultModel(context, { provider, model, key: keyInput.trim() }, true);
              const added = await addProfile(context.secrets, { label, provider, model: validated.model, key: keyInput.trim() });
              clearModelsCache();
              await syncKeyStatus();
              await render(t('keychain.addedNotify', lang, { label: added.label }));
              return;
            }
            // ── МИКРО-БАТЧ 28.2: инлайн-форма профиля (карточка в вебвью) ────
            if (message.command === 'keychainFormSave') {
              const lang = currentReportLanguage();
              const profileId = (message.profileId ?? '').trim();
              const providerRaw = (message.provider ?? '').trim();
              const keyInput = (message.apiKey ?? '').trim();
              const labelInput = (message.label ?? '').trim();
              const modelInput = (message.model ?? '').trim();
              const baseUrlInput = (message.baseUrl ?? '').trim();
              const draft: NonNullable<SettingsState['keychainFormDraft']> = { provider: providerRaw, label: labelInput, model: modelInput, baseUrl: baseUrlInput, ...(profileId ? { profileId } : {}) };
              // Ошибки валидации живут ВНУТРИ формы: черновик+текст возвращаем
              // в перерисовку карточки; профиль/секрет не трогаем.
              const failForm = async (error: string): Promise<void> => {
                await render(t('keychain.actionCancelled', lang), 'error', { keychainFormDraft: draft, keychainFormError: error });
              };
              let provider: ProviderName;
              try {
                provider = normalizeProvider(providerRaw);
              } catch {
                await failForm(t('keychain.formErrProvider', lang));
                return;
              }
              if (!profileId && !keyInput) { await failForm(t('keychain.formErrKey', lang)); return; }
              if (baseUrlInput && !profileBaseUrl(baseUrlInput)) { await failForm(t('keychain.formErrBaseUrl', lang)); return; }
              if (profileId) {
                const updated = await updateProfileFromForm(context.secrets, profileId, { label: labelInput, provider, model: modelInput, key: keyInput, baseUrl: baseUrlInput });
                if (!updated) { await failForm(t('keychain.formUnknownProfile', lang)); return; }
                clearModelsCache();
                await syncKeyStatus();
                await render(t('keychain.formSavedNotify', lang, { label: updated.label }));
                return;
              }
              const label = labelInput || t('keychain.formAutoLabel', lang, { p: provider, n: readProfiles().length + 1 });
              const added = await addProfile(context.secrets, { label, provider, ...(modelInput ? { model: modelInput } : {}), key: keyInput, ...(baseUrlInput ? { baseUrl: baseUrlInput } : {}) });
              clearModelsCache();
              await syncKeyStatus();
              await render(t('keychain.formSavedNotify', lang, { label: added.label }));
              return;
            }
            if (message.command === 'keychainFormModels') {
              const lang = currentReportLanguage();
              const postModels = (payload: Record<string, unknown>): void => {
                void settingsPanel?.webview.postMessage({ type: 'formModels', ...payload });
              };
              // Ключ берём ИЗ ПОЛЯ ФОРМЫ (до сохранения) или из SecretStorage
              // редактируемого профиля; НИКАКОЙ записи в settings/секреты здесь.
              let provider: ProviderName;
              try {
                provider = normalizeProvider((message.provider ?? '').trim());
              } catch {
                postModels({ ok: false, message: t('keychain.formErrProvider', lang) });
                return;
              }
              const profileId = (message.profileId ?? '').trim();
              const draftKey = (message.apiKey ?? '').trim();
              const baseRaw = (message.baseUrl ?? '').trim();
              if (baseRaw && !profileBaseUrl(baseRaw)) { postModels({ ok: false, message: t('keychain.formErrBaseUrl', lang) }); return; }
              const profile = profileId ? readProfiles().find((candidate) => candidate.id === profileId) : undefined;
              const storedKey = profileId ? await readProfileSecret(context.secrets, profileId) : undefined;
              const key = draftKey || storedKey || '';
              const overrideBase = profileBaseUrl(baseRaw) ?? profile?.baseUrl;
              // localhost-режим (Ollama/LM Studio) работает без ключа — как в fetchModels.
              if (!key && !isLocalBaseUrl(resolveBaseUrl(provider, undefined, overrideBase))) { postModels({ ok: false, message: t('keychain.formErrKey', lang) }); return; }
              try {
                const models = await fetchModels({ provider, model: defaultModel(provider), key, baseUrl: '', profileBaseUrl: overrideBase, userChosenModel: false });
                if (models.length === 0) { postModels({ ok: false, message: t('keychain.formModelsEmpty', lang) }); return; }
                postModels({ ok: true, models, model: preferredLiveModel(models, defaultModel(provider)) });
              } catch {
                postModels({ ok: false, message: t('keychain.formModelsErr', lang) });
              }
              return;
            }
            if (message.command === 'keychainSetActive') {
              const lang = currentReportLanguage();
              const switched = await confirmAndActivateProfile(String(message.id ?? ''));
              if (!switched) { await render(t('keychain.actionCancelled', lang)); return; }
              await syncKeyStatus();
              await render(t('keychain.switchedNotify', lang, { p: switched.provider, m: switched.model?.trim() || defaultModel(switched.provider) }));
              return;
            }
            // Батч 27.1, п.1: «Override Base URL» профиля. Пустое значение =
            // сброс (базовый URL провайдера); битый URL — отказ без записи.
            if (message.command === 'keychainBaseUrl') {
              const lang = currentReportLanguage();
              const id = String(message.id ?? '');
              const value = typeof message.baseUrl === 'string' ? message.baseUrl.trim() : '';
              const updated = await setProfileBaseUrl(id, value);
              if (!updated) { await render(t('keychain.baseUrlInvalid', lang), 'error'); return; }
              clearModelsCache();
              await syncKeyStatus();
              await render(t('keychain.baseUrlSavedNotify', lang, { label: updated.label }));
              return;
            }
            // ── Батч 28: стрелки порядка профилей + CRUD ключей внутри ──────
            if (message.command === 'keychainMove') {
              const lang = currentReportLanguage();
              const id = String(message.id ?? '');
              const dir = message.dir === 1 ? 1 : message.dir === -1 ? -1 : 0;
              if (!dir) { await render(t('keychain.actionCancelled', lang)); return; }
              const next = await moveProfile(id, dir as -1 | 1);
              if (!next) { await render(t('keychain.actionCancelled', lang)); return; }
              await render(t('keychain.movedNotify', lang, { label: next.find((profile) => profile.id === id)?.label ?? id }));
              return;
            }
            if (message.command === 'keychainAddKey') {
              const lang = currentReportLanguage();
              const id = String(message.id ?? '');
              const target = readProfiles().find((profile) => profile.id === id);
              if (!target) { await render(t('keychain.actionCancelled', lang)); return; }
              const label = (await vscode.window.showInputBox({ prompt: t('keychain.keyLabelPrompt', lang, { n: target.keys.length + 1 }), ignoreFocusOut: true }))?.trim() ?? '';
              const keyInput = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true, prompt: t('keychain.keyPastePrompt', lang, { label: target.label }) });
              if (!keyInput?.trim()) { await render(t('keychain.actionCancelled', lang)); return; }
              const updated = await addKey(context.secrets, id, { label, key: keyInput.trim() });
              if (!updated) { await render(t('keychain.keyLimit', lang), 'error'); return; }
              await syncKeyStatus();
              await render(t('keychain.keyAddedNotify', lang, { label: updated.keys[updated.keys.length - 1]?.label ?? label, profile: target.label }));
              return;
            }
            if (message.command === 'keychainRenameKey') {
              const lang = currentReportLanguage();
              const id = String(message.id ?? '');
              const keyId = String(message.keyId ?? '');
              const profile = readProfiles().find((candidate) => candidate.id === id);
              const key = profile?.keys.find((candidate) => candidate.id === keyId);
              if (!profile || !key) { await render(t('keychain.actionCancelled', lang)); return; }
              const label = await vscode.window.showInputBox({ prompt: t('keychain.keyRenamePrompt', lang, { label: key.label }), value: key.label, ignoreFocusOut: true });
              if (label === undefined || !label.trim()) { await render(t('keychain.actionCancelled', lang)); return; }
              const updated = await renameKey(id, keyId, label);
              const saved = updated?.keys.find((candidate) => candidate.id === keyId);
              await render(t('keychain.keyRenamedNotify', lang, { label: saved?.label ?? label.trim() }));
              return;
            }
            if (message.command === 'keychainDeleteKey') {
              const lang = currentReportLanguage();
              const id = String(message.id ?? '');
              const keyId = String(message.keyId ?? '');
              const label = readProfiles().find((profile) => profile.id === id)?.keys.find((candidate) => candidate.id === keyId)?.label ?? keyId;
              const result = await removeKey(context.secrets, id, keyId);
              if (!result.ok) {
                await render(result.reason === 'lastKey' ? t('keychain.keyLastDelete', lang) : t('keychain.actionCancelled', lang), 'error');
                return;
              }
              await syncKeyStatus();
              await render(t('keychain.keyDeletedNotify', lang, { label }));
              return;
            }
            if (message.command === 'keychainToggleKey') {
              const lang = currentReportLanguage();
              const id = String(message.id ?? '');
              const keyId = String(message.keyId ?? '');
              const profile = readProfiles().find((candidate) => candidate.id === id);
              const key = profile?.keys.find((candidate) => candidate.id === keyId);
              if (!profile || !key) { await render(t('keychain.actionCancelled', lang)); return; }
              const updated = await setKeyEnabled(id, keyId, !key.enabled);
              const saved = updated?.keys.find((candidate) => candidate.id === keyId);
              await syncKeyStatus();
              await render(t(saved?.enabled ? 'keychain.keyEnabledNotify' : 'keychain.keyDisabledNotify', lang, { label: saved?.label ?? keyId }));
              return;
            }
            if (message.command === 'keychainRename') {
              const lang = currentReportLanguage();
              const id = String(message.id ?? '');
              const target = readProfiles().find((profile) => profile.id === id);
              if (!target) { await render(t('keychain.actionCancelled', lang)); return; }
              const label = await vscode.window.showInputBox({ prompt: t('keychain.renamePrompt', lang, { label: target.label }), value: target.label, ignoreFocusOut: true });
              if (label === undefined || !label.trim()) { await render(t('keychain.actionCancelled', lang)); return; }
              await renameProfile(id, label);
              await render(t('keychain.renamedNotify', lang, { label: label.trim() }));
              return;
            }
            if (message.command === 'keychainDelete') {
              const lang = currentReportLanguage();
              const id = String(message.id ?? '');
              const profiles = readProfiles();
              const target = profiles.find((profile) => profile.id === id);
              if (!target) { await render(t('keychain.actionCancelled', lang)); return; }
              let newActiveId: string | undefined;
              if (id === readActiveId()) {
                const rest = profiles.filter((profile) => profile.id !== id);
                if (rest.length === 0) {
                  // Последний профиль: удаляем только через явное подтверждение,
                  // актив сбрасывается — молчаливого фолбэка нет.
                  const answer = await vscode.window.showWarningMessage(t('keychain.deleteLastConfirm', lang, { label: target.label }), { modal: true }, t('common.delete', lang));
                  if (answer !== t('common.delete', lang)) { await render(t('keychain.actionCancelled', lang)); return; }
                  newActiveId = '';
                } else {
                  const picked = await vscode.window.showQuickPick(
                    rest.map((profile) => ({ label: profile.label, description: `${profile.provider} · ${profile.model?.trim() || defaultModel(profile.provider)}`, profileId: profile.id })),
                    { placeHolder: t('keychain.deleteActivePick', lang), ignoreFocusOut: true }
                  );
                  if (!picked) { await render(t('keychain.actionCancelled', lang)); return; }
                  newActiveId = picked.profileId;
                }
              }
              const result = await removeProfile(context.secrets, id, newActiveId);
              if (!result.ok) { await render(t('keychain.deleteNeedActive', lang), 'error'); return; }
              await clearModelsCache();
              await syncKeyStatus();
              await render(t('keychain.deletedNotify', lang, { label: target.label }));
              return;
            }
            if (message.command === 'saveKeyProvider') {
              const saved = await saveKeyProvider(context, message);
              await syncKeyStatus();
              await render(saved.status);
              await autoSelectModelAfterProviderChange(context, saved.providerChanged);
            } else if (message.command === 'saveAppearance') {
              const config = vscode.workspace.getConfiguration('codescout');
              const language = message.reportLanguage === 'en' ? 'en' : 'ru';
              const banner = message.showAuditBanner !== false;
              await config.update('language', language, vscode.ConfigurationTarget.Global);
              await config.update('showAuditBanner', banner, vscode.ConfigurationTarget.Global);
              await render(t('center.savedLang', currentReportLanguage(), { L: language.toUpperCase(), B: t(banner ? 'center.on' : 'center.off', currentReportLanguage()) }));
            } else if (message.command === 'clearApiKey') {
              await vscode.commands.executeCommand('codescout.clearApiKey');
              await render(t('center.keyCleared', currentReportLanguage()));
          } else if (message.command === 'chooseModel') {
            await render(t('center.connecting', currentReportLanguage()), 'retry');
            await vscode.commands.executeCommand('codescout.chooseModel');
            await render(t('center.modelRefresh', currentReportLanguage()));
          } else if (message.command === 'testConnection') {
            const result = await runConnectionTest(context);
            await settingsPanel?.webview.postMessage({ type: 'connResult', ok: result.ok, message: result.message, title: result.title, hint: result.hint, category: result.category });
          } else if (message.command === 'saveDocLinks') {
            const links = (message.linksText ?? '').split(/\r?\n/).map((link) => link.trim()).filter(Boolean);
            const maxKb = docLimitsFromKb(message.docMaxKb) / 1024;
            const maxLinks = docLimitsFromCount(message.docMaxLinks);
            const maxLinesRaw = Math.round(Number(message.maxLines));
            const maxLines = Number.isFinite(maxLinesRaw) && maxLinesRaw > 0 ? Math.min(100000, maxLinesRaw) : 0;
            const autoResume = message.autoResume === true;
            const auditScope = (message.auditScope ?? '').trim();
            const auditPasses = auditPassesFromSetting(message.auditPasses);
            const autoResumeMaxAttempts = autoResumeLimitFromSetting(message.autoResumeMaxAttempts, 1000);
            const autoResumeMaxMinutes = autoResumeLimitFromSetting(message.autoResumeMaxMinutes, 10000);
            const config = vscode.workspace.getConfiguration('codescout');
            await config.update('docLinks', links, vscode.ConfigurationTarget.Global);
            await config.update('docMaxKb', maxKb, vscode.ConfigurationTarget.Global);
            await config.update('docMaxLinks', maxLinks, vscode.ConfigurationTarget.Global);
            await config.update('maxLines', maxLines, vscode.ConfigurationTarget.Global);
            await config.update('autoResume', autoResume, vscode.ConfigurationTarget.Global);
            await config.update('autoResumeMaxAttempts', autoResumeMaxAttempts, vscode.ConfigurationTarget.Global);
            await config.update('autoResumeMaxMinutes', autoResumeMaxMinutes, vscode.ConfigurationTarget.Global);
            await config.update('auditScope', auditScope, vscode.ConfigurationTarget.Global);
            await config.update('auditPasses', auditPasses, vscode.ConfigurationTarget.Global);
            await render(t('center.savedProject', currentReportLanguage(), { n: links.length, kb: maxKb, max: maxLinks, ml: maxLines === 0 ? t('center.maxLinesNo', currentReportLanguage()) : t('center.maxLinesN', currentReportLanguage(), { n: maxLines }), p: auditPasses, ar: autoResume ? `${t('center.on', currentReportLanguage())} (${autoResumeBadgeDetail(autoResumeMaxAttempts, autoResumeMaxMinutes, currentReportLanguage())})` : t('center.off', currentReportLanguage()), sc: auditScope || t('center.scopeAll', currentReportLanguage()) }));
          } else if (message.command === 'saveAll') {
            const config = vscode.workspace.getConfiguration('codescout');
            const parts: string[] = [];
            let providerChanged = false;
            if (message.apiKey || message.providerKey || message.baseUrl !== undefined) {
              const saved = await saveKeyProvider(context, message);
              providerChanged = saved.providerChanged;
              parts.push(saved.status);
              await syncKeyStatus();
            }
            const language = message.reportLanguage === 'en' ? 'en' : 'ru';
            const banner = message.showAuditBanner !== false;
            await config.update('language', language, vscode.ConfigurationTarget.Global);
            await config.update('showAuditBanner', banner, vscode.ConfigurationTarget.Global);
            const links = (message.linksText ?? '').split(/\r?\n/).map((link) => link.trim()).filter(Boolean);
            const maxKb = docLimitsFromKb(message.docMaxKb) / 1024;
            const maxLinks = docLimitsFromCount(message.docMaxLinks);
            const maxLinesRaw = Math.round(Number(message.maxLines));
            const maxLines = Number.isFinite(maxLinesRaw) && maxLinesRaw > 0 ? Math.min(100000, maxLinesRaw) : 0;
            const maxFiles = Math.min(10000, Math.max(1, Math.round(Number(message.maxFiles)) || 100));
            const autoResume = message.autoResume === true;
            const auditScope = (message.auditScope ?? '').trim();
            const auditPasses = auditPassesFromSetting(message.auditPasses);
            const rateLimitPauses = rateLimitPausesFromSetting(message.rateLimitPauses);
            const requestTimeoutSeconds = requestTimeoutSecondsFromSetting(message.requestTimeoutSeconds);
            const autoResumeMaxAttempts = autoResumeLimitFromSetting(message.autoResumeMaxAttempts, 1000);
            const autoResumeMaxMinutes = autoResumeLimitFromSetting(message.autoResumeMaxMinutes, 10000);
            // Батч 27: failover-ручки — выкл по умолчанию; maxCycles 0..100.
            const failoverOn = message.failoverEnabled === true;
            const failoverCyclesRaw = Math.round(Number(message.failoverMaxCycles));
            const failoverCycles = Number.isFinite(failoverCyclesRaw) && failoverCyclesRaw > 0 ? Math.min(100, failoverCyclesRaw) : 0;
            const ui = normalizeUiPrefs({
              theme: message.uiTheme as UiPrefs['theme'],
              accent: message.accentColor as UiPrefs['accent'],
              density: message.uiDensity as UiPrefs['density'],
              fontSize: message.uiFontSize as UiPrefs['fontSize'],
              showConfidence: message.showConfidence !== false,
              findingsSort: message.findingsSort as UiPrefs['findingsSort'],
              reportTheme: message.reportTheme as UiPrefs['reportTheme'],
              customColors: message.customColors
            });
            await config.update('docLinks', links, vscode.ConfigurationTarget.Global);
            await config.update('docMaxKb', maxKb, vscode.ConfigurationTarget.Global);
            await config.update('docMaxLinks', maxLinks, vscode.ConfigurationTarget.Global);
            await config.update('maxLines', maxLines, vscode.ConfigurationTarget.Global);
            await config.update('maxFiles', maxFiles, vscode.ConfigurationTarget.Global);
            await config.update('autoResume', autoResume, vscode.ConfigurationTarget.Global);
            await config.update('autoResumeMaxAttempts', autoResumeMaxAttempts, vscode.ConfigurationTarget.Global);
            await config.update('autoResumeMaxMinutes', autoResumeMaxMinutes, vscode.ConfigurationTarget.Global);
            await config.update('auditScope', auditScope, vscode.ConfigurationTarget.Global);
            await config.update('auditPasses', auditPasses, vscode.ConfigurationTarget.Global);
            await config.update('rateLimitPauses', rateLimitPauses, vscode.ConfigurationTarget.Global);
            await config.update('requestTimeoutSeconds', requestTimeoutSeconds, vscode.ConfigurationTarget.Global);
            await config.update('failover.enabled', failoverOn, vscode.ConfigurationTarget.Global);
            await config.update('failover.maxCycles', failoverCycles, vscode.ConfigurationTarget.Global);
            applyRequestTimeoutSetting();
            await config.update('uiTheme', ui.theme, vscode.ConfigurationTarget.Global);
            await config.update('accentColor', ui.accent, vscode.ConfigurationTarget.Global);
            await config.update('uiDensity', ui.density, vscode.ConfigurationTarget.Global);
            await config.update('uiFontSize', ui.fontSize, vscode.ConfigurationTarget.Global);
            await config.update('showConfidence', ui.showConfidence, vscode.ConfigurationTarget.Global);
            await config.update('findingsSort', ui.findingsSort, vscode.ConfigurationTarget.Global);
            await config.update('reportTheme', ui.reportTheme, vscode.ConfigurationTarget.Global);
            await config.update('customColors', JSON.stringify(ui.customColors), vscode.ConfigurationTarget.Global);
            parts.push(t('center.savedAll', currentReportLanguage(), { p: auditPasses, ml: maxLines === 0 ? '∞' : maxLines, f: maxFiles, ar: t(autoResume ? 'center.autoIn' : 'center.autoOut', currentReportLanguage()), n: links.length, sc: auditScope || t('center.scopeAll', currentReportLanguage()), L: language.toUpperCase(), ui: `${ui.theme}/${ui.accent}/${ui.density}/${ui.fontSize}` }));
            await render(parts.join(' · '));
            await autoSelectModelAfterProviderChange(context, providerChanged);
          } else if (message.command === 'openLink') {
            const url = (message.url ?? '').trim();
            // Батч 18: общий whitelist с панелью (isContactUrlAllowed) —
            // свой репозиторий + почта автора, mailto с ?subject тоже жив.
            if (isContactUrlAllowed(url)) await vscode.env.openExternal(vscode.Uri.parse(url));
            await render('');
          } else if (message.command === 'reportIssue') {
            await vscode.commands.executeCommand('codescout.reportIssue');
            await render('');
          } else if (message.command === 'openRules') {
            try {
              await openOrCreateRules(getWorkspaceRoot());
              await render(t('center.rulesOpened', currentReportLanguage()));
            } catch (error) {
              await render(t('center.error', currentReportLanguage(), { msg: error instanceof Error ? error.message : String(error) }), 'error');
            }
          }
          })().catch((error: unknown) => {
            void render(t('center.error', currentReportLanguage(), { msg: error instanceof Error ? error.message : String(error) }), 'error');
          });
        });
      } else {
        settingsPanel.reveal(vscode.ViewColumn.One);
      }
      await render();
    }),
    vscode.commands.registerCommand('codescout.scanUncommitted', () => { lastScanWasLastCommit = false; lastScanKind = 'review'; return runScan(() => runReview(context, false, output, panel)); }),
    vscode.commands.registerCommand('codescout.scanLastCommit', () => { lastScanWasLastCommit = true; lastScanKind = 'review'; return runScan(() => runReview(context, true, output, panel)); }),
    vscode.commands.registerCommand('codescout.testSample', () => { lastScanKind = 'sample'; return runScan(() => runSampleReview(context, output, panel)); }),
    vscode.commands.registerCommand('codescout.scanFull', () => { lastScanKind = 'audit'; return runScan(() => runFullAudit(context, output, panel)); }),
    vscode.commands.registerCommand('codescout.resumeAudit', () => { lastScanKind = 'audit'; return runScan(() => runFullAudit(context, output, panel, true)); }),
    // Батч 25: «Продолжить другими…» — выбор провайдера/модели (живой список
    // через fetchLiveModelsCached) и догон чекпоинта. Логика выбора — в
    // auditResume.pickResumeTarget, guard скоупа — внутри runFullAuditOnce.
    // Батч 27: есть профили keychain → пикер показывает СПИСОК ПРОФИЛЕЙ
    // (provider · label · model). Выбор догона — разовый маршрут: активный
    // профиль настроек НЕ меняется (oneShotSelectionOverride на время прогона).
    vscode.commands.registerCommand('codescout.resumeAuditOther', async () => {
      const lang = currentReportLanguage();
      const config = vscode.workspace.getConfiguration('codescout');
      const profiles = readProfiles();
      if (profiles.length > 0) {
        const target = await pickResumeProfile({
          lang,
          profiles,
          // Батч 28: резолвим РаБОЧИЙ enabled-ключ профиля (первый не broken);
          // секрет — keychain.<profileId>.<keyId> (+ legacy fallback).
          resolveKeyForProfile: async (profile) => {
            const key = pickActiveKey(profile);
            if (!key) return undefined;
            const secret = await readKeySecret(context.secrets, profile, key);
            const resolved = resolveApiKeyPriority(secret, profile.provider);
            return resolved ? { key: resolved, keyId: key.id, keyLabel: key.label } : undefined;
          },
          resolveBaseUrlFor: async (provider, profileBaseUrl) => resolveBaseUrl(provider, await resolveTrustedBaseUrl(context, config), profileBaseUrl),
          log: (message) => output.appendLine(message)
        });
        if (!target) return undefined;
        // target.baseUrl уже полностью разрешён (profile.baseUrl → глобальный →
        // PROVIDERS) — кладём его в profileBaseUrl, чтобы createProvider/fetchModels
        // не пересчитывали приоритет и не потеряли override профиля.
        // Батч 28: += profileId/keyId/keyLabel — метки чекпоинта при разовом догоне.
        oneShotSelectionOverride = { provider: target.provider, model: target.model, key: target.key, baseUrl: target.baseUrl, profileBaseUrl: target.baseUrl, userChosenModel: true, profileId: target.profile.id, keyId: target.keyId, keyLabel: target.keyLabel };
        output.appendLine(`🔀 Догон профиля: ${target.label}${target.keyLabel ? `/${target.keyLabel}` : ''} (${target.provider} · ${target.model}) — активный профиль настроек не изменён`);
        lastScanKind = 'audit';
        try {
          return await runScan(() => runFullAudit(context, output, panel, true));
        } finally {
          oneShotSelectionOverride = undefined;
        }
      }
      const target = await pickResumeTarget({
        lang,
        resolveKeyFor: async (provider) => resolveApiKeyPriority(await context.secrets.get(SECRET_KEY), provider),
        resolveBaseUrlFor: async (provider) => resolveBaseUrl(provider, await resolveTrustedBaseUrl(context, config)),
        persistSelection: async (provider, model) => {
          await context.secrets.store(SECRET_PROVIDER, provider);
          await context.secrets.store(SECRET_MODEL, model);
          await context.secrets.store(SECRET_MODEL_CHOSEN, 'true');
        },
        log: (message) => output.appendLine(message)
      });
      if (!target) return undefined;
      await syncKeyStatus();
      output.appendLine(`🔀 Догон аудита: ${target.provider} · ${target.model}`);
      lastScanKind = 'audit';
      return runScan(() => runFullAudit(context, output, panel, true));
    }),
    vscode.commands.registerCommand('codescout.restartAudit', async () => {
      const lang = currentReportLanguage();
      const answer = await vscode.window.showWarningMessage(t('restart.confirm', lang), { modal: true }, t('restart.confirmBtn', lang));
      if (answer !== t('restart.confirmBtn', lang)) return;
      const root = getWorkspaceRoot();
      if (root) {
        clearAuditProgress(root);
        clearAuditResults(root);
      }
      panel.setAuditResume(undefined);
      return runScan(() => runFullAudit(context, output, panel));
    }),
    vscode.commands.registerCommand('codescout.customReview', (focus?: string, scope?: string, globs?: string) => {
      lastScanKind = 'custom';
      lastCustomArgs = { focus: focus ?? '', scope: scope ?? 'all', globs: globs ?? '' };
      return runScan(() => runCustomReview(context, output, panel, focus, scope, globs));
    }),
    vscode.commands.registerCommand('codescout.reviewSelection', (uri?: vscode.Uri) => runScan(() => runSelectionReview(context, output, panel, uri))),
    // Батч 15: «Повторить попытку» с карточки ошибки — перезапуск последнего
    // скана того же типа (review/audit/custom/sample), если скан не идёт.
    vscode.commands.registerCommand('codescout.retryScan', () => {
      if (panel.isScanRunning()) return undefined;
      if (lastScanKind === 'audit') return runScan(() => runFullAudit(context, output, panel));
      if (lastScanKind === 'sample') return runScan(() => runSampleReview(context, output, panel));
      if (lastScanKind === 'custom') return runScan(() => runCustomReview(context, output, panel, lastCustomArgs?.focus, lastCustomArgs?.scope, lastCustomArgs?.globs));
      return runScan(() => runReview(context, lastScanWasLastCommit, output, panel));
    }),
    vscode.commands.registerCommand('codescout.resetOnboarding', async () => {
      await context.secrets.delete(SECRET_FULL_AUDIT_WELCOME);
      await context.globalState.update('codescout.onboardingDismissed', undefined);
      panel.setOnboardingHidden(false);
      const workspaceRoot = getWorkspaceRoot();
      if (workspaceRoot && existsSync(join(workspaceRoot, CONTEXT_FILE))) {
        const answer = await vscode.window.showWarningMessage(t('onboarding.resetConfirm', currentReportLanguage()), { modal: true }, t('common.delete', currentReportLanguage()));
        if (answer === t('common.delete', currentReportLanguage())) unlinkSync(join(workspaceRoot, CONTEXT_FILE));
      }
      if (workspaceRoot) panel.setFirstAuditDone(existsSync(join(workspaceRoot, CONTEXT_FILE)));
      if (workspaceRoot) panel.setWelcomeBanner(true, 'new');
      void vscode.window.showInformationMessage(t('onboarding.resetDone', currentReportLanguage()));
    }),
    vscode.commands.registerCommand('codescout.cancelScan', () => {
      autoResumeCancelled = true;
      panel.setAutoResume(undefined);
      activeAbortController?.abort();
      panel.setCancelled();
      output.appendLine('Scan cancelled by user');
      // Батч 26: немедленный баннер догона БЕЗ reload — и в скане, и в паузе
      // авто-догона. Рисуем из живого чекпоинта сразу, не дожидаясь, пока
      // abort дойдёт до catch; catch потом обновит его финальным состоянием.
      if (auditRunActive && liveAuditCheckpoint) {
        const view = progressView(liveAuditCheckpoint, skipBreakerLimitFromSetting(vscode.workspace.getConfiguration('codescout').get<number>('skipBreakerLimit')));
        if (view) panel.setAuditResume(view);
      }
    }),
    vscode.commands.registerCommand('codescout.setApiKey', async () => {
      const lang = currentReportLanguage();
      const key = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true, prompt: t('key.inputPrompt', lang) });
      if (!key?.trim()) return;
      const detected = detectProvider(key);
      // Батч 21, п.2: ambiguous sk- НЕ считаем автодетектом — openai угадан,
      // пользователь обязан подтвердить/выбрать реальную платформу.
      const autoDetected = Boolean(detected && !detected.ambiguous);
      let selection: { provider: ProviderName; model: string } | undefined = autoDetected ? detected ?? undefined : undefined;
      if (detected?.ambiguous) {
        const chosen = await pickSkProvider();
        if (!chosen) return;
        selection = chosen;
      }
      if (!selection) {
        const picked = await vscode.window.showQuickPick([...PROVIDER_ORDER], { placeHolder: t('key.pickProvider', lang) });
        if (!picked) return;
        selection = { provider: picked as ProviderName, model: defaultModel(picked) };
      }
      const validated = await validateDefaultModel(context, { provider: selection.provider, model: selection.model, key: key.trim() });
      selection = { provider: selection.provider, model: validated.model };
      await context.secrets.store(SECRET_KEY, key.trim());
      await context.secrets.store(SECRET_PROVIDER, selection.provider);
      await context.secrets.store(SECRET_MODEL, selection.model);
      await context.secrets.store(SECRET_MODEL_CHOSEN, String(validated.userChosen));
      // Батч 27: если профили уже заведены — быстрый «set API key» обновляет
      // активный профиль (иначе keychain перекроет секреты, и ключ «не применится»).
      const existingProfiles = readProfiles();
      const activeNow = activeProfile(existingProfiles);
      if (activeNow) {
        await storeProfileSecret(context.secrets, activeNow.id, key.trim());
        await writeProfiles(existingProfiles.map((profile) => (profile.id === activeNow.id ? { ...profile, provider: selection.provider, model: selection.model } : profile)));
      }
      panel.setKey(maskApiKey(key.trim()), selection.provider, selection.model);
      const source = autoDetected ? t('key.sourceAuto', lang) : t('key.sourceManual', lang);
      void vscode.window.showInformationMessage(t('key.savedNotify', lang, { p: selection.provider, m: selection.model, s: source }));
    }),
    // P0 Astra-3: выбор модели меняет ТОЛЬКО модель. Отмена = возврат без
    // действия (модель прежняя, запрос не уходит). Сканирование — отдельной
    // кнопкой «Повторить с этой моделью» (codescout.rerunWithModel).
    vscode.commands.registerCommand('codescout.chooseModel', async () => {
      const current = await resolveExtensionSelection(context);
      if (!current.key) {
        void vscode.window.showErrorMessage(t('key.needFirst', currentReportLanguage()));
        return;
      }
      const chosen = await chooseLiveModel(current, t('model.pickTitleShort', currentReportLanguage()));
      if (!chosen) return;
      // Батч 27: модель активного профиля — в профиль, legacy — в секреты.
      await persistModelSelection(context, current, chosen.model, true);
      panel.setKey(maskApiKey(current.key), current.provider, chosen.model);
    }),
    vscode.commands.registerCommand('codescout.rerunWithModel', () => runScan(() => runReview(context, lastScanWasLastCommit, output, panel))),
    vscode.commands.registerCommand('codescout.clearApiKey', async () => {
      const lang = currentReportLanguage();
      const answer = await vscode.window.showWarningMessage(t('key.deleteConfirm', lang), { modal: true }, t('common.delete', lang));
      if (answer !== t('common.delete', lang)) return;
      await context.secrets.delete(SECRET_KEY);
      await context.secrets.delete(SECRET_PROVIDER);
      await context.secrets.delete(SECRET_MODEL);
      await context.secrets.delete(SECRET_MODEL_CHOSEN);
      // Батч 27: «забыть ключ» чистит и keychain: все профили, их секреты, активный id.
      for (const profile of readProfiles()) await deleteProfileSecret(context.secrets, profile.id);
      await writeProfiles([]);
      await writeActiveId('');
      resetRuntime();
      panel.setKey(undefined);
      void vscode.window.showInformationMessage(t('key.deletedNotify', lang));
    }),
    // Батч 27: QuickPick профилей → модалка подтверждения → persist активного.
    vscode.commands.registerCommand('codescout.switchKeyProfile', async () => {
      const lang = currentReportLanguage();
      const profiles = readProfiles();
      if (profiles.length === 0) {
        void vscode.window.showInformationMessage(t('keychain.empty', lang));
        return;
      }
      const activeId = readActiveId();
      const picked = await vscode.window.showQuickPick(
        profiles.map((profile) => ({
          label: profile.label,
          description: `${profile.provider} · ${profile.model?.trim() || defaultModel(profile.provider)}`,
          detail: profile.id === activeId ? t('keychain.activeTag', lang) : '',
          profileId: profile.id
        })),
        { placeHolder: t('keychain.switchPick', lang), ignoreFocusOut: true }
      );
      if (!picked) return;
      const switched = await confirmAndActivateProfile(picked.profileId);
      if (!switched) return;
      await syncKeyStatus();
      const selection = await resolveExtensionSelection(context);
      void vscode.window.showInformationMessage(t('keychain.switchedNotify', lang, { p: selection.provider, m: selection.model }));
    }),
    // Батч 27: «Подождать и продолжить» из баннера — разовое разрешение паузы
    // до пробуждения + перезапуск последнего скана (аудит — с догоном).
    vscode.commands.registerCommand('codescout.failoverWaitResume', () => {
      grantWaitOnce();
      panel.setFailoverSleep(undefined);
      if (panel.isScanRunning()) return undefined;
      if (lastScanKind === 'audit') return runScan(() => runFullAudit(context, output, panel, true));
      if (lastScanKind === 'sample') return runScan(() => runSampleReview(context, output, panel));
      if (lastScanKind === 'custom') return runScan(() => runCustomReview(context, output, panel, lastCustomArgs?.focus, lastCustomArgs?.scope, lastCustomArgs?.globs));
      return runScan(() => runReview(context, lastScanWasLastCommit, output, panel));
    }),
    // Батч 13: мастер первого запуска (облачный/локальный/пропуск).
    // Батч 21: список расширен top-12 zero-config платформами.
    vscode.commands.registerCommand('codescout.onboardCloud', async () => {
      const lang = currentReportLanguage();
      const picked = await vscode.window.showQuickPick(Object.keys(WIZARD_PROVIDER_LABELS), { placeHolder: t('wizard.cloudProvider', lang), ignoreFocusOut: true });
      if (!picked) return;
      const providerName = WIZARD_PROVIDER_LABELS[picked];
      const key = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true, prompt: t('wizard.keyPrompt', lang) });
      if (!key?.trim()) { void vscode.window.showErrorMessage(t('key.needFirst', lang)); return; }
      const trimmed = key.trim();
      // Батч 21, п.2: в мастере пользователь УЖЕ выбрал платформу списком —
      // неоднозначное sk- не перебивает этот выбор (без отдельного меню).
      const auto = detectProvider(trimmed);
      const det = auto && !auto.ambiguous ? auto : { provider: providerName, model: defaultModel(providerName) };
      let baseUrl = '';
      if (providerName === 'custom') {
        baseUrl = (await vscode.window.showInputBox({ prompt: t('wizard.urlPrompt', lang), value: 'http://localhost:11434/v1', ignoreFocusOut: true }))?.trim() || '';
        if (!baseUrl) { void vscode.window.showErrorMessage(t('wizard.urlPrompt', lang)); return; }
      }
      // Тест подключения (строгий: tolerateErrors=false — мастер обязан
      // показать реальную ошибку авторизации, а не «подключено 0 моделей»).
      const testSelection = { provider: det.provider, model: det.model, key: trimmed, baseUrl, userChosenModel: false };
      try {
        const models = await fetchModels(testSelection, false);
        const chosenModel = preferredLiveModel(models, det.model);
        // Батч 27.1, п.2: онбординг пишет в keychain — профиль «onboarded».
        // При непустом keychain legacy-слот НЕ трогается вообще; при пустом
        // legacy-слот заполняется как раньше (откат/совместимость) и тут же
        // создаётся профиль — миграция legacy→default остаётся одноразовой.
        const keychainWasEmpty = readProfiles().length === 0;
        await upsertOnboardedProfile(context.secrets, { provider: det.provider, model: chosenModel, key: trimmed, ...(baseUrl ? { baseUrl } : {}) });
        if (keychainWasEmpty) {
          await context.secrets.store(SECRET_KEY, trimmed);
          await context.secrets.store(SECRET_PROVIDER, det.provider);
          await context.secrets.store(SECRET_MODEL, chosenModel);
          await context.secrets.store(SECRET_MODEL_CHOSEN, 'true');
        }
        clearModelsCache();
        await context.globalState.update('codescout.onboardingDismissed', true);
        panel.setOnboardingHidden(true);
        panel.setKey(maskApiKey(trimmed), det.provider, chosenModel);
        void vscode.window.showInformationMessage(`${t('center.connected', lang, { n: models.length })}`);
      } catch (error) {
        const formatted = formatError(error, lang);
        void vscode.window.showErrorMessage(`CodeScout: ${formatted.title} — ${formatted.message}`);
      }
    }),
    vscode.commands.registerCommand('codescout.onboardLocal', async () => {
      const lang = currentReportLanguage();
      const kind = await vscode.window.showQuickPick(['Ollama', 'LM Studio'], { placeHolder: t('wizard.localPick', lang) });
      if (!kind) return;
      const defaultUrl = kind === 'Ollama' ? 'http://localhost:11434' : 'http://localhost:1234';
      const url = (await vscode.window.showInputBox({ prompt: t('wizard.urlPrompt', lang), value: defaultUrl, ignoreFocusOut: true }))?.trim();
      if (!url) return;
      const probe = await probeLocalServer(url);
      if (!probe.ok) {
        const retry = await vscode.window.showWarningMessage(t('wizard.localFail', lang, { n: 0 }), { modal: false }, t('wizard.retry', lang));
        if (retry === t('wizard.retry', lang)) { vscode.commands.executeCommand('codescout.onboardLocal'); }
        return;
      }
      const localModel = probe.models[0] || defaultModel('custom');
      // Батч 27.1, п.2: локальный мастер тоже пишет в keychain — профиль
      // «onboarded» (custom + baseUrl пробы). Legacy-настройки и legacy-секрет
      // модели обновляются только при пустом keychain.
      const keychainWasEmpty = readProfiles().length === 0;
      await upsertOnboardedProfile(context.secrets, { provider: 'custom', model: localModel, key: '', baseUrl: probe.baseUrl });
      if (keychainWasEmpty) {
        await vscode.workspace.getConfiguration('codescout').update('provider', 'custom', vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration('codescout').update('baseUrl', probe.baseUrl, vscode.ConfigurationTarget.Global);
        await context.secrets.store(SECRET_MODEL, localModel);
        await context.secrets.store(SECRET_MODEL_CHOSEN, 'true');
      }
      clearModelsCache();
      await context.globalState.update('codescout.onboardingDismissed', true);
      panel.setOnboardingHidden(true);
      panel.setKey(true, 'custom', localModel);
      void vscode.window.showInformationMessage(t('wizard.localSuccess', lang, { n: probe.models.length }));
    }),
    vscode.commands.registerCommand('codescout.onboardSkip', async () => {
      await context.globalState.update('codescout.onboardingDismissed', true);
      panel.setOnboardingHidden(true);
      void vscode.commands.executeCommand('codescout.openSettingsPage');
    }),
    // Батч 13, п.3: тест подключения в центре настроек.
    vscode.commands.registerCommand('codescout.testConnection', async () => {
      const result = await runConnectionTest(context);
      void (result.ok ? vscode.window.showInformationMessage(result.message) : vscode.window.showErrorMessage(result.message));
    }),
  );
  void (async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const projectContext = readProjectContext(workspaceRoot);
    const selection = await resolveExtensionSelection(context);
    const choiceStored = (await context.secrets.get(SECRET_FULL_AUDIT_WELCOME)) === 'true';
    const stale = Boolean(projectContext?.auditMeta && (projectContext.auditMeta.provider !== selection.provider || projectContext.auditMeta.model !== selection.model));
    const savedCheckpoint = readAuditProgress(workspaceRoot);
    // Батч 26: breaker-подсказку в баннере пересчитываем по хвосту skippedFiles
    // — после reload она не теряется (порог = codescout.skipBreakerLimit).
    const savedBreakerLimit = skipBreakerLimitFromSetting(vscode.workspace.getConfiguration('codescout').get<number>('skipBreakerLimit'));
    const savedProgress = progressView(savedCheckpoint, savedBreakerLimit);
    const savedResults = readAuditResults(workspaceRoot);
    if (savedResults) {
      const complete = savedResults.checkedFiles >= savedResults.total;
      // Батч 26: чекпоинт приоритетнее «полноты» результатов: если он есть —
      // баннер догона показываем всегда; при 0 проверенных файлов количество
      // находок в баннере берём из last-good результатов (находки не затираются).
      const resume = savedProgress ?? (complete ? undefined : { done: savedResults.checkedFiles, total: savedResults.total, model: savedResults.model, startedAt: savedResults.updatedAt, findings: savedResults.findings.length });
      if (savedProgress && savedProgress.done === 0 && savedResults.findings.length > 0 && (savedProgress.findings ?? 0) === 0) {
        savedProgress.findings = savedResults.findings.length;
      }
      const elapsedMs = savedCheckpoint && savedResults.updatedAt > savedCheckpoint.startedAt ? savedResults.updatedAt - savedCheckpoint.startedAt : 0;
      const visibleFindings = filterSuppressed(savedResults.findings, context.workspaceState);
      panel.restoreAuditResults(visibleFindings, buildStats(visibleFindings, savedResults.checkedFiles, elapsedMs), resume);
    } else if (savedProgress) panel.setAuditResume(savedProgress);
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
