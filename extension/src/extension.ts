import * as vscode from 'vscode';
import { createProvider, RetryEvent } from '../../src/llm-client';
import { buildReviewPrompt, SYSTEM_PROMPT } from '../../src/prompt-builder';
import { parseReviewResponse } from '../../src/response-parser';
import { correctIssueLine } from '../../src/line-correction';
import { splitPatch } from '../../src/diff-parser';
import { defaultModel, keyUrl, resolveApiKeyPriority } from '../../src/providers';
import { readGitDiff } from '../../src/tui/DiffReader';
import { ReviewIssue } from '../../src/types';
import { CodeScoutPanel } from './panel';
import { ReportStats } from './reportHtml';

const SECRET_KEY = 'codescout.apiKey';

interface ScanResult {
  issues: ReviewIssue[];
  filesAnalyzed: number;
  durationMs: number;
}

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

function buildStats(issues: ReviewIssue[], filesAnalyzed: number, durationMs: number): ReportStats {
  return {
    files: filesAnalyzed,
    seconds: durationMs / 1000,
    critical: issues.filter((issue) => issue.severity === 'critical' || issue.severity === 'high').length,
    medium: issues.filter((issue) => issue.severity === 'medium').length,
    low: issues.filter((issue) => issue.severity === 'low').length
  };
}

async function resolveExtensionKey(context: vscode.ExtensionContext, providerName: string, legacySetting?: string): Promise<string | undefined> {
  const secret = await context.secrets.get(SECRET_KEY);
  if (secret?.trim()) return secret.trim();
  return resolveApiKeyPriority(undefined, providerName, legacySetting);
}

async function reviewWorkspace(context: vscode.ExtensionContext, lastCommit: boolean, onRetry: (event: RetryEvent, model: string) => void): Promise<ScanResult> {
  const startedAt = Date.now();
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) throw new Error('Открой папку с Git-репозиторием в VS Code и повтори команду.');

  const config = vscode.workspace.getConfiguration('codescout');
  const providerName = config.get<string>('provider', 'gemini');
  const model = config.get<string>('model')?.trim() || defaultModel(providerName);
  const baseUrl = config.get<string>('baseUrl')?.trim() || process.env.CODESCOUT_BASE_URL;
  const apiKey = await resolveExtensionKey(context, providerName, config.get<string>('apiKey'));
  if (!apiKey) {
    throw new Error(`Не найден API-ключ для ${providerName}. Укажи codescout.apiKey или выполни CodeScout: set API key. Получить ключ: ${keyUrl(providerName)}`);
  }
  const files = readGitDiff(workspaceRoot, { lastCommit });
  if (files.length === 0) return { issues: [], filesAnalyzed: 0, durationMs: Date.now() - startedAt };

  const provider = createProvider(providerName, apiKey, model, (event) => onRetry(event, model), baseUrl);
  const issues: ReviewIssue[] = [];
  for (const file of files) {
    for (const chunk of splitPatch(file.patch, 45_000)) {
      const raw = await provider.review(SYSTEM_PROMPT, buildReviewPrompt(file, chunk));
      const parsed = parseReviewResponse(raw, file.filename);
      issues.push(...parsed.issues.map((issue) => correctIssueLine(issue, workspaceRoot)));
    }
  }
  return { issues, filesAnalyzed: files.length, durationMs: Date.now() - startedAt };
}

async function runReview(context: vscode.ExtensionContext, lastCommit: boolean, output: vscode.OutputChannel, panel: CodeScoutPanel): Promise<void> {
  output.clear();
  output.show(true);
  output.appendLine(lastCommit ? 'CodeScout: reviewing last commit...' : 'CodeScout: reviewing uncommitted changes...');
  panel.setScanning(true);
  try {
    const result = await reviewWorkspace(context, lastCommit, (event, model) => panel.setRetry(event, model));
    const stats = buildStats(result.issues, result.filesAnalyzed, result.durationMs);
    panel.update(result.issues, stats);
    await vscode.commands.executeCommand('codescout.panel.focus');
    if (result.issues.length === 0) output.appendLine('No issues found.');
    else {
      output.appendLine(`${result.issues.length} issue${result.issues.length === 1 ? '' : 's'} found:`);
      output.appendLine('');
      for (const issue of result.issues) output.appendLine(formatIssue(issue));
    }
    void vscode.window.showInformationMessage(`CodeScout: ${result.issues.length} issues found`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    panel.setError(message);
    output.appendLine(`Error: ${message}`);
    void vscode.window.showErrorMessage(`CodeScout: ${message}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CodeScout');
  const panel = new CodeScoutPanel();
  context.subscriptions.push(output);
  const syncKeyStatus = async (): Promise<void> => {
    const config = vscode.workspace.getConfiguration('codescout');
    const provider = config.get<string>('provider', 'gemini');
    panel.setKey(await resolveExtensionKey(context, provider, config.get<string>('apiKey')));
  };
  void syncKeyStatus();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codescout.panel', panel),
    vscode.commands.registerCommand('codescout.scanUncommitted', () => runReview(context, false, output, panel)),
    vscode.commands.registerCommand('codescout.scanLastCommit', () => runReview(context, true, output, panel)),
    vscode.commands.registerCommand('codescout.setApiKey', async () => {
      const key = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true, prompt: 'Вставь API-ключ Gemini (начинается с AIza)' });
      if (!key?.trim()) return;
      await context.secrets.store(SECRET_KEY, key.trim());
      panel.setKey(key.trim());
      void vscode.window.showInformationMessage('✅ Ключ сохранён защищённо');
    }),
    vscode.commands.registerCommand('codescout.clearApiKey', async () => {
      const answer = await vscode.window.showWarningMessage('Удалить сохранённый API-ключ CodeScout?', { modal: true }, 'Удалить');
      if (answer !== 'Удалить') return;
      await context.secrets.delete(SECRET_KEY);
      panel.setKey(undefined);
      void vscode.window.showInformationMessage('Ключ удалён из защищённого хранилища');
    })
  );
}

export function deactivate(): void {}
