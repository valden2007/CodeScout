import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { LocalDiffFile } from '../../src/tui/DiffReader';
import type { ReviewIssue } from '../../src/types';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.codescout']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.kt', '.rb', '.php', '.rs', '.cs', '.sql', '.swift', '.vue', '.svelte']);

export interface AuditCollection {
  files: LocalDiffFile[];
  skippedLarge: string[];
  skippedUnreadable: string[];
  ignored: string[];
  skippedLimit: number;
}

export interface AuditMeta {
  provider: string;
  model: string;
  timestamp: number;
}

export interface ProjectContext {
  stack: string[];
  filesCount: number;
  topFindings: Array<{ file: string; severity: string; category: string }>;
  auditMeta?: AuditMeta;
}

export interface FindingsHistoryEntry {
  file: string;
  line: number;
  category: string;
  severity: string;
  description: string;
}

export interface FindingsHistory {
  savedAt: number;
  scanType: string;
  provider?: string;
  model?: string;
  findings: FindingsHistoryEntry[];
}

export interface FindingsDiffView {
  summary: string;
  newKeys: string[];
  fixed: FindingsHistoryEntry[];
}

export function loadProjectRules(workspaceRoot: string): string | undefined {
  const path = join(workspaceRoot, '.codescout', 'rules.md');
  if (!existsSync(path)) return undefined;
  const rules = readFileSync(path, 'utf8').trim();
  return rules || undefined;
}

export function readProjectContext(workspaceRoot: string): ProjectContext | undefined {
  const path = join(workspaceRoot, '.codescout', 'context.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProjectContext;
  } catch {
    return undefined;
  }
}

export function buildProjectSystemPrompt(basePrompt: string, workspaceRoot: string, docLinks: string[] = []): { prompt: string; rulesLoaded: boolean; contextLoaded: boolean } {
  const rules = loadProjectRules(workspaceRoot);
  const context = readProjectContext(workspaceRoot);
  let prompt = basePrompt;
  if (rules) prompt += `\n\n## PROJECT SPECIFIC RULES\n${rules}`;
  const links = docLinks.map((link) => link.trim()).filter(Boolean);
  if (links.length) prompt += `\n\nДокументация проекта: ${links.join(', ')}`;
  if (context && context.topFindings.length > 0) {
    const zones = context.topFindings.map((finding) => `${finding.file} (${finding.severity}/${finding.category})`).join(', ');
    prompt += `\n\nИзвестные проблемные зоны проекта: ${zones}`;
  }
  return { prompt, rulesLoaded: Boolean(rules), contextLoaded: Boolean(context) };
}

export function loadIgnorePatterns(workspaceRoot: string): string[] {
  const patterns: string[] = [];
  for (const source of [join(workspaceRoot, '.gitignore'), join(workspaceRoot, '.codescout', 'ignore')]) {
    if (!existsSync(source)) continue;
    try {
      for (const rawLine of readFileSync(source, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        patterns.push(line);
      }
    } catch {
      // нечитаемый ignore-файл просто пропускаем
    }
  }
  return patterns;
}

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += '.*';
        index += 1;
        if (glob[index + 1] === '/') index += 1;
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else if ('.+^$(){}|[]\\'.includes(char)) source += `\\${char}`;
    else source += char;
  }
  return new RegExp(`^${source}$`);
}

export function isIgnoredAuditPath(path: string, patterns: string[] = []): boolean {
  if (path.split(/[/\\\\]/).some((part) => IGNORED_DIRS.has(part) || part.startsWith('.'))) return true;
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  for (const pattern of patterns) {
    if (pattern.endsWith('/')) {
      if (segments.includes(pattern.slice(0, -1))) return true;
      continue;
    }
    if (pattern.includes('/')) {
      if (globToRegExp(pattern).test(segments.join('/'))) return true;
      continue;
    }
    const matcher = globToRegExp(pattern);
    if (segments.some((segment) => segment === pattern || matcher.test(segment))) return true;
  }
  return false;
}

function walkSourceFiles(root: string, current: string, result: string[], ignored: string[], patterns: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) walkSourceFiles(root, path, result, ignored, patterns);
    else if (SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')).toLowerCase())) {
      const relativePath = relative(root, path).replaceAll('\\', '/');
      if (isIgnoredAuditPath(relativePath, patterns)) ignored.push(relativePath);
      else result.push(relativePath);
    }
  }
}

export function listAuditSourceFiles(workspaceRoot: string): { files: string[]; ignored: string[] } {
  const patterns = loadIgnorePatterns(workspaceRoot);
  const files: string[] = [];
  const ignored: string[] = [];
  walkSourceFiles(workspaceRoot, workspaceRoot, files, ignored, patterns);
  return { files: files.sort(), ignored };
}

function sourceFileDiff(workspaceRoot: string, filename: string): LocalDiffFile {
  const content = readFileSync(join(workspaceRoot, filename), 'utf8');
  const lines = content.split(/\r?\n/);
  return { filename, status: 'audit', additions: lines.length, deletions: 0, patch: `--- /dev/null\n+++ b/${filename}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}` };
}

function readAuditEntries(workspaceRoot: string, sortedPaths: string[], maxFiles: number, maxLines: number, ignored: string[]): AuditCollection {
  const files: LocalDiffFile[] = [];
  const skippedLarge: string[] = [];
  const skippedUnreadable: string[] = [];
  const selected = sortedPaths.slice(0, maxFiles);
  const skippedLimit = sortedPaths.length - selected.length;
  for (const filename of selected) {
    let entry: LocalDiffFile;
    try {
      entry = sourceFileDiff(workspaceRoot, filename);
    } catch {
      skippedUnreadable.push(filename);
      continue;
    }
    if (entry.additions > maxLines) {
      skippedLarge.push(filename);
      continue;
    }
    files.push(entry);
  }
  return { files, skippedLarge, skippedUnreadable, ignored, skippedLimit };
}

