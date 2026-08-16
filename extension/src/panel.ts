import * as vscode from 'vscode';
import { ReviewIssue } from '../../src/types';
import { buildEmptyReportHtml, buildReportHtml, ReportStats } from './reportHtml';

export class CodeScoutPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private issues: ReviewIssue[] = [];
  private stats: ReportStats = { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 };

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: false };
    webviewView.webview.html = this.issues.length > 0 || this.stats.files > 0
      ? buildReportHtml(this.issues, this.stats)
      : buildEmptyReportHtml();
  }

  update(issues: ReviewIssue[], stats: ReportStats): void {
    this.issues = issues;
    this.stats = stats;
    if (this.view) this.view.webview.html = buildReportHtml(issues, stats);
  }
}
