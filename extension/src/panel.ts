import * as vscode from 'vscode';
import { ReviewIssue } from '../../src/types';
import { RetryEvent } from '../../src/llm-client';
import { maskApiKey } from '../../src/providers';
import { relative, resolve } from 'node:path';
import { buildEmptyReportHtml, buildReportHtml, ReportStats } from './reportHtml';

interface ScanMessage {
  command?: string;
  file?: string;
  line?: number | string;
}

export class CodeScoutPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private issues: ReviewIssue[] = [];
  private stats: ReportStats = { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 };
  private hasRun = false;
  private scanning = false;
  private statusMessage = '';
  private   statusKind: 'retry' | 'error' | 'test' = 'retry';
  private testMode = false;
  private progressMessage = '';
  private keyMask = '';
  private keyConfigured = false;
  private provider = 'gemini';
  private model = 'gemini-2.5-flash';
  private welcomeBanner = false;
  private onWelcomeChoice?: () => void;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((message: ScanMessage) => {
      if (message.command === 'scanLastCommit') {
        void vscode.commands.executeCommand('codescout.scanLastCommit');
      } else if (message.command === 'scanUncommitted') {
        void vscode.commands.executeCommand('codescout.scanUncommitted');
      } else if (message.command === 'scanFull' || message.command === 'startFullAudit') {
        this.onWelcomeChoice?.();
        this.welcomeBanner = false;
        this.render();
        void vscode.commands.executeCommand('codescout.scanFull');
      } else if (message.command === 'dismissWelcome') {
        this.onWelcomeChoice?.();
        this.welcomeBanner = false;
        this.render();
      } else if (message.command === 'setApiKey') {
        void vscode.commands.executeCommand('codescout.setApiKey');
      } else if (message.command === 'clearApiKey') {
        void vscode.commands.executeCommand('codescout.clearApiKey');
      } else if (message.command === 'chooseModel') {
        void vscode.commands.executeCommand('codescout.chooseModel');
      } else if (message.command === 'openKeyLink') {
        void vscode.env.openExternal(vscode.Uri.parse('https://aistudio.google.com/apikey'));
      } else if (message.command === 'testSample') {
        void vscode.commands.executeCommand('codescout.testSample');
      } else if (message.command === 'cancelScan') {
        void vscode.commands.executeCommand('codescout.cancelScan');
      } else if (message.command === 'openFile' && message.file && message.line !== undefined) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!root) {
          void vscode.window.showErrorMessage('Открой папку workspace, чтобы перейти к файлу.');
          return;
        }
        // Legacy path contract: vscode.Uri.joinPath(root, message.file)
        const candidate = resolve(root.fsPath, message.file);
        const outsideWorkspace = relative(root.fsPath, candidate).startsWith('..');
        if (outsideWorkspace) {
          void vscode.window.showErrorMessage(`Файл не найден в workspace: ${message.file}`);
          return;
        }
        const fileUri = vscode.Uri.file(candidate);
        void vscode.workspace.openTextDocument(fileUri).then((document) => {
          const line = Math.max(0, Number(message.line) - 1);
          const position = new vscode.Position(Math.min(line, document.lineCount - 1), 0);
          return vscode.window.showTextDocument(document, { preview: false }).then((editor) => {
            const range = new vscode.Range(position, position);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(position, position);
          });
        }, () => {
          void vscode.window.showErrorMessage(`Файл не найден в workspace: ${message.file}`);
        });
      }
    }, undefined, []);
    this.render();
  }

  setWelcomeChoiceHandler(handler: () => void): void {
    this.onWelcomeChoice = handler;
  }

  setWelcomeBanner(visible: boolean): void {
    this.welcomeBanner = visible;
    this.render();
  }

  setKey(key: string | undefined, provider = 'gemini', model = 'gemini-2.5-flash'): void {
    this.keyConfigured = Boolean(key?.trim());
    this.keyMask = key ? maskApiKey(key) : '';
    this.provider = provider;
    this.model = model;
    this.render();
  }

  setScanning(scanning: boolean): void {
    this.scanning = scanning;
    if (scanning) {
      this.statusMessage = '';
      this.progressMessage = '';
      this.statusKind = 'retry';
    }
    this.render();
  }

  setProgress(index: number, total: number, filename: string, label = '🔎 Проверяю файл', elapsedMs = 0): void {
    this.scanning = true;
    this.progressMessage = `${label} ${index}/${total}: ${filename}... · ⏱ ${Math.floor(elapsedMs / 1000)}с`;
    this.render();
  }

  setModelThinking(elapsedMs = 0): void {
    this.scanning = true;
    this.progressMessage = `🤖 Модель думает... · ⏱ ${Math.floor(elapsedMs / 1000)}с`;
    this.render();
  }

  setRetry(event: RetryEvent, model = 'model'): void {
    this.scanning = true;
    this.statusKind = 'retry';
    this.statusMessage = `⏳ Rate limit у ${model}, ожидание ${event.waitSeconds}с (попытка ${event.attempt}/${event.maxRetries})...`;
    this.render();
  }

  setCancelled(): void {
    this.scanning = false;
    this.hasRun = true;
    this.progressMessage = '';
    this.statusKind = 'error';
    this.statusMessage = '⛔ Сканирование остановлено пользователем';
    this.render();
  }

  setError(message: string): void {
    this.scanning = false;
    this.hasRun = true;
    this.testMode = false;
    this.progressMessage = '';
    this.statusKind = 'error';
    this.statusMessage = message;
    this.render();
  }

  update(issues: ReviewIssue[], stats: ReportStats, testMode = false, testMessage = '', testWarning = false): void {
    this.issues = issues;
    this.stats = stats;
    this.hasRun = true;
    this.scanning = false;
    this.testMode = testMode;
    this.progressMessage = '';
    this.statusMessage = testMessage;
    this.statusKind = testWarning ? 'error' : testMode ? 'test' : 'retry';
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    this.view.webview.html = this.hasRun || this.scanning
      ? buildReportHtml(this.issues, this.stats, this.scanning, !this.hasRun, this.statusMessage, this.statusKind, this.keyMask, this.keyConfigured, this.provider, this.model, this.testMode, this.progressMessage, this.welcomeBanner)
      : buildEmptyReportHtml(this.keyMask, this.keyConfigured, this.provider, this.model, this.welcomeBanner);
  }
}
