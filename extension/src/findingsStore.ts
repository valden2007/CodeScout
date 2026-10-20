// Батч 14: персистентное хранилище скрытых находок (false positives).
// Храним ТОЛЬКО в workspaceState (не globalState): подавление привязано
// к конкретному проекту/репозиторию и не должно течь между workspace.
import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { ReviewIssue } from '../../src/types';

const SUPPRESSED_KEY = 'codescout.suppressedFindings';
// Радиус ±3 строки: бакет шириной 7 строк. Модель смещает номер на ±1..3 —
// находки в одной зоне overlap получают один fingerprint (дедуп подавления).
const LINE_BUCKET = 7;

export interface FingerprintSource {
  file: string;
  line: number;
  severity: ReviewIssue['severity'];
  category: ReviewIssue['category'];
}

// Нормализованный хэш file + severity + category + bucket(line).
// Файл: '\'→'/' и нижний регистр (Windows), line — бакет, а не точная строка.
export function computeFingerprint(issue: FingerprintSource): string {
  const line = Number.isFinite(issue.line) && issue.line >= 1 ? Math.floor(issue.line) : 1;
  const bucket = Math.floor((line - 1) / LINE_BUCKET);
  const file = String(issue.file ?? '').trim().replaceAll('\\', '/').toLowerCase();
  const raw = `${file}\u0000${issue.severity}\u0000${issue.category}\u0000${bucket}`;
  return createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 16);
}

function readSuppressed(workspaceState: vscode.Memento): string[] {
  const value = workspaceState.get<string[]>(SUPPRESSED_KEY);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

export function getSuppressedFindings(workspaceState: vscode.Memento): string[] {
  return readSuppressed(workspaceState);
}

export function suppressFinding(workspaceState: vscode.Memento, fingerprint: string): void {
  const fp = String(fingerprint ?? '').trim();
  if (!fp) return;
  const list = readSuppressed(workspaceState);
  if (list.includes(fp)) return;
  void workspaceState.update(SUPPRESSED_KEY, [...list, fp]);
}

export function unsuppressFinding(workspaceState: vscode.Memento, fingerprint: string): void {
  const fp = String(fingerprint ?? '').trim();
  if (!fp) return;
  const list = readSuppressed(workspaceState);
  const next = list.filter((item) => item !== fp);
  if (next.length === list.length) return;
  void workspaceState.update(SUPPRESSED_KEY, next);
}

export function clearSuppressedFindings(workspaceState: vscode.Memento): void {
  void workspaceState.update(SUPPRESSED_KEY, undefined);
}

// Пост-обработка перед передачей в вебвью: отбрасывает подавленные находки
// и навешивает fingerprint на остальные (кнопка «Ложное срабатывание»).
export function filterSuppressed(findings: ReviewIssue[], workspaceState: vscode.Memento): ReviewIssue[] {
  const suppressed = new Set(readSuppressed(workspaceState));
  const visible: ReviewIssue[] = [];
  for (const issue of findings) {
    const fingerprint = issue.fingerprint?.trim() || computeFingerprint(issue);
    if (suppressed.has(fingerprint)) continue;
    visible.push(issue.fingerprint === fingerprint ? issue : { ...issue, fingerprint });
  }
  return visible;
}
