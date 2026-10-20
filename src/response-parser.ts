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

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fenced ? fenced[1] : raw;
  const trimmed = body.trimStart();
  if (trimmed.startsWith('"') || trimmed.startsWith('-') || /^[0-9]/.test(trimmed)) return trimmed;
  return findBalancedJson(body) ?? trimmed;
}

export function parseReviewResponse(raw: string, filename: string): ReviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    throw new Error(`LLM returned malformed JSON for ${filename}`);
  }
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
