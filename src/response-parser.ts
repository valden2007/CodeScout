import { ReviewIssue, ReviewResult, ReviewCategory, ReviewSeverity } from './types';

const categories = new Set<ReviewCategory>(['bug', 'security', 'performance', 'maintainability', 'docs', 'style']);
const severities = new Set<ReviewSeverity>(['low', 'medium', 'high', 'critical']);

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
    return [{ file: filename, line, category, severity, description, code, suggestion, confidence }];
  });
  return { issues, summary: typeof object.summary === 'string' ? object.summary.trim() : '', filesAnalyzed: 1 };
}
