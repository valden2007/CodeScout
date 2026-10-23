// Батч 25: возобновление аудита другим провайдером после ЛЮБОЙ остановки.
// Здесь живёт всё, что связано с догоном: scopeHash (git HEAD + список
// файлов), вердикт guard'а скоупа и выбор «другого» провайдера/модели через
// QuickPick с живым списком моделей (fetchLiveModelsCached). extension.ts
// только подключает эти функции — сам файл не раздувается.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { defaultModel, fetchLiveModelsCached, isLocalBaseUrl, MODELS_FETCH_TIMEOUT_MS, PROVIDER_ORDER, resolveBaseUrl, sanitizeApiKey, type ProviderName } from '../../src/providers';
import { t, type Lang } from '../../src/i18n';
import type { AuditCheckpoint } from './projectAudit';

// Git опрашивается максимум N мс — зависший репозиторий не блокирует аудит.
export const GIT_HEAD_PROBE_TIMEOUT_MS = 5000;

function pathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// HEAD репозитория Workspace'а; '' если git нет, это не репозиторий,
// корень не совпал (родительский repo не считается) или sha не похож на sha.
export function getGitHead(workspaceRoot: string): string {
  try {
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: workspaceRoot, encoding: 'utf8', timeout: GIT_HEAD_PROBE_TIMEOUT_MS, windowsHide: true });
    if (top.status !== 0) return '';
    const topPath = String(top.stdout ?? '').trim();
    if (!topPath || pathKey(topPath) !== pathKey(workspaceRoot)) return '';
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8', timeout: GIT_HEAD_PROBE_TIMEOUT_MS, windowsHide: true });
    if (head.status !== 0) return '';
    const sha = String(head.stdout ?? '').trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : '';
  } catch {
    return '';
  }
}

// scopeHash = git HEAD + отсортированный дедуплицированный список файлов
// плана аудита. Один и тот же план + тот же HEAD → тот же hash; любой
// сдвиг (новый файл, удаление, коммит) → другой hash.
export function computeScopeHash(head: string, files: readonly string[]): string {
  const list = [...new Set(files.map((file) => file.replace(/\\/g, '/')))].sort();
  return createHash('sha256').update(`head:${head}\nfiles:\n${list.join('\n')}\n`, 'utf8').digest('hex').slice(0, 16);
}

export type ScopeVerdict = 'ok' | 'changed' | 'untracked';

// untracked = чекпоинт до батча 25 (без scopeHash): не блокируем, догон
// разрешён, hash проставится при ближайшей записи чекпоинта.
export function checkpointScopeVerdict(progress: Pick<AuditCheckpoint, 'scopeHash'> | undefined, currentHash: string): ScopeVerdict {
  if (!progress?.scopeHash) return 'untracked';
  return progress.scopeHash === currentHash ? 'ok' : 'changed';
}

export interface ResumePickerDeps {
  lang: Lang;
  // Ключ для выбранного провайдера: SecretStorage (тот же путь, что у
  // resolveExtensionSelection) > env-ключ провайдера. undefined = нет ключа.
  resolveKeyFor(provider: ProviderName): Promise<string | undefined>;
  // Base URL провайдера с учетом P0 Astra-1 (workspace-URL требует доверия).
  resolveBaseUrlFor(provider: ProviderName): Promise<string>;
  // Сохранить выбор в SecretStorage, чтобы догон пошёл этим стеком.
  persistSelection(provider: ProviderName, model: string): Promise<void>;
  log(message: string): void;
}

// «Продолжить другими…»: QuickPick провайдеров → живой список моделей →
// persist. Отмена на любом шаге = undefined (ничего не меняем, P0 Astra-3).
export async function pickResumeTarget(deps: ResumePickerDeps): Promise<{ provider: ProviderName; model: string } | undefined> {
  const pickedProvider = await vscode.window.showQuickPick([...PROVIDER_ORDER], { placeHolder: t('key.pickProvider', deps.lang), ignoreFocusOut: true });
  if (!pickedProvider) return undefined;
  const provider = pickedProvider as ProviderName;
  let baseUrl = '';
  try {
    baseUrl = await deps.resolveBaseUrlFor(provider);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`CodeScout: ${message}`);
    return undefined;
  }
  const key = await deps.resolveKeyFor(provider);
  if (!key && !isLocalBaseUrl(baseUrl)) {
    void vscode.window.showErrorMessage(t('key.needFirst', deps.lang));
    return undefined;
  }
  let models: string[] = [];
  try {
    models = await fetchLiveModelsCached(baseUrl, sanitizeApiKey(key ?? ''), fetch, MODELS_FETCH_TIMEOUT_MS, provider, deps.log, true, deps.log);
  } catch (error) {
    deps.log(`⚠️ ${provider} /models недоступен: ${error instanceof Error ? error.message : String(error)}`);
  }
  let model = '';
  if (models.length > 0) {
    const preferred = models.find((candidate) => /instruct|coder/i.test(candidate)) || models[0];
    const picked = await vscode.window.showQuickPick([preferred, ...models.filter((candidate) => candidate !== preferred)], { placeHolder: t('model.pickTitle', deps.lang), ignoreFocusOut: true });
    if (!picked) return undefined;
    model = String(picked);
  } else {
    const manual = await vscode.window.showInputBox({ prompt: t('model.inputEmpty', deps.lang), value: defaultModel(provider), ignoreFocusOut: true });
    if (manual === undefined) return undefined;
    model = manual.trim() || defaultModel(provider);
  }
  await deps.persistSelection(provider, model);
  return { provider, model };
}
