// Батч 15: категоризация ошибок провайдеров для UI. extension.ts/panel.ts
// получают готовую структуру (title + понятный message + actionHint), «сырое»
// сообщение уходит только в rawMessage (Output после redactSecrets).
import { BadResponseError, ProviderHttpError, RateLimitError } from './llm-client';
import { t, type Lang } from './i18n';

export type ErrorCategory =
  | 'auth_invalid_key'
  | 'auth_forbidden'
  | 'rate_limit_exceeded'
  // Микро-батч 28.4/28.9: 'quota' — ОГРАНИЧЕНИЕ ОКНА (HTTP 429 с retry-after /
  // «resets in …» / daily/hourly-текстами): сон ключа и циклы догона 28.6
  // помогают. Деньги — отдельная категория 'billing' ниже.
  | 'quota'
  // МИКРО-БАТЧ 28.9: «стена тарифа» — HTTP 402, insufficient_credits/credits/
  // billing, «upgrade to … Tier», «model requires paid/flash tier». Сон НЕ
  // поможет: ключ выводится из ротации как broken, нужен баланс/смена модели.
  | 'billing'
  | 'model_not_found'
  | 'timeout'
  | 'connection_refused'
  | 'invalid_json'
  | 'unknown';

export interface FormattedError {
  category: ErrorCategory;
  title: string;
  message: string;
  actionHint?: string;
  rawMessage?: string;
}

export const ERROR_CATEGORIES: ErrorCategory[] = ['auth_invalid_key', 'auth_forbidden', 'rate_limit_exceeded', 'quota', 'billing', 'model_not_found', 'timeout', 'connection_refused', 'invalid_json', 'unknown'];

const PROBE_TIMEOUT_FALLBACK_SECONDS = 5;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

function isTimeoutShape(error: unknown, raw: string): boolean {
  if (nameOf(error) === 'TimeoutError') return true;
  return /ETIMEDOUT|socket hang up|timed?\s*out|aborted due to timeout|EAI_AGAIN/i.test(raw);
}

// Стек вызова парсера (src/response-parser) и BadResponseError — «битый JSON».
function isJsonFailure(raw: string): boolean {
  return /malformed JSON|JSON null|JSON-массив|не JSON-объект|ожидается объект|Unexpected end of JSON|Unexpected token|invalid JSON|not valid JSON/i.test(raw);
}

function isConnectionFailure(raw: string): boolean {
  return /ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|ENETDOWN|ENETUNREACH|EHOSTUNREACH|getaddrinfo|fetch failed|network|no such host|Could not connect/i.test(raw);
}

function statusFromText(raw: string): number | undefined {
  const match = raw.match(/\b(?:HTTP|status|error)[^\d]{0,12}(40[1-4]|429)\b/i) || raw.match(/^(40[1-4]|429)\b/);
  return match ? Number(match[1]) : undefined;
}

// МИКРО-БАТЧ 28.9: стена тарифа. groq/openrouter отдают её как HTTP 402
// и/или тексты «insufficient_quota», «insufficient credits», «billing»,
// «Upgrade to … Tier», «model requires paid/flash tier». Проверяется ДО
// rate-limit-текста: в биллинг-сообщениях мелькают «quota»/«rate limit»,
// но смысл — деньги: сон и циклы не помогут, ключ выводится из ротации.
const BILLING_TEXT_RE = /insufficient[_ ](?:quota|credits)|\bcredits\b|billing|payment required|upgrade to[^\n]{0,80}tier|(?:model|plan)[^\n]{0,60}requires (?:an? )?(?:paid|pro|flash|premium)[^\n]{0,40}tier|requires (?:a )?(?:paid|flash) tier/i;

// 28.9: «окно»-квота: 429 с явным retry-after/reset-текстом — сон помогает.
const QUOTA_RESET_TEXT_RE = /retry[ -]?after|reset(?:s|ting)? (?:in|at|on)\b|\bdaily (?:limit|quota|usage|request)|\bhourly (?:limit|quota)|\bminute(?:ly)? limit|x-ratelimit-reset|per[ -](?:day|hour|minute) (?:limit|quota|request)/i;

