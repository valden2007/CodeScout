import { ReviewIssue, ReviewResult, ReviewCategory, ReviewSeverity, FindingConfidence, FindingProof } from './types';

const categories = new Set<ReviewCategory>(['bug', 'security', 'performance', 'maintainability', 'docs', 'style']);
const severities = new Set<ReviewSeverity>(['low', 'medium', 'high', 'critical']);
const PROOF_TRACE_MAX = 12;
const PROOF_TRACE_ITEM_MAX = 300;
const PROOF_CONDITION_MAX = 500;

// Батч 14: старые модели/fallback не знают новых полей — ничего не падаем,
// отдаём дефолты: confidenceLevel 'suggested', proof {}.
function parseConfidenceLevel(value: Record<string, unknown>): FindingConfidence {
  const direct = value.confidenceLevel;
  if (direct === 'verified' || direct === 'suggested') return direct;
  // Модели иногда путают поля и кладут строку в numeric confidence — терпим и это.
  if (value.confidence === 'verified') return 'verified';
  return 'suggested';
}

function parseProof(raw: unknown): FindingProof {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const proof: FindingProof = {};
  if (typeof value.condition === 'string' && value.condition.trim()) proof.condition = value.condition.trim().slice(0, PROOF_CONDITION_MAX);
  if (Array.isArray(value.trace)) {
    const trace = value.trace
      .filter((step): step is string => typeof step === 'string' && step.trim().length > 0)
      .map((step) => step.trim().slice(0, PROOF_TRACE_ITEM_MAX))
      .slice(0, PROOF_TRACE_MAX);
    if (trace.length) proof.trace = trace;
  }
  return proof;
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
    const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence) ? Math.min(1, Math.max(0, value.confidence)) : 0.7;
    const code = typeof value.code === 'string' ? value.code.trim() : undefined;
    const suggestion = typeof value.suggestion === 'string' ? value.suggestion.trim() : undefined;
    const severity: ReviewSeverity = rawSeverity === 'critical' && confidence < 0.9 ? 'medium' : rawSeverity;
    const confidenceLevel = parseConfidenceLevel(value);
    const proof = parseProof(value.proof);
    return [{ file: filename, line, category, severity, description, code, suggestion, confidence, confidenceLevel, proof }];
  });
  return { issues, summary: typeof object.summary === 'string' ? object.summary.trim() : '', filesAnalyzed: 1 };
}
