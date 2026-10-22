import { ReviewIssue, ReviewResult, ReviewCategory, ReviewSeverity } from './types';

const categories = new Set<ReviewCategory>(['bug', 'security', 'performance', 'maintainability', 'docs', 'style']);
const severities = new Set<ReviewSeverity>(['low', 'medium', 'high', 'critical']);
// Батч 20b (ядро доверия): единая шкала уверенности для всего продукта —
// целые 0..100. Парсер клампит и лечит мусор, UI/экспортёры только читают.
export const CONFIDENCE_MIN = 0;
export const CONFIDENCE_MAX = 100;
// Мусор/отсутствие поля = 50: «ни да, ни нет», честный нейтральный дефолт.
export const CONFIDENCE_DEFAULT = 50;
// >= порога — «подтверждено кодом» (зелёный бейдж), ниже — «предположение модели».
export const CONFIDENCE_VERIFIED_THRESHOLD = 70;
// critical допускается только при уверенности не ниже этого значения.
export const CONFIDENCE_CRITICAL_MIN = 90;
// Санити-потолок длины доказательства: непроверяемый вывод модели не должен
// раздувать отчёт; это граница формата, а не продуктовый лимит.
const PROOF_MAX = 1000;

// Приведение любого значения confidence к шкале 0..100 (целое).
// Мусор (не число, NaN, Infinity) → fallback. Все отображения (% в панели,
// GitHub-комменты, CLI, Output) идут через эту функцию — дублей логики нет.
export function confidencePercent(value: unknown, fallback = CONFIDENCE_DEFAULT): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, value)));
}

// proof — строка (цитата из кода или причина). При отсутствии/мусоре = ''.
function parseProof(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, PROOF_MAX);
}

function findBalancedJson(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

// Батч 18.8: greedy-эвристика для «болтливых» бесплатных моделей — если
// сбалансированный сканер не сработал (обрезанный/вложенный мусор),
// вырезаем от ПЕРВОГО [ или { до ПОСЛЕДНЕГО ] или } включительно.
function findGreedyJsonSpan(text: string): string | undefined {
  const firstOpen = text.search(/[[{]/);
  if (firstOpen < 0) return undefined;
  const lastBracket = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (lastBracket <= firstOpen) return undefined;
  return text.slice(firstOpen, lastBracket + 1);
}

function stripMarkdownFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced ? fenced[1] : text).trim();
}

// Батч 20a: санитайз висячих запятых — «[1,2,]» и «{"a":1,}» лечатся regex
// `,\s*([\]}]) → $1`. Применяется ВТОРЫМ проходом на кандидате, который уже
// не парсится как есть: валидный JSON со строкой вида "wait, }" не портится
// (первым всегда пробуем оригинал, sanitized-вариант подхватывается только
// когда сырой кандидат упал).
export function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[\]}])/g, '$1');
}

const RAW_TAIL_LIMIT = 200;

export type JsonParseOutcome = { ok: true; value: unknown } | { ok: false; reason: string; rawTail: string };

// Батч 20a (контракт каскада): кандидаты СТРОГО в порядке
// 1) чистый текст → 2) снятие markdown-фенсов → 3) balanced-brace сканер →
// 4) greedy slice (первый [/{ … последний ]/}) — последним, он самый ryzy.
// Перед parse каждого кандидата — попытка санитайза висячих запятых.
// Если всё упало → { ok:false, reason, rawTail } для вывода в Output, без
// падения: старые форматы ответов (без новых полей) парсятся по-прежнему.
export function tryParseJson(raw: string): JsonParseOutcome {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    if (value && !seen.has(value)) { seen.add(value); candidates.push(value); }
  };
  const trimmed = raw.trim();
  push(trimmed);
  const stripped = stripMarkdownFences(trimmed);
  push(stripped);
  push(findBalancedJson(stripped) ?? '');
  push(findGreedyJsonSpan(stripped) ?? '');
  let lastReason = 'в ответе не найдено JSON-подобного текста';
  for (const candidate of candidates) {
    for (const variant of [candidate, stripTrailingCommas(candidate)]) {
      try { return { ok: true, value: JSON.parse(variant) as unknown }; }
      catch (error) { lastReason = error instanceof Error ? error.message : String(error); }
    }
  }
  return { ok: false, reason: lastReason, rawTail: raw.trim().slice(0, RAW_TAIL_LIMIT) };
}

export function parseReviewResponse(raw: string, filename: string): ReviewResult {
  const outcome = tryParseJson(raw);
  if (!outcome.ok) {
    throw new Error(`LLM returned malformed JSON for ${filename} · ${outcome.reason} · хвост ответа: ${outcome.rawTail}`);
  }
  const parsed: unknown = outcome.value;
  if (parsed === null) throw new Error(`Ответ модели для ${filename} — JSON null вместо объекта ревью`);
  if (Array.isArray(parsed)) throw new Error(`Ответ модели для ${filename} — JSON-массив, ожидается объект с полем "issues"`);
  if (typeof parsed !== 'object') throw new Error(`Ответ модели для ${filename} — не JSON-объект (получен ${typeof parsed})`);
  const object = parsed as { issues?: unknown; summary?: unknown };
  const rawIssues = Array.isArray(object.issues) ? object.issues : [];
  const issues: ReviewIssue[] = rawIssues.flatMap((item): ReviewIssue[] => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const category = categories.has(value.category as ReviewCategory) ? value.category as ReviewCategory : 'bug';
    const rawSeverity = severities.has(value.severity as ReviewSeverity) ? value.severity as ReviewSeverity : 'medium';
    const description = typeof value.description === 'string' ? value.description.trim() : '';
    if (!description) return [];
    const line = typeof value.line === 'number' && Number.isFinite(value.line) ? Math.max(1, Math.floor(value.line)) : 1;
    const confidence = confidencePercent(value.confidence);
    const code = typeof value.code === 'string' ? value.code.trim() : undefined;
    const suggestion = typeof value.suggestion === 'string' ? value.suggestion.trim() : undefined;
    const severity: ReviewSeverity = rawSeverity === 'critical' && confidence < CONFIDENCE_CRITICAL_MIN ? 'medium' : rawSeverity;
    const proof = parseProof(value.proof);
    return [{ file: filename, line, category, severity, description, code, suggestion, confidence, proof }];
  });
  return { issues, summary: typeof object.summary === 'string' ? object.summary.trim() : '', filesAnalyzed: 1 };
}
