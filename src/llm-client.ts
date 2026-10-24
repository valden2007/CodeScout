import { randomUUID } from 'node:crypto';
import { LLMProvider } from './types';
import { completionUrl, normalizeProvider, resolveBaseUrl, sanitizeApiKey } from './providers';

interface GroqResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

// Батч 17.5: идентификация клиента OpenCode Go + контракт совместимости
// сессий: один стабильный x-opencode-session на экземпляр клиента (= на
// один аудит), User-Agent версии продукта.
export const USER_AGENT = 'CodeScout/1.5.0';

export function isRedirectStatus(status: number): boolean {
  return (status >= 300 && status < 400) || status === 0;
}

export interface RetryEvent {
  attempt: number;
  maxRetries: number;
  waitSeconds: number;
}

export class RateLimitError extends Error {
  readonly waitSeconds?: number;
  readonly details: string;

  constructor(message: string, waitSeconds?: number, details = '') {
    super(message);
    this.name = 'RateLimitError';
    this.waitSeconds = waitSeconds;
    this.details = details;
  }
}

// Батч 27: цепочка профилей исчерпана (все спят, автономный режим выключен
// или достигнут потолок циклов) — failover-решатель в keychain говорит
// «стоп», клиент бросает этот маркер вместо бесконечной ротации. Scan-level
// код превращает его в баннер «Подождать и продолжить / Стоп».
export class AllProfilesAsleepError extends Error {
  readonly waitMs: number;
  readonly wakeLabel: string;

  constructor(message: string, waitMs = 0, wakeLabel = '') {
    super(message);
    this.name = 'AllProfilesAsleepError';
    this.waitMs = waitMs;
    this.wakeLabel = wakeLabel;
  }
}

// Failover-хуки (батч 27): retry-слой спрашивает keychain при 429 и
// 401/403. Реализацию даёт расширение (extension/src/keychain.ts);
// llm-client не знает ни про профили, ни про SecretStorage — только
// переключает креды по решению хука.
export interface FailoverSwitchResult {
  action: 'switch';
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface FailoverWaitResult {
  action: 'wait';
  waitMs: number;
}

export interface FailoverStopResult {
  action: 'stop';
  waitMs: number;
  wakeLabel: string;
}

export type FailoverSwitchDecision = FailoverSwitchResult | FailoverWaitResult | FailoverStopResult;

export interface FailoverHooks {
  // Вызывается при каждом 429 (RateLimitError) ДО локальной лестницы ретраев.
  // waitSeconds — retry-after из ответа (если парсится).
  onRateLimit(waitSeconds: number | undefined): Promise<FailoverSwitchDecision | undefined>;
  // 401/403: пометить профиль broken. Возврат не используется — переключение
  // по auth-ошибке запрещено контрактом.
  onAuthError(status: number): Promise<void>;
}

export function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (error instanceof RequestTimeoutError) return true;
  if (error instanceof ProviderHttpError) {
    return error.status === 502 || error.status === 503 || error.status === 504;
  }
  if (isAbortError(error)) return true;
  const raw = error instanceof Error ? error.message : String(error);
  return /ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|ENETDOWN|ENETUNREACH|EHOSTUNREACH|getaddrinfo|fetch failed|network|no such host|Could not connect/i.test(raw);
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortError()); return; }
  const onAbort = (): void => { clearTimeout(timer); reject(abortError()); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});
export { sleep };
// Батч 17 «Ночной аудит»: адаптивная экспоненциальная пауза (лестница
// 30с → 60с → 120с) на 429 Rate Limit. Максимум 3 ретрая = 4 попытки на
// чанк/файл. Раньше (15/30/60) бесплатные модели (minimax-free, beam-free)
// успевали исчерпать бакет между попытками, и чанк улетал в скип; лестница
// медленнее, но гарантированно доедает проект за ночь без пропуска файлов.
export const RETRY_DELAYS_SECONDS = [30, 60, 120];

// Батч 27: помимо retry-after парсим заголовки сброса квоты, которые отдают
// OpenAI-совместимые агрегаторы: x-ratelimit-reset(-requests/-tokens) —
// секунды (часто дробные) до сброса окна. Первый найденный валидный — в дело.
const QUOTA_RESET_HEADERS = ['retry-after', 'x-ratelimit-reset', 'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens'];