export function categorizeError(error: unknown): ErrorCategory {
  if (error instanceof RateLimitError) {
    if (BILLING_TEXT_RE.test(messageOf(error))) return 'billing';
    return QUOTA_RESET_TEXT_RE.test(messageOf(error)) ? 'quota' : 'rate_limit_exceeded';
  }
  if (error instanceof ProviderHttpError) {
    if (error.status === 401) return 'auth_invalid_key';
    if (error.status === 403) return 'auth_forbidden';
    if (error.status === 402) return 'billing';
    if (error.status === 404) return 'model_not_found';
    if (error.status === 429) {
      const blob = `${error.message} ${error.details}`;
      if (BILLING_TEXT_RE.test(blob)) return 'billing';
      return QUOTA_RESET_TEXT_RE.test(blob) ? 'quota' : 'rate_limit_exceeded';
    }
    return 'unknown';
  }
  if (error instanceof BadResponseError) return 'invalid_json';
  const raw = messageOf(error);
  if (isTimeoutShape(error, raw)) return 'timeout';
  if (isJsonFailure(raw)) return 'invalid_json';
  const textStatus = statusFromText(raw);
  if (textStatus === 401) return 'auth_invalid_key';
  if (textStatus === 403) return 'auth_forbidden';
  if (textStatus === 402) return 'billing';
  if (textStatus === 404) return 'model_not_found';
  if (textStatus === 429) {
    if (BILLING_TEXT_RE.test(raw)) return 'billing';
    return QUOTA_RESET_TEXT_RE.test(raw) ? 'quota' : 'rate_limit_exceeded';
  }
  if (BILLING_TEXT_RE.test(raw)) return 'billing';
  if (/invalid api key|incorrect api key|unauthorized|api[_ ]key/i.test(raw)) return 'auth_invalid_key';
  if (/forbidden|permission denied/i.test(raw)) return 'auth_forbidden';
  if (/model[^.]{0,60}?(?:not found|does not exist|is unavailable|unknown model)/i.test(raw)) return 'model_not_found';
  if (QUOTA_RESET_TEXT_RE.test(raw)) return 'quota';
  if (/rate.?limit|too many requests|overloaded|quota|exceeded/i.test(raw)) return 'rate_limit_exceeded';
  if (isConnectionFailure(raw)) return 'connection_refused';
  return 'unknown';
}

function timeoutSecondsOf(error: unknown, raw: string): number {
  const direct = error instanceof Error && 'timeoutMs' in error ? Number((error as unknown as { timeoutMs?: unknown }).timeoutMs) : Number.NaN;
  if (Number.isFinite(direct) && direct > 0) return Math.max(1, Math.round(direct / 1000));
  const parsed = raw.match(/(\d+(?:\.\d+)?)\s*ms\b/i);
  if (parsed) return Math.max(1, Math.round(Number(parsed[1]) / 1000));
  return PROBE_TIMEOUT_FALLBACK_SECONDS;
}

// Для unknown-категории: однострочные сообщения самого CodeScout (trust,
// нет ключа и т.п.) уже человекочитаемы — пропускаем их как есть, но
// обязательно вычищаем формы секретов. Многострочные стеки, HTML-простыни
// и длинный мусор в UI не показываем — только generic-текст + raw в details.
const SECRET_SHAPE = /(?:gsk|sk|AIza|ya29|ghp|gho|glpat)[A-Za-z0-9_\-]{4,}|Bearer\s+\S+|api[_-]?key["'\s=:]+[^\s,"']{6,}/gi;

export function scrubErrorSecrets(text: string): string {
  return text.replace(SECRET_SHAPE, '•••');
}

function isHumanReadableSingleLine(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.length > 240) return false;
  if (/[\r\n]/.test(value) || /^\s*</.test(value)) return false;
  if (/error\s+at|stack|\bat\s+\S+\s+\(|Traceback/i.test(value)) return false;
  return true;
}

// Единая точка преобразования ошибки в локализованные строки для UI.
export function formatError(error: unknown, lang: Lang): FormattedError {
  const category = categorizeError(error);
  const rawMessage = messageOf(error);
  const vars: Record<string, string | number> | undefined = category === 'timeout' ? { s: timeoutSecondsOf(error, rawMessage) } : undefined;
  const generic = t(`err.msg.${category}`, lang, vars);
  const message = category === 'unknown' && isHumanReadableSingleLine(rawMessage) ? scrubErrorSecrets(rawMessage.trim()) : generic;
  return {
    category,
    title: t(`err.title.${category}`, lang),
    message,
    actionHint: t(`err.hint.${category}`, lang),
    rawMessage
  };
}
