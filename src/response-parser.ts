import { ReviewIssue, ReviewResult, ReviewCategory, ReviewSeverity } from './types';

const categories = new Set<ReviewCategory>(['bug', 'security', 'performance', 'maintainability', 'docs', 'style']);
const severities = new Set<ReviewSeverity>(['low', 'medium', 'high', 'critical']);

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1];
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}

export function parseReviewResponse(raw: string, filename: string): ReviewResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    throw new Error(`LLM returned malformed JSON for ${filename}`);
  }
  const object = parsed as { issues?: unknown; summary?: unknown };
  const rawIssues = Array.isArray(object.issues) ? object.issues : [];
  const issues: ReviewIssue[] = rawIssues.flatMap((item): ReviewIssue[] => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const category = categories.has(value.category as ReviewCategory) ? value.category as ReviewCategory : 'bug';
    const severity = severities.has(value.severity as ReviewSeverity) ? value.severity as ReviewSeverity : 'medium';
    const description = typeof value.description === 'string' ? value.description.trim() : '';
    if (!description) return [];
    const line = typeof value.line === 'number' && Number.isFinite(value.line) ? Math.max(1, Math.floor(value.line)) : 1;
    const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence) ? Math.min(1, Math.max(0, value.confidence)) : 0.7;
    return [{ file: filename, line, category, severity, description, suggestion: typeof value.suggestion === 'string' ? value.suggestion.trim() : undefined, confidence }];
  });
  return { issues, summary: typeof object.summary === 'string' ? object.summary.trim() : '', filesAnalyzed: 1 };
}