function parseRetryAfterSeconds(response: Response, message: string): number | undefined {
  for (const name of QUOTA_RESET_HEADERS) {
    const header = response.headers.get(name);
    if (!header) continue;
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const date = new Date(header);
    if (!Number.isNaN(date.getTime())) return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
  }
  const match = message.match(/try\s+again\s+in\s+(\d+(?:\.\d+)?)\s*s?/i);
  if (match) return Math.ceil(Number.parseFloat(match[1]));
  return undefined;
}

function notFoundMessage(model: string): string {
  return `⚠️ 404: эндпоинт или модель ${model} не найдены. Проверь provider/model.`;
}

// Батч 13, п.4: лимит больше не описывается всегда как «tokens per day» —
// точная причина остаётся в details, UI показывает категорию «Лимит провайдера».
function finalRateLimitMessage(model: string, waitSeconds?: number): string {
  const wait = waitSeconds ?? 60;
  return `⚠️ Превышен лимит модели ${model}.\nПовторите через ${wait} сек или используйте другую модель.`;
}

// Категории ошибок для UI (батч 13, п.4): понятная причина + техническая
// диагностика в раскрывающемся блоке.
export type FriendlyErrorKind = 'auth' | 'notFound' | 'rateLimit' | 'timeout' | 'badResponse' | 'other';

// HTTP-статус от провайдера (401/403/404/429/…): дальше не ретраится,
// но классифицируется по статусу.
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly details: string;

  constructor(status: number, message: string, details = '') {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.details = details;
  }
}

// Модель отдала не-JSON (HTML-страницу прокси/гейта) или пустой content.
export class BadResponseError extends Error {
  readonly details: string;

  constructor(message: string, details = '') {
    super(message);
    this.name = 'BadResponseError';
    this.details = details;
  }
}

