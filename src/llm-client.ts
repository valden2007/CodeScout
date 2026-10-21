import { randomUUID } from 'node:crypto';
import { LLMProvider } from './types';
import { completionUrl, normalizeProvider, resolveBaseUrl } from './providers';

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

export function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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

function parseRetryAfterSeconds(response: Response, message: string): number | undefined {
  const header = response.headers.get('retry-after');
  if (header) {
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
  private readonly endpoint: string;
  // Батч 17.5: UUID живёт всю жизнь клиента — все запросы одного аудита
  // идут с одним x-opencode-session (скоррелированные логи на стороне шлюза).
  readonly sessionId: string = randomUUID();

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleeper: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
    private readonly onRetry?: (event: RetryEvent) => void,
    baseUrl = 'https://api.groq.com/openai/v1',
    private readonly signal?: AbortSignal,
    private readonly requestTimeoutMs?: number
  ) {
    this.endpoint = completionUrl(baseUrl);
  }

  async review(systemPrompt: string, userPrompt: string): Promise<string> {
    const wait = 2000 - (Date.now() - this.lastRequestAt);
    if (wait > 0) await this.sleeper(wait, this.signal);
    let retryCount = 0;
    let lastRateLimit: { waitSeconds?: number; details: string } | undefined;

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
          throw new Error(details);
        }
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new BadResponseError('Модель вернула некорректный формат: пустой ответ', text.trim().slice(0, 300));
        return content;
      } catch (error) {
        if (timedOut && !this.signal?.aborted) throw new RequestTimeoutError(timeoutMs);
        if (isAbortError(error)) throw error;
        if (!(error instanceof RateLimitError)) throw error;
        lastRateLimit = { waitSeconds: error.waitSeconds, details: error.details };
        if (retryCount >= RETRY_DELAYS_SECONDS.length) {
          throw new RateLimitError(finalRateLimitMessage(this.model, lastRateLimit.waitSeconds));
        }
        retryCount += 1;
        const serverWait = lastRateLimit.waitSeconds ?? 0;
        const waitSeconds = Math.max(RETRY_DELAYS_SECONDS[retryCount - 1], serverWait);
        this.onRetry?.({ attempt: retryCount, maxRetries: RETRY_DELAYS_SECONDS.length, waitSeconds });
        await this.sleeper(waitSeconds * 1000, this.signal);
      } finally {
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', relayAbort);
      }
    }
  }
}

export { OpenAICompatibleProvider as GroqProvider };

export function createProvider(provider: string, apiKey: string, model: string, onRetry?: (event: RetryEvent) => void, baseUrl?: string, signal?: AbortSignal): LLMProvider {
  const normalized = normalizeProvider(provider);
  const resolvedBaseUrl = resolveBaseUrl(normalized, baseUrl);
  return new OpenAICompatibleProvider(apiKey, model, fetch, sleep, onRetry, resolvedBaseUrl, signal);
}
