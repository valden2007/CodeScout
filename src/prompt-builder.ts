import { DiffFile } from './types';

export const SYSTEM_PROMPT = `You are a senior software engineer performing a focused pull request review. Identify only actionable defects introduced by the patch. Do not report preferences or pre-existing issues. Prioritize correctness, security, data loss, reliability, and performance. Return valid JSON only with this shape: {"issues":[{"file":"string","line":1,"category":"bug|security|performance|maintainability|docs|style","severity":"low|medium|high|critical","description":"string","suggestion":"string","confidence":0.0}],"summary":"string"}. Line must refer to a changed line when possible. Use an empty issues array when there is no meaningful finding.`;

export function buildReviewPrompt(file: DiffFile, patch: string): string {
  return `Review the following changed file from a pull request.\n\nFile: ${file.filename}\nStatus: ${file.status}\nAdded lines: ${file.additions}; deleted lines: ${file.deletions}\n\nPatch:\n---\n${patch}\n---\n\nReturn JSON only. Keep descriptions concise and explain why the issue matters. Provide a concrete safer suggestion when one is clear.`;
}
