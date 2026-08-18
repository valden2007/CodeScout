import * as vscode from 'vscode';
import { createProvider, RetryEvent } from '../../src/llm-client';
import { buildReviewPrompt, SYSTEM_PROMPT } from '../../src/prompt-builder';
import { parseReviewResponse } from '../../src/response-parser';
import { correctIssueLine } from '../../src/line-correction';
import { splitPatch } from '../../src/diff-parser';
import { defaultModel, detectProvider, keyUrl, ProviderName, resolveApiKeyPriority } from '../../src/providers';
import { readGitDiff } from '../../src/tui/DiffReader';
import { ReviewIssue } from '../../src/types';
import { CodeScoutPanel } from './panel';
import { ReportStats } from './reportHtml';

const SECRET_KEY = 'codescout.apiKey';
const SECRET_PROVIDER = 'codescout.provider';
const SECRET_MODEL = 'codescout.model';

interface ScanResult {
  issues: ReviewIssue[];
  filesAnalyzed: number;
  durationMs: number;
}

interface ProviderSelection {
  provider: ProviderName;
  model: string;
  key?: string;
  baseUrl?: string;
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

async function resolveExtensionSelection(context: vscode.ExtensionContext): Promise<ProviderSelection> {
  const config = vscode.workspace.getConfiguration('codescout');
  const secretKey = await context.secrets.get(SECRET_KEY);
  const secretProvider = await context.secrets.get(SECRET_PROVIDER);
  const secretModel = await context.secrets.get(SECRET_MODEL);
  const settingsProvider = config.get<string>('provider')?.trim();
  const settingsModel = config.get<string>('model')?.trim();
  const provider = (secretProvider?.trim() || settingsProvider || 'gemini') as ProviderName;
  const model = secretModel?.trim() || settingsModel || defaultModel(provider);
  const key = resolveApiKeyPriority(secretKey, provider, config.get<string>('apiKey'));
  return {
    provider,
    model,
    key,
    baseUrl: config.get<string>('baseUrl')?.trim() || process.env.CODESCOUT_BASE_URL
  };
}

async function reviewWorkspace(context: vscode.ExtensionContext, lastCommit: boolean, onRetry: (event: RetryEvent, model: string) => void): Promise<ScanResult> {
  const startedAt = Date.now();
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) throw new Error('Открой папку с Git-репозиторием в VS Code и повтори команду.');

  const selection = await resolveExtensionSelection(context);
  if (!selection.key) {
    throw new Error(`Не найден API-ключ для ${selection.provider}. Укажи codescout.apiKey или выполни CodeScout: set API key. Получить ключ: ${keyUrl(selection.provider)}`);
  }
  const files = readGitDiff(workspaceRoot, { lastCommit });
  if (files.length === 0) return { issues: [], filesAnalyzed: 0, durationMs: Date.now() - startedAt };

  const provider = createProvider(selection.provider, selection.key, selection.model, (event) => onRetry(event, selection.model), selection.baseUrl);
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
    const selection = await resolveExtensionSelection(context);
    panel.setKey(selection.key, selection.provider, selection.model);
  };
  void syncKeyStatus();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codescout.panel', panel),
    vscode.commands.registerCommand('codescout.scanUncommitted', () => runReview(context, false, output, panel)),
    vscode.commands.registerCommand('codescout.scanLastCommit', () => runReview(context, true, output, panel)),
    vscode.commands.registerCommand('codescout.setApiKey', async () => {
      const key = await vscode.window.showInputBox({ password: true, ignoreFocusOut: true, prompt: 'Вставь API-ключ Gemini (начинается с AIza)' });
      if (!key?.trim()) return;
      const detected = detectProvider(key);
      let selection: { provider: ProviderName; model: string } | undefined = detected ?? undefined;
      if (!selection) {
        const picked = await vscode.window.showQuickPick(['gemini', 'groq', 'openrouter', 'github', 'custom'], { placeHolder: 'Выбери провайдер' });
        if (!picked) return;
        selection = { provider: picked as ProviderName, model: defaultModel(picked) };
      }
      await context.secrets.store(SECRET_KEY, key.trim());
      await context.secrets.store(SECRET_PROVIDER, selection.provider);
      await context.secrets.store(SECRET_MODEL, selection.model);
      panel.setKey(key.trim(), selection.provider, selection.model);
      const source = detected ? 'определено автоматически' : 'выбрано вручную';
      void vscode.window.showInformationMessage(`✅ Ключ сохранён. Провайдер: ${selection.provider}, модель: ${selection.model} (${source})`);
    }),
    vscode.commands.registerCommand('codescout.clearApiKey', async () => {
      const answer = await vscode.window.showWarningMessage('Удалить сохранённый API-ключ CodeScout?', { modal: true }, 'Удалить');
      if (answer !== 'Удалить') return;
      await context.secrets.delete(SECRET_KEY);
      await context.secrets.delete(SECRET_PROVIDER);
      await context.secrets.delete(SECRET_MODEL);
      panel.setKey(undefined);
      void vscode.window.showInformationMessage('Ключ удалён из защищённого хранилища');
    })
  );
}

export function deactivate(): void {}
