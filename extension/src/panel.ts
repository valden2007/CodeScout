import * as vscode from 'vscode';
import { ReviewIssue } from '../../src/types';
import { RetryEvent } from '../../src/llm-client';
import { maskApiKey } from '../../src/providers';
import { buildEmptyReportHtml, buildReportHtml, ReportStats } from './reportHtml';

interface ScanMessage {
  command?: string;
}

export class CodeScoutPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private issues: ReviewIssue[] = [];
  private stats: ReportStats = { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 };
  private hasRun = false;
  private scanning = false;
  private statusMessage = '';
  private statusKind: 'retry' | 'error' = 'retry';
  private keyMask = '';
  private keyConfigured = false;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((message: ScanMessage) => {
      if (message.command === 'scanLastCommit') {
        void vscode.commands.executeCommand('codescout.scanLastCommit');
      } else if (message.command === 'scanUncommitted') {
        void vscode.commands.executeCommand('codescout.scanUncommitted');
      } else if (message.command === 'setApiKey') {
        void vscode.commands.executeCommand('codescout.setApiKey');
      } else if (message.command === 'clearApiKey') {
        void vscode.commands.executeCommand('codescout.clearApiKey');
      } else if (message.command === 'openKeyLink') {
        void vscode.env.openExternal(vscode.Uri.parse('https://aistudio.google.com/apikey'));
      }
    }, undefined, []);
    this.render();
  }

  setKey(key?: string): void {
    this.keyConfigured = Boolean(key?.trim());
    this.keyMask = key ? maskApiKey(key) : '';
    this.render();
  }

  setScanning(scanning: boolean): void {
    this.scanning = scanning;
    if (scanning) {
      this.statusMessage = '';
      this.statusKind = 'retry';
    }
    this.render();
  }

  setRetry(event: RetryEvent, model = 'model'): void {
    this.scanning = true;
    this.statusKind = 'retry';
    this.statusMessage = `⏳ Rate limit у ${model}, ожидание ${event.waitSeconds}с (попытка ${event.attempt}/${event.maxRetries})...`;
    this.render();
  }

  setError(message: string): void {
    this.scanning = false;
    this.hasRun = true;
    this.statusKind = 'error';
    this.statusMessage = message;
    this.render();
  }

  update(issues: ReviewIssue[], stats: ReportStats): void {
    this.issues = issues;
    this.stats = stats;
    this.hasRun = true;
    this.scanning = false;
    this.statusMessage = '';
    this.statusKind = 'retry';
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    this.view.webview.html = this.hasRun || this.scanning
      ? buildReportHtml(this.issues, this.stats, this.scanning, !this.hasRun, this.statusMessage, this.statusKind, this.keyMask, this.keyConfigured)
      : buildEmptyReportHtml(this.keyMask, this.keyConfigured);
  }
}
