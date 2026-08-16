import * as vscode from 'vscode';
import { createProvider } from '../../src/llm-client';
import { buildReviewPrompt, SYSTEM_PROMPT } from '../../src/prompt-builder';
import { parseReviewResponse } from '../../src/response-parser';
import { correctIssueLine } from '../../src/line-correction';
import { splitPatch } from '../../src/diff-parser';
import { readGitDiff, LocalDiffFile } from '../../src/tui/DiffReader';
import { ReviewIssue } from '../../src/types';

const MODEL = 'llama-3.3-70b-versatile';

function formatIssue(issue: ReviewIssue): string {
  const severity = issue.severity.toUpperCase();
  const location = `${issue.file}:${issue.line}`;
  const code = issue.code ? `\n  code: ${issue.code}` : '';
  const suggestion = issue.suggestion ? `\n  suggestion: ${issue.suggestion}` : '';
  return `[${severity}] ${issue.category} · ${location} · confidence ${Math.round(issue.confidence * 100)}%\n  ${issue.description}${code}${suggestion}`;
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function reviewWorkspace(lastCommit: boolean, output: vscode.OutputChannel): Promise<ReviewIssue[]> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    throw new Error('Открой папку с Git-репозиторием в VS Code и повтори команду.');
  }

  const config = vscode.workspace.getConfiguration('codescout');
  const apiKey = config.get<string>('apiKey')?.trim() || process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Не найден Groq API key. Укажи codescout.apiKey в настройках VS Code или GROQ_API_KEY в окружении.');
  }

  const providerName = config.get<string>('provider', 'groq');
  const files = readGitDiff(workspaceRoot, { lastCommit });
  if (files.length === 0) return [];

  const provider = createProvider(providerName, apiKey, MODEL);
  const issues: ReviewIssue[] = [];
  for (const file of files) {
    for (const chunk of splitPatch(file.patch, 45_000)) {
      const raw = await provider.review(SYSTEM_PROMPT, buildReviewPrompt(file, chunk));
      const parsed = parseReviewResponse(raw, file.filename);
      issues.push(...parsed.issues.map((issue) => correctIssueLine(issue, workspaceRoot)));
    }
  }
  return issues;
}

async function runReview(lastCommit: boolean, output: vscode.OutputChannel): Promise<void> {
  output.clear();
  output.show(true);
  output.appendLine(lastCommit ? 'CodeScout: reviewing last commit...' : 'CodeScout: reviewing uncommitted changes...');

  try {
    const issues = await reviewWorkspace(lastCommit, output);
    if (issues.length === 0) {
      output.appendLine('No issues found.');
    } else {
      output.appendLine(`${issues.length} issue${issues.length === 1 ? '' : 's'} found:`);
      output.appendLine('');
      for (const issue of issues) output.appendLine(formatIssue(issue));
    }
    void vscode.window.showInformationMessage(`CodeScout: ${issues.length} issues found`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Error: ${message}`);
    void vscode.window.showErrorMessage(`CodeScout: ${message}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CodeScout');
  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.commands.registerCommand('codescout.scanUncommitted', () => runReview(false, output)),
    vscode.commands.registerCommand('codescout.scanLastCommit', () => runReview(true, output))
  );
}

export function deactivate(): void {}