// Батч 15: жёсткий дедлайн на HTTP-запрос инференса — зависший провайдер
// не должен вешать скан навсегда. Категория — timeout (см. error-classifier).
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms: the provider did not respond`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export const REQUEST_TIMEOUT_DEFAULT_SECONDS = 60;
export const REQUEST_TIMEOUT_MIN_SECONDS = 10;
export const REQUEST_TIMEOUT_MAX_SECONDS = 600;

export function requestTimeoutSecondsFromSetting(value: unknown): number {
  const n = Math.round(Number(value));
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return REQUEST_TIMEOUT_DEFAULT_SECONDS;
  return Math.min(REQUEST_TIMEOUT_MAX_SECONDS, Math.max(REQUEST_TIMEOUT_MIN_SECONDS, n));
}

// Модульный дефолт: расширение выставляет его из codescout.requestTimeoutSeconds
// (applyRequestTimeout), CLI/action/env остаются на 60с. read в момент review(),
// чтобы смена настройки действовала без пересоздания провайдера.
let defaultRequestTimeoutMs = requestTimeoutSecondsFromSetting(process.env.CODESCOUT_REQUEST_TIMEOUT_SECONDS || '') * 1000;

export function setDefaultRequestTimeoutMs(ms: number): void {
  const n = Math.round(Number(ms));
  defaultRequestTimeoutMs = Number.isFinite(n) && n >= 1000 ? Math.min(REQUEST_TIMEOUT_MAX_SECONDS * 1000, n) : REQUEST_TIMEOUT_DEFAULT_SECONDS * 1000;
}

export function getDefaultRequestTimeoutMs(): number {
  return defaultRequestTimeoutMs;
}

export interface FriendlyError {
  kind: FriendlyErrorKind;
  title: string;
  details?: string;
  waitSeconds?: number;
}

function isTimeoutError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const msg = error instanceof Error ? error.message : String(error);
  return name === 'TimeoutError' || /ETIMEDOUT|socket hang up|timed?\s*out|EAI_AGAIN/i.test(msg);
}

export function classifyError(error: unknown): FriendlyError {
  const raw = error instanceof Error ? error.message : String(error);
  if (error instanceof RateLimitError) return { kind: 'rateLimit', title: raw, details: error.details || raw, waitSeconds: error.waitSeconds };
  if (error instanceof ProviderHttpError) {
    if (error.status === 401 || error.status === 403) return { kind: 'auth', title: raw, details: error.details };
    if (error.status === 404) return { kind: 'notFound', title: raw, details: error.details };
    if (error.status === 429) return { kind: 'rateLimit', title: raw, details: error.details };
    return { kind: 'other', title: raw, details: error.details };
  }
  if (error instanceof BadResponseError) return { kind: 'badResponse', title: raw, details: error.details };
  if (isTimeoutError(error)) return { kind: 'timeout', title: raw, details: raw };
  return { kind: 'other', title: raw, details: undefined };
}

export class OpenAICompatibleProvider implements LLMProvider {
  private lastRequestAt = 0;
  private endpoint: string;
  // Батч 17.5: UUID живёт всю жизнь клиента — все запросы одного аудита
  // идут с одним x-opencode-session (скоррелированные логи на стороне шлюза).
  readonly sessionId: string = randomUUID();

  constructor(
    private apiKey: string,
    private model: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleeper: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
    private readonly onRetry?: (event: RetryEvent) => void,
    baseUrl = 'https://api.groq.com/openai/v1',
    private readonly signal?: AbortSignal,
    private readonly requestTimeoutMs?: number,
    // Батч 27: failover-хуки keychain (429 → switch/wait/stop, 401/403 →
    // broken). undefined = поведение не меняется вообще (legacy-контракт).
    private readonly failover?: FailoverHooks
  ) {
    // Батч 22, п.2: ключ санитизируется в ОДНОЙ точке (providers.sanitizeApiKey)
    // и здесь, и в /models — review-запросы и список моделей ведут себя одинаково.
    this.apiKey = sanitizeApiKey(apiKey);
    this.endpoint = completionUrl(baseUrl);
  }

  async review(systemPrompt: string, userPrompt: string): Promise<string> {
    const wait = 2000 - (Date.now() - this.lastRequestAt);
    if (wait > 0) await this.sleeper(wait, this.signal);
    let retryCount = 0;
    let lastRetryableError: { waitSeconds?: number; details: string } | undefined;

    while (true) {
      if (this.signal?.aborted) throw abortError();
      this.lastRequestAt = Date.now();
      // Батч 15: дедлайн на попытку. Отдельный controller: пользовательский
      // cancel и таймер сливаются в него, но RequestTimeoutError бросаем
      // только когда оборвал таймер (external abort = AbortError как раньше).
      const timeoutMs = this.requestTimeoutMs ?? getDefaultRequestTimeoutMs();
      const deadline = new AbortController();
      let timedOut = false;
      const relayAbort = (): void => { deadline.abort(); };
      const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, timeoutMs);
      if (this.signal) {
        if (this.signal.aborted) deadline.abort();
        else this.signal.addEventListener('abort', relayAbort, { once: true });
      }
      try {
        const response = await this.fetcher(this.endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, 'x-opencode-session': this.sessionId },
          body: JSON.stringify({ model: this.model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }),
          signal: deadline.signal,
          // Батч 17.5 (SSRF): никаких автоматических 301/302 переходов —
          // вредоносный Base URL не может перенаправить запрос с API-ключом
          // на внутренние метаданные облака (169.254.169.254 и т.п.).
          redirect: 'manual'
        });
        const text = await response.text();
        clearTimeout(timer);
        // Редирект = жёсткий отказ: ключ/промпт не уходят по Location,
        // перенаправление не разыгрывается ни в одной из попыток ретрая.
        if ((response as { type?: string }).type === 'opaqueredirect' || isRedirectStatus(response.status)) {
          const target = response.headers.get('location') || 'скрыт';
          throw new ProviderHttpError(response.status || 302, `⛔ SSRF-защита: редирект ${response.status} на ${target} запрещён — редиректы не отслеживаются`, `redirect=${response.status} → ${target}`);
        }
        let data: GroqResponse = {};
        try {
          data = JSON.parse(text) as GroqResponse;
        } catch {
          // не-JSON (HTML-страница ошибки прокси/гейта) — разберёмся ниже по статусу
        }
        if (!response.ok) {
          const details = data.error?.message || (text.trim().slice(0, 300) || `LLM request failed with ${response.status}`);
          if (response.status === 429) {
            const waitSeconds = parseRetryAfterSeconds(response, details);
            throw new RateLimitError(`Rate limited by ${this.model}: ${details}`, waitSeconds, details);
          }
          if (response.status === 404) throw new ProviderHttpError(404, notFoundMessage(this.model), details);
          // Категория «Ключ отклонён или нет доступа» (батч 13, п.4)
          if (response.status === 401 || response.status === 403) throw new ProviderHttpError(response.status, `${response.status}: ${details}`, details);
          // 502/503/504 — ретраим как 429
          if (response.status === 502 || response.status === 503 || response.status === 504) {
            throw new ProviderHttpError(response.status, `${response.status}: ${details}`, details);
          }
          throw new Error(details);
        }
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new BadResponseError('Модель вернула некорректный формат: пустой ответ', text.trim().slice(0, 300));
        return content;
      } catch (error) {
        // Определяем, является ли ошибка ретрайбл
        let retryableError: Error | undefined;
        if (timedOut && !this.signal?.aborted) {
          retryableError = new RequestTimeoutError(timeoutMs);
        } else if (isAbortError(error)) {
          // Пользовательский abort (Cancel) — не ретраим
          if (this.signal?.aborted) throw error;
          // AbortError от fetcher (сетевой таймаут/обрыв) — ретраим
          retryableError = new RequestTimeoutError(timeoutMs);
        } else if (isRetryableError(error)) {
          retryableError = error instanceof Error ? error : new Error(String(error));
        }
        if (!retryableError) {
          // Батч 27: 401/403 — помечаем профиль broken (автопереход запрещён,
          // ошибка летит наверх как раньше).
          if (this.failover && error instanceof ProviderHttpError && (error.status === 401 || error.status === 403)) {
            await this.failover.onAuthError(error.status);
          }
          throw error;
        }
        // Батч 27: ТОЛЬКО rate_limit/quota (429 → RateLimitError) спрашивает
        // keychain до локальной лестницы: switch — пересобираем креды и
        // пробуем тем же запросом; wait — спим до ближайшего пробуждения;
        // stop — AllProfilesAsleepError (баннер рисует scan-level);
        // undefined — прежнее поведение (failover выключен).
        if (this.failover && retryableError instanceof RateLimitError) {
          const decision = await this.failover.onRateLimit(retryableError.waitSeconds ?? undefined);
          if (decision) {
            if (decision.action === 'switch') {
              this.apiKey = sanitizeApiKey(decision.apiKey);
              this.endpoint = completionUrl(decision.baseUrl);
              this.model = decision.model;
              retryCount = 0;
              lastRetryableError = undefined;
              continue;
            }
            if (decision.action === 'wait') {
              await this.sleeper(decision.waitMs, this.signal);
              continue;
            }
            if (decision.action === 'stop') {
              throw new AllProfilesAsleepError('All key profiles are asleep (rate limit)', decision.waitMs, decision.wakeLabel);
            }
          }
        }
        // Ретраим: RateLimitError, RequestTimeoutError, ProviderHttpError 502/503/504, сетевые ошибки
        const waitSeconds = retryableError instanceof RateLimitError ? retryableError.waitSeconds : undefined;
        const details = retryableError instanceof RateLimitError ? retryableError.details
          : retryableError instanceof ProviderHttpError ? retryableError.details
          : retryableError instanceof RequestTimeoutError ? `timeout ${timeoutMs}ms`
          : retryableError.message;
        lastRetryableError = { waitSeconds, details };
        if (retryCount >= RETRY_DELAYS_SECONDS.length) {
          // Батч 18.7: финальный waitSeconds не может быть undefined — у
          // сетевых/таймаутных ретраев серверной подсказки нет, подставляем
          // верхнюю ступень лестницы, чтобы UI не печатал «undefinedс».
          const finalWaitSeconds = lastRetryableError.waitSeconds ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1];
          throw new RateLimitError(finalRateLimitMessage(this.model, finalWaitSeconds), finalWaitSeconds, lastRetryableError.details);
        }
        retryCount += 1;
        const serverWait = lastRetryableError.waitSeconds ?? 0;
        const waitSec = Math.max(RETRY_DELAYS_SECONDS[retryCount - 1], serverWait);
        this.onRetry?.({ attempt: retryCount, maxRetries: RETRY_DELAYS_SECONDS.length, waitSeconds: waitSec });
        await this.sleeper(waitSec * 1000, this.signal);
      } finally {
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', relayAbort);
      }
    }
  }
}

export { OpenAICompatibleProvider as GroqProvider };

// Батч 27.1, п.1: profileBaseUrl — overrides профиля keychain; приоритет
// резолва: profileBaseUrl → baseUrl (codescout.baseUrl, только custom/local)
// → PROVIDERS[provider].baseUrl (реализация — providers.resolveBaseUrl).
export function createProvider(provider: string, apiKey: string, model: string, onRetry?: (event: RetryEvent) => void, baseUrl?: string, signal?: AbortSignal, failover?: FailoverHooks, profileBaseUrl?: string): LLMProvider {
  const normalized = normalizeProvider(provider);
  const resolvedBaseUrl = resolveBaseUrl(normalized, baseUrl, profileBaseUrl);
  return new OpenAICompatibleProvider(apiKey, model, fetch, sleep, onRetry, resolvedBaseUrl, signal, undefined, failover);
}
