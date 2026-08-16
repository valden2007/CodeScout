import * as vscode from 'vscode';
import { ReviewIssue } from '../../src/types';
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

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((message: ScanMessage) => {
      if (message.command === 'scanLastCommit') {
        void vscode.commands.executeCommand('codescout.scanLastCommit');
      } else if (message.command === 'scanUncommitted') {
        void vscode.commands.executeCommand('codescout.scanUncommitted');
      }
    }, undefined, []);
    this.render();
  }

  setScanning(scanning: boolean): void {
    this.scanning = scanning;
    this.render();
  }

  update(issues: ReviewIssue[], stats: ReportStats): void {
    this.issues = issues;
    this.stats = stats;
    this.hasRun = true;
    this.scanning = false;
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    this.view.webview.html = this.hasRun
      ? buildReportHtml(this.issues, this.stats, this.scanning)
      : (this.scanning
        ? buildReportHtml([], this.stats, true, true)
        : buildEmptyReportHtml());
  }
}