export function collectAuditFiles(workspaceRoot: string, maxFiles = 100, maxLines = 400): AuditCollection {
  const pool = listAuditSourceFiles(workspaceRoot);
  return readAuditEntries(workspaceRoot, pool.files, maxFiles, maxLines, pool.ignored);
}

export type ReviewScope = 'all' | 'active' | 'list';

export function collectFilesForScope(workspaceRoot: string, scope: ReviewScope, globs: string[] = [], activeFile?: string, maxFiles = 100, maxLines = 400): AuditCollection {
  if (scope === 'all') return collectAuditFiles(workspaceRoot, maxFiles, maxLines);
  if (scope === 'active') {
    const requested = activeFile?.trim();
    if (!requested) return { files: [], skippedLarge: [], skippedUnreadable: [], ignored: [], skippedLimit: 0 };
    const relativePath = relative(workspaceRoot, resolve(workspaceRoot, requested)).replaceAll('\\', '/');
    if (relativePath.startsWith('..')) return { files: [], skippedLarge: [], skippedUnreadable: [relativePath], ignored: [], skippedLimit: 0 };
    try {
      return { files: [sourceFileDiff(workspaceRoot, relativePath)], skippedLarge: [], skippedUnreadable: [], ignored: [], skippedLimit: 0 };
    } catch {
      return { files: [], skippedLarge: [], skippedUnreadable: [relativePath], ignored: [], skippedLimit: 0 };
    }
  }
  const patterns = globs.map((glob) => glob.trim()).filter(Boolean);
  const pool = listAuditSourceFiles(workspaceRoot);
  const candidates = patterns.length ? pool.files.filter((file) => patterns.some((glob) => isIgnoredAuditPath(file, [glob]))) : [];
  return readAuditEntries(workspaceRoot, candidates, maxFiles, maxLines, pool.ignored);
}

function projectStack(workspaceRoot: string): string[] {
  const packagePath = join(workspaceRoot, 'package.json');
  if (!existsSync(packagePath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])].sort();
  } catch {
    return [];
  }
}

export function writeProjectContext(workspaceRoot: string, filesCount: number, issues: ReviewIssue[], auditMeta?: AuditMeta): ProjectContext {
  const context: ProjectContext = {
    stack: projectStack(workspaceRoot),
    filesCount,
    topFindings: issues.slice().sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, 10).map((issue) => ({ file: issue.file, severity: issue.severity, category: issue.category })),
    ...(auditMeta ? { auditMeta } : {})
  };
  const directory = join(workspaceRoot, '.codescout');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'context.json'), `${JSON.stringify(context, null, 2)}\n`, 'utf8');
  return context;
}

export function projectContextSummary(context: ProjectContext | undefined): string {
  if (!context || context.topFindings.length === 0) return '';
  return context.topFindings.map((finding) => `${finding.file} (${finding.severity}/${finding.category})`).join(', ');
}

function findingKey(entry: { file: string; line: number | string; category: string }): string {
  return `${entry.file}:${entry.line}:${entry.category}`;
}

export function writeFindingsHistory(workspaceRoot: string, issues: ReviewIssue[], scanType: string, auditMeta?: AuditMeta): FindingsHistory {
  const history: FindingsHistory = {
    savedAt: auditMeta?.timestamp ?? Date.now(),
    scanType,
    ...(auditMeta ? { provider: auditMeta.provider, model: auditMeta.model } : {}),
    findings: issues.map((issue) => ({ file: issue.file, line: issue.line, category: issue.category, severity: issue.severity, description: issue.description }))
  };
  const directory = join(workspaceRoot, '.codescout');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'history.json'), `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  return history;
}

export function readFindingsHistory(workspaceRoot: string): FindingsHistory | undefined {
  const path = join(workspaceRoot, '.codescout', 'history.json');
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as FindingsHistory;
    return Array.isArray(parsed.findings) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function buildFindingsDiff(previous: FindingsHistory | undefined, issues: ReviewIssue[]): FindingsDiffView | undefined {
  if (!previous) return undefined;
  const currentKeys = new Set(issues.map(findingKey));
  const previousKeys = new Set(previous.findings.map(findingKey));
  const newOnes = issues.filter((issue) => !previousKeys.has(findingKey(issue)));
  const fixed = previous.findings.filter((entry) => !currentKeys.has(findingKey(entry)));
  const summary = `🆕 новых: ${newOnes.length} · ✅ починено: ${fixed.length} · 🔁 осталось: ${issues.length - newOnes.length}`;
  return { summary, newKeys: newOnes.map(findingKey), fixed };
}

export function resolveAuditFile(workspaceRoot: string, filename: string): string {
  return resolve(workspaceRoot, filename);
}

export function fileLineCount(workspaceRoot: string, filename: string): number {
  return readFileSync(join(workspaceRoot, filename), 'utf8').split(/\r?\n/).length;
}

export function isAuditSource(path: string): boolean {
  return SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')).toLowerCase());
}

export function auditFileExists(workspaceRoot: string, filename: string): boolean {
  return existsSync(join(workspaceRoot, filename)) && statSync(join(workspaceRoot, filename)).isFile();
}
