// Батч 15: категоризация ошибок провайдеров для UI. extension.ts/panel.ts
// получают готовую структуру (title + понятный message + actionHint), «сырое»
// сообщение уходит только в rawMessage (Output после redactSecrets).
import { BadResponseError, ProviderHttpError, RateLimitError } from './llm-client';
import { t, type Lang } from './i18n';

export type ErrorCategory =
  | 'auth_invalid_key'
  | 'auth_forbidden'
  | 'rate_limit_exceeded'
  // Микро-батч 28.4: платёжная квота (HTTP 402, «insufficient_quota»,
  // «billing», «Upgrade to … Tier» у groq/openrouter) — НЕ unknown и НЕ
  // rate_limit_exceeded: failover усыпляет ключ и ротирует, breaker по ней
  // не стопит мгновенно.
  | 'quota'
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

export const ERROR_CATEGORIES: ErrorCategory[] = ['auth_invalid_key', 'auth_forbidden', 'rate_limit_exceeded', 'quota', 'model_not_found', 'timeout', 'connection_refused', 'invalid_json', 'unknown'];

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

// Микро-батч 28.4: платёжная квота. groq/openrouter отдают её как HTTP 402
// и/или тексты «insufficient_quota», «…billing…», «Upgrade to … Tier».
// Проверяется ДО общего rate-limit-текста: в биллинг-сообщениях часто
// мелькают слова «quota»/«rate limit», но смысл — деньги, а не временный
// лимит окна: нужен сон ключа + ротация, а не пауза на несколько минут.
const QUOTA_TEXT_RE = /insufficient_quota|payment required|billing|\bupgrade to\b[^\n]{0,80}\btier\b/i;

export function categorizeError(error: unknown): ErrorCategory {
  if (error instanceof RateLimitError) return 'rate_limit_exceeded';
  if (error instanceof ProviderHttpError) {
    if (error.status === 401) return 'auth_invalid_key';
    if (error.status === 403) return 'auth_forbidden';
    if (error.status === 402) return 'quota';
    if (error.status === 404) return 'model_not_found';
    if (error.status === 429) return 'rate_limit_exceeded';
    return 'unknown';
  }
  if (error instanceof BadResponseError) return 'invalid_json';
  const raw = messageOf(error);
  if (isTimeoutShape(error, raw)) return 'timeout';
  if (isJsonFailure(raw)) return 'invalid_json';
  const textStatus = statusFromText(raw);
  if (textStatus === 401) return 'auth_invalid_key';
  if (textStatus === 403) return 'auth_forbidden';
  if (textStatus === 402) return 'quota';
  if (textStatus === 404) return 'model_not_found';
  if (textStatus === 429) return 'rate_limit_exceeded';
  if (QUOTA_TEXT_RE.test(raw)) return 'quota';
  if (/invalid api key|incorrect api key|unauthorized|api[_ ]key/i.test(raw)) return 'auth_invalid_key';
  if (/forbidden|permission denied/i.test(raw)) return 'auth_forbidden';
  if (/model[^.]{0,60}?(?:not found|does not exist|is unavailable|unknown model)/i.test(raw)) return 'model_not_found';
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
