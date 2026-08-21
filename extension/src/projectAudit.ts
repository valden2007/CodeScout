import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { LocalDiffFile } from '../../src/tui/DiffReader';
import type { ReviewIssue } from '../../src/types';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.codescout']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.kt', '.rb', '.php', '.rs', '.cs', '.sql', '.swift', '.vue', '.svelte']);

export interface AuditCollection {
  files: LocalDiffFile[];
  skippedLarge: string[];
}

export interface ProjectContext {
  stack: string[];
  filesCount: number;
  topFindings: Array<{ file: string; severity: string; category: string }>;
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

export function buildProjectSystemPrompt(basePrompt: string, workspaceRoot: string): { prompt: string; rulesLoaded: boolean; contextLoaded: boolean } {
  const rules = loadProjectRules(workspaceRoot);
  const context = readProjectContext(workspaceRoot);
  let prompt = basePrompt;
  if (rules) prompt += `\n\n## PROJECT SPECIFIC RULES\n${rules}`;
  if (context && context.topFindings.length > 0) {
    const zones = context.topFindings.map((finding) => `${finding.file} (${finding.severity}/${finding.category})`).join(', ');
    prompt += `\n\nИзвестные проблемные зоны проекта: ${zones}`;
  }
  return { prompt, rulesLoaded: Boolean(rules), contextLoaded: Boolean(context) };
}

function walkSourceFiles(root: string, current: string, result: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) walkSourceFiles(root, path, result);
    else if (SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')).toLowerCase())) result.push(relative(root, path).replaceAll('\\', '/'));
  }
}

export function collectAuditFiles(workspaceRoot: string, maxFiles = 100, maxLines = 400): AuditCollection {
  const relativePaths: string[] = [];
  walkSourceFiles(workspaceRoot, workspaceRoot, relativePaths);
  const files: LocalDiffFile[] = [];
  const skippedLarge: string[] = [];
  for (const filename of relativePaths.sort().slice(0, maxFiles)) {
    const absolute = join(workspaceRoot, filename);
    const content = readFileSync(absolute, 'utf8');
    const lines = content.split(/\r?\n/);
    if (lines.length > maxLines) {
      skippedLarge.push(filename);
      continue;
    }
    files.push({ filename, status: 'audit', additions: lines.length, deletions: 0, patch: `--- /dev/null\n+++ b/${filename}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}` });
  }
  return { files, skippedLarge };
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

export function writeProjectContext(workspaceRoot: string, filesCount: number, issues: ReviewIssue[]): ProjectContext {
  const context: ProjectContext = {
    stack: projectStack(workspaceRoot),
    filesCount,
    topFindings: issues.slice().sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, 10).map((issue) => ({ file: issue.file, severity: issue.severity, category: issue.category }))
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

export function resolveAuditFile(workspaceRoot: string, filename: string): string {
  return resolve(workspaceRoot, filename);
}

export function fileLineCount(workspaceRoot: string, filename: string): number {
  return readFileSync(join(workspaceRoot, filename), 'utf8').split(/\r?\n/).length;
}

export function isAuditSource(path: string): boolean {
  return SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')).toLowerCase());
}

export function isIgnoredAuditPath(path: string): boolean {
  return path.split('/').some((part) => IGNORED_DIRS.has(part));
}

export function auditFileExists(workspaceRoot: string, filename: string): boolean {
  return existsSync(join(workspaceRoot, filename)) && statSync(join(workspaceRoot, filename)).isFile();
}
