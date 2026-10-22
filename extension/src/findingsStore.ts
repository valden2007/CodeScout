// Батч 20b (ядро доверия): хранилище подавленных находок (false positives)
// поверх context.workspaceState.
// Храним ТОЛЬКО в workspaceState (не globalState): подавление привязано
// к конкретному проекту/репозиторию и не должно течь между workspace.
// Формула fingerprint: file + severity + category + строка. Допуск ±3 строки
// живёт НЕ в хэше (бакет ронял совпадения на границах), а в матжере зон:
// запись хранит метаданные находки (для вкладки «Скрытые» и «↩ Вернуть»),
// а filterSuppressed скрывает любую находку того же файла/severity/category
// в радиусе LINE_TOLERANCE строк.
import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { ReviewIssue } from '../../src/types';

const SUPPRESSED_KEY = 'codescout.suppressedFindings';
// Радиус допуска: модель смещает номер строки на ±1..3 между сканами —
// находка в этой зоне считается той же самой.
export const LINE_TOLERANCE = 3;
// Батч 14 хранил бакет-хэш (7 строк). Старые строки-записи читаем только
// на точное совпадение с этим хэшем — подавление не «протечёт» после апгрейда.
const LEGACY_LINE_BUCKET = 7;
const DESCRIPTION_MAX = 400;

export interface FingerprintSource {
  file: string;
  line: number;
  severity: ReviewIssue['severity'];
  category: ReviewIssue['category'];
}

// Запись подавления: идентичность + метаданные, чтобы вкладка скрытых
// показывала находку и снимала подавление одним кликом. severity/category —
// строки: читаем из Memento непроверенные данные (enum-валидация избыточна,
// на несостыковку матчер просто не сработает).
export interface SuppressedEntry {
  id: string;
  file: string;
  line: number;
  severity: string;
  category: string;
  description: string;
  hiddenAt: number;
}

function hashHex(raw: string): string {
  return createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 16);
}

// Нормализация пути: '\'→'/' и нижний регистр (Windows-устойчиво).
function normalizeFile(file: string): string {
  return String(file ?? '').trim().replaceAll('\\', '/').toLowerCase();
}

function normalizeLine(line: number): number {
  return Number.isFinite(line) && line >= 1 ? Math.floor(line) : 1;
}

// Идентичность находки: file + severity + category + ТОЧНАЯ строка.
export function computeFingerprint(issue: FingerprintSource): string {
  const raw = `${normalizeFile(issue.file)}\u0000${issue.severity}\u0000${issue.category}\u0000${normalizeLine(issue.line)}`;
  return hashHex(raw);
}

// Совместимость с батчем 14: старый бакет-хэш для строк-наследий в сторе.
export function legacyBucketFingerprint(issue: FingerprintSource): string {
  const bucket = Math.floor((normalizeLine(issue.line) - 1) / LEGACY_LINE_BUCKET);
  const raw = `${normalizeFile(issue.file)}\u0000${issue.severity}\u0000${issue.category}\u0000${bucket}`;
  return hashHex(raw);
}

// Та же зона: файл+severity+category и строки в пределах ±LINE_TOLERANCE.
// «Голая» запись без файла (строка-наследие) в зонах не участвует.
function zoneMatches(entry: SuppressedEntry, issue: FingerprintSource): boolean {
  if (!entry.file) return false;
  return normalizeFile(issue.file) === entry.file
    && String(issue.severity) === entry.severity
    && String(issue.category) === entry.category
    && Math.abs(normalizeLine(issue.line) - entry.line) <= LINE_TOLERANCE;
}

function readEntries(workspaceState: vscode.Memento): SuppressedEntry[] {
  const value = workspaceState.get<unknown[]>(SUPPRESSED_KEY);
  if (!Array.isArray(value)) return [];
  const out: SuppressedEntry[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (id) out.push({ id, file: '', line: 0, severity: 'low', category: 'bug', description: '', hiddenAt: 0 });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) continue;
    out.push({
      id,
      file: normalizeFile(String(raw.file ?? '')),
      line: Number.isFinite(raw.line) ? Math.floor(raw.line as number) : 0,
      severity: String(raw.severity ?? ''),
      category: String(raw.category ?? ''),
      description: typeof raw.description === 'string' ? raw.description.slice(0, DESCRIPTION_MAX) : '',
      hiddenAt: Number.isFinite(raw.hiddenAt) ? (raw.hiddenAt as number) : 0
    });
  }
  return out;
}

export function getSuppressed(workspaceState: vscode.Memento): SuppressedEntry[] {
  return readEntries(workspaceState).sort((a, b) => b.hiddenAt - a.hiddenAt);
}

// Скрыта ли находка: точный id, зона записи ±3 строки или старый бакет-хэш.
export function isSuppressed(issue: FingerprintSource, entries: SuppressedEntry[]): boolean {
  const fp = computeFingerprint(issue);
  const legacy = legacyBucketFingerprint(issue);
  return entries.some((entry) => entry.id === fp || entry.id === legacy || zoneMatches(entry, issue));
}

// suppress: добавить запись. Пересекающиеся зоны (тот же файл+severity+category,
// строки в пределах ±3) схлопываем в одну запись — «Вернуть» снимает
// подавление одним кликом, без «а почему она всё ещё скрыта».
export function suppress(workspaceState: vscode.Memento, issue: FingerprintSource & { description?: string }): SuppressedEntry {
  const entry: SuppressedEntry = {
    id: computeFingerprint(issue),
    file: normalizeFile(issue.file),
    line: normalizeLine(issue.line),
    severity: String(issue.severity),
    category: String(issue.category),
    description: String(issue.description ?? '').trim().slice(0, DESCRIPTION_MAX),
    hiddenAt: Date.now()
  };
  const kept = readEntries(workspaceState).filter((item) => item.id !== entry.id && !zoneMatches(item, issue));
  void workspaceState.update(SUPPRESSED_KEY, [...kept, entry]);
  return entry;
}

export function unsuppress(workspaceState: vscode.Memento, id: string): void {
  const fp = String(id ?? '').trim();
  if (!fp) return;
  const list = readEntries(workspaceState);
  const next = list.filter((item) => item.id !== fp);
  if (next.length === list.length) return;
  void workspaceState.update(SUPPRESSED_KEY, next);
}

export function clearSuppressed(workspaceState: vscode.Memento): void {
  void workspaceState.update(SUPPRESSED_KEY, undefined);
}

// Пост-обработка перед передачей в вебвью: отбрасывает подавленные находки
// и навешивает fingerprint на остальные (кнопка «Ложное срабатывание»).
export function filterSuppressed(findings: ReviewIssue[], workspaceState: vscode.Memento): ReviewIssue[] {
  const entries = readEntries(workspaceState);
  const visible: ReviewIssue[] = [];
  for (const issue of findings) {
    const fingerprint = issue.fingerprint?.trim() || computeFingerprint(issue);
    if (isSuppressed(issue, entries)) continue;
    visible.push(issue.fingerprint === fingerprint ? issue : { ...issue, fingerprint });
  }
  return visible;
}
