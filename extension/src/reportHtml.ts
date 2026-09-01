import { ReviewIssue } from '../../src/types';
import type { AuditResumeView, FindingsDiffView } from './projectAudit';

export interface AutoResumeIndicator {
  done: number;
  total: number;
  secondsLeft: number;
  attempt: number;
  maxAttempts: number;
}

export interface ReportStats {
  files: number;
  seconds: number;
  critical: number;
  medium: number;
  low: number;
}

const severityOrder: Record<ReviewIssue['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function severityLabel(severity: ReviewIssue['severity']): string {
  return severity.toUpperCase();
}

function severityEmoji(severity: ReviewIssue['severity']): string {
  if (severity === 'critical' || severity === 'high') return '🔴';
  if (severity === 'medium') return '🟡';
  return '🟢';
}

function severityClass(severity: ReviewIssue['severity']): string {
  if (severity === 'critical' || severity === 'high') return 'critical';
  return severity;
}

function issueCard(issue: ReviewIssue, isNew = false): string {
  const severity = severityClass(issue.severity);
  const code = issue.code ? `<pre><code>${escapeHtml(issue.code)}</code></pre>` : '';
  const suggestion = issue.suggestion ? `<div class="suggestion"><span>→</span> ${escapeHtml(issue.suggestion)}</div>` : '';
  return `<article class="issue-card ${severity}">
  <div class="issue-top"><span class="badge ${severity}">${severityEmoji(issue.severity)} ${severityLabel(issue.severity)}</span>${isNew ? '<span class="badge new">🆕 новая</span>' : ''}<span class="category">${escapeHtml(issue.category)}</span><span class="confidence">${Math.round(issue.confidence * 100)}%</span></div>
  <a class="location" href="#" data-command="openFile" data-file="${escapeHtml(issue.file)}" data-line="${issue.line}">${escapeHtml(issue.file)}:${issue.line}</a>
  <div class="description">${escapeHtml(issue.description)}</div>
  ${code}
  ${suggestion}
</article>`;
}

function autoLineHtml(autoResume?: AutoResumeIndicator): string {
  if (!autoResume) return '<div class="auto-line hidden" id="autoLine"></div>';
  return `<div class="auto-line" id="autoLine" data-done="${autoResume.done}" data-total="${autoResume.total}" data-attempt="${autoResume.attempt}" data-max="${autoResume.maxAttempts}" data-seconds="${autoResume.secondsLeft}">🤖 авто-догон: ${autoResume.done}/${autoResume.total}, попытка ${autoResume.attempt}/${autoResume.maxAttempts} через ${autoResume.secondsLeft}с</div>`;
}

export function buildReportHtml(issues: ReviewIssue[], stats: ReportStats, isScanning = false, emptyState = false, statusMessage = '', statusKind: 'retry' | 'error' | 'test' | 'success' = 'retry', keyMask = '', keyConfigured = false, provider = 'gemini', model = 'gemini-2.5-flash', testMode = false, progressMessage = '', welcomeBanner = false, welcomeReason: 'new' | 'stale' = 'new', findingsDiff?: FindingsDiffView, customFocus = '', auditResume?: AuditResumeView, autoResume?: AutoResumeIndicator): string {
  const sorted = [...issues].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const newKeys = new Set(findingsDiff?.newKeys ?? []);
  const grouped = new Map<string, ReviewIssue[]>();
  for (const issue of sorted) grouped.set(issue.file, [...(grouped.get(issue.file) ?? []), issue]);
  const sections = [...grouped.entries()].map(([file, fileIssues]) => `<section class="file-section"><h2>${escapeHtml(file)}</h2>${fileIssues.map((issue) => issueCard(issue, newKeys.has(`${issue.file}:${issue.line}:${issue.category}`))).join('')}</section>`).join('');
  const diffSummary = findingsDiff ? `<div class="diff-summary">${escapeHtml(findingsDiff.summary)}</div>` : '';
  const customBanner = customFocus ? `<div class="diff-summary custom">🎯 Кастомное ревью: ${escapeHtml(customFocus.slice(0, 160))}</div>` : '';
  const fixedBlock = findingsDiff?.fixed?.length
    ? `<details class="fixed-block"><summary>✅ Починено с прошлого скана (${findingsDiff.fixed.length})</summary><ul>${findingsDiff.fixed.map((entry) => `<li><strong>${escapeHtml(entry.file)}:${entry.line}</strong> · ${escapeHtml(entry.category)} — ${escapeHtml(entry.description.slice(0, 140))}</li>`).join('')}</ul></details>`
    : '';
  const body = sections || (emptyState && !keyConfigured
    ? '<div class="onboarding"><div class="empty-icon">👋</div><h1>Привет! Это CodeScout</h1><p><strong>Шаг 1.</strong> Получите API-ключ провайдера в <a class="link-button" href="https://aistudio.google.com/apikey" data-command="openKeyLink">Открыть Google AI Studio</a>.</p><p><strong>Шаг 2.</strong> Нажми кнопку ниже и вставь ключ.</p><button class="primary-action" type="button" data-command="setApiKey">🔑 Вставить ключ — провайдер определится сам</button><p><strong>Шаг 3.</strong> Готово — кнопки выше заработают.</p></div>'
    : emptyState
      ? '<div class="empty"><div class="empty-icon">🕵️</div><strong>CodeScout готов к работе</strong><small>Нажмите одну из кнопок выше, чтобы начать ревью.</small></div>'
      : testMode
        ? '<div class="empty"><div class="empty-icon">🧪</div><strong>🧪 ТЕСТ</strong><small>Проверка завершена на встроенном примере.</small></div>'
        : `<div class="empty"><div class="empty-icon">✅</div><strong>Проверено файлов: ${stats.files} — проблем не найдено</strong><small>Сомневаешься? Проверь, как CodeScout ловит баги:</small><button class="primary-action" type="button" data-command="testSample">🧪 Тест на примере</button></div>`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px 14px 24px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.45; }
.header { position: sticky; top: -16px; z-index: 2; margin: -16px -14px 0; padding: 14px 14px 12px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
.brand { display: flex; align-items: center; gap: 8px; font-size: 17px; font-weight: 700; letter-spacing: -0.2px; }
.brand-settings { flex: 0 0 auto; width: auto; margin-left: auto; padding: 2px 9px; font-size: 11px; font-weight: 400; text-align: center; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
.brand-settings:hover { background: var(--vscode-button-secondaryHoverBackground); }
.brand-mark { color: var(--vscode-textLink-foreground); }
.key-status { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-top: 7px; color: var(--vscode-descriptionForeground); font-size: 11px; }
.key-status button { width: auto; padding: 2px 5px; font-size: 10px; }
.key-status.ready { color: var(--vscode-testing-iconPassed); }
.key-status.missing { color: var(--vscode-errorForeground); }
.welcome-banner { margin: 0; padding: 9px; border: 1px solid var(--vscode-textLink-foreground); border-radius: 4px; color: var(--vscode-editor-foreground); background: color-mix(in srgb, var(--vscode-textLink-foreground) 10%, transparent); }
.welcome-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.welcome-actions button { flex: 1 1 120px; }
.welcome-overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--vscode-editor-background) 68%, transparent); backdrop-filter: blur(2px); z-index: 9999; pointer-events: auto; }
.welcome-card { pointer-events: auto; }
body.modal { pointer-events: none; }
body.modal .welcome-overlay { pointer-events: auto; }
body.modal .welcome-overlay * { pointer-events: auto; }
.onboarding { padding: 36px 10px; text-align: center; }
.onboarding h1 { margin: 0 0 14px; font-size: 16px; }
.onboarding p { margin: 12px 0; color: var(--vscode-descriptionForeground); }
.link-button { display: inline; width: auto; padding: 0; color: var(--vscode-textLink-foreground); background: transparent; text-decoration: underline; }
.primary-action { width: auto; margin: 4px auto 8px; padding: 8px 14px; text-align: center; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
button { flex: 1 1 150px; width: auto; padding: 6px 9px; border: 1px solid transparent; border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button:disabled { opacity: 0.65; cursor: default; }
.cancel-action { display: block; margin-top: 8px; border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent); }
.spinner { display: inline-block; width: 11px; margin-right: 4px; }
.status-banner { margin-top: 10px; padding: 7px 8px; border-left: 3px solid var(--vscode-editorWarning-foreground); border-radius: 3px; color: var(--vscode-editorWarning-foreground); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, transparent); font-size: 12px; }
.status-banner.error { border-left-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); }
.status-banner.test { border-left-color: var(--vscode-testing-iconPassed); color: var(--vscode-testing-iconPassed); background: color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent); }
.status-banner.success { border-left-color: var(--vscode-testing-iconPassed); color: var(--vscode-testing-iconPassed); background: color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent); }
.test-badge { display: inline-block; margin-left: 8px; color: var(--vscode-testing-iconPassed); font-size: 11px; font-weight: 700; }
.animated-dots { display: inline-block; width: 16px; overflow: hidden; animation: dots 1.2s steps(4, end) infinite; }
@keyframes dots { 0% { width: 0; } 25% { width: 5px; } 50% { width: 10px; } 75% { width: 15px; } 100% { width: 16px; } }
.progress-line { margin-top: 7px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.stats { margin-top: 9px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.pills { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
.pill, .badge { border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.pill.critical, .badge.critical { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 15%, transparent); }
.pill.medium, .badge.medium { color: var(--vscode-editorWarning-foreground); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 15%, transparent); }
.pill.low, .badge.low { color: var(--vscode-testing-iconPassed); background: color-mix(in srgb, var(--vscode-testing-iconPassed) 15%, transparent); }
.file-section { margin-top: 18px; }
h2 { margin: 0 0 8px; color: var(--vscode-textLink-foreground); font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.issue-card { margin: 8px 0; padding: 10px 10px 11px; border: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--vscode-testing-iconPassed); border-radius: 4px; background: var(--vscode-textCodeBlock-background); }
.issue-card.critical { border-left-color: var(--vscode-errorForeground); }
.issue-card.medium { border-left-color: var(--vscode-editorWarning-foreground); }
.issue-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.category { color: var(--vscode-descriptionForeground); font-size: 11px; }
.confidence { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
.location { display: block; margin: 6px 0; color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family); font-size: 11px; overflow-wrap: anywhere; text-decoration: underline; }
.description { margin-top: 5px; }
pre { margin: 9px 0; padding: 8px; overflow-x: auto; border: 1px solid var(--vscode-textBlockQuote-border); border-radius: 3px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: pre-wrap; word-break: break-word; }
.suggestion { color: var(--vscode-testing-iconPassed); }
.suggestion span { font-weight: 700; }
.empty { padding: 48px 10px; color: var(--vscode-descriptionForeground); text-align: center; }
.empty-icon { margin-bottom: 8px; color: var(--vscode-testing-iconPassed); font-size: 24px; }
.empty small { display: block; margin-top: 5px; }
.diff-summary { margin-top: 12px; padding: 7px 9px; border: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--vscode-textLink-foreground); border-radius: 3px; background: color-mix(in srgb, var(--vscode-textLink-foreground) 8%, transparent); font-size: 12px; }
.badge.new { color: var(--vscode-textLink-foreground); background: color-mix(in srgb, var(--vscode-textLink-foreground) 15%, transparent); }
.fixed-block { margin-top: 18px; }
.fixed-block summary { cursor: pointer; color: var(--vscode-testing-iconPassed); font-size: 12px; font-weight: 600; }
.fixed-block ul { margin: 8px 0; padding-left: 18px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.fixed-block li { margin: 4px 0; overflow-wrap: anywhere; }
.hidden { display: none; }
.custom-form { margin-top: 10px; padding: 10px; border: 1px dashed var(--vscode-panel-border); border-radius: 4px; }
.custom-form label { display: block; margin: 0 0 5px; color: var(--vscode-descriptionForeground); font-size: 11px; }
.custom-form textarea, .custom-form select, .custom-form input { width: 100%; padding: 6px 8px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; font-size: 12px; }
.custom-form textarea { resize: vertical; }
.custom-scope { margin-top: 8px; }
.custom-scope select { width: auto; }
.custom-actions { margin-top: 8px; }
.custom-actions button { width: auto; padding: 6px 12px; text-align: center; }
.audit-resume { margin-top: 10px; padding: 9px; border: 1px solid var(--vscode-editorWarning-foreground); border-radius: 4px; background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 10%, transparent); font-size: 12px; }
.auto-line { margin-top: 7px; color: var(--vscode-textLink-foreground); font-size: 12px; font-weight: 600; }
.search-line { margin-top: 10px; }
.search-line input { width: 100%; padding: 5px 8px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; font-size: 12px; }
</style>
</head>
<body>
  <header class="header">
    ${welcomeBanner ? `<div class="welcome-overlay" role="dialog" aria-modal="true" aria-labelledby="welcome-title" tabindex="0" data-command="dismissWelcome"><div class="welcome-card"><div class="welcome-banner"><strong id="welcome-title">${welcomeReason === 'stale' ? '⚙️ Модель изменилась — контекст мог устареть. Обновить полным аудитом?' : '🔬 CodeScout может изучить проект целиком — ревью станет точнее. Запустить полный аудит?'}</strong><div class="welcome-actions"><button type="button" data-command="startFullAudit">${welcomeReason === 'stale' ? '🔄 Обновить' : '🚀 Запустить аудит'}</button><button type="button" data-command="dismissWelcome">Позже</button></div></div></div></div>` : ''}
    <div class="brand"><span class="brand-mark">🕵️</span> CodeScout <button class="brand-settings" type="button" data-command="openSettings" title="Открыть настройки CodeScout">⚙️ Настройки</button></div>
    <div class="key-status ${keyConfigured ? 'ready' : 'missing'}">${keyConfigured ? `🟢 ${escapeHtml(provider)} · ${escapeHtml(model)} · ${escapeHtml(keyMask)} (защищённо)` : '🔴 Ключ не настроен'} <button type="button" data-command="openSettings">🔑 Ключ и модель</button></div>
    ${testMode ? '<span class="test-badge">🧪 ТЕСТ</span>' : ''}
    <div id="statusSlot">${statusMessage ? `<div class="status-banner ${statusKind}">${escapeHtml(statusMessage)}${statusKind === 'retry' ? '<span class="animated-dots">...</span>' : ''}${statusKind === 'error' && statusMessage.includes('404') ? '<button type="button" data-command="chooseModel">🔄 Выбрать доступную модель</button>' : ''}</div>` : ''}</div>
    ${auditResume ? `<div class="audit-resume"><strong>⏸ Аудит оборвался: проверено ${auditResume.done} из ${auditResume.total} файлов (${escapeHtml(auditResume.model)})</strong><div class="welcome-actions"><button type="button" data-command="resumeAudit">▶️ Продолжить (${auditResume.done} из ${auditResume.total})</button><button type="button" data-command="restartAudit">🆕 Начать заново</button></div></div>` : ''}
    <div class="actions">
      <button type="button" data-command="scanLastCommit" ${isScanning ? 'disabled' : ''}>${isScanning ? '<span class="spinner">◌</span>' : '🔍'} Проверить последний коммит</button>
      <button type="button" data-command="scanUncommitted" ${isScanning ? 'disabled' : ''}>${isScanning ? '<span class="spinner">◌</span>' : '📝'} Проверить изменения до коммита</button>
      <button type="button" data-command="scanFull" ${isScanning ? 'disabled' : ''}>🔬 Полный аудит проекта</button>
      <button type="button" id="toggleCustomForm" ${isScanning ? 'disabled' : ''}>🎯 Своё ревью</button>
    </div>
    <div class="custom-form hidden" id="customForm">
      <label for="customFocusText">Что проверить?</label>
      <textarea id="customFocusText" rows="3" placeholder="например: все ли обращения к БД внутри транзакций?"></textarea>
      <div class="custom-scope">
        <select id="customScope">
          <option value="all">все файлы проекта</option>
          <option value="active">только открытый файл</option>
          <option value="list">список файлов (глобы через запятую)</option>
        </select>
        <input id="customGlobs" type="text" class="hidden" placeholder="src/**/*.ts, tests/*.py" autocomplete="off">
      </div>
      <div class="custom-actions">
        <button type="button" id="startCustomReview">🎯 Запустить своё ревью</button>
      </div>
    </div>
    ${isScanning || progressMessage ? `<div class="progress-line" id="progressLine" data-live="${isScanning}">${escapeHtml(progressMessage || 'Запускаю проверку…')}</div>` : ''}
    ${autoLineHtml(autoResume)}
    ${isScanning ? '<button class="cancel-action" type="button" data-command="cancelScan">⛔ Остановить</button>' : ''}
    <div class="stats"><strong>${issues.length} issues</strong> · ${stats.files} files · ${stats.seconds.toFixed(1)}s</div>
    <div class="pills"><span class="pill critical">🔴 ${stats.critical}</span><span class="pill medium">🟡 ${stats.medium}</span><span class="pill low">🟢 ${stats.low}</span></div>
  </header>
  ${sections ? '<div class="search-line"><input id="fileSearch" type="search" placeholder="🔍 поиск файла…" autocomplete="off" spellcheck="false"></div>' : ''}
  <main>${customBanner}${diffSummary}${body}${fixedBlock}</main>
    <script>
    const vscode = acquireVsCodeApi();
    const overlay = document.querySelector('.welcome-overlay');
    if (overlay) {
      document.body.classList.add('modal');
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && document.querySelector('.welcome-overlay')) {
          event.preventDefault();
          vscode.postMessage({ command: 'dismissWelcome' });
        }
      });
      overlay.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') return;
        const focusable = overlay.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])');
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      });
    } else {
      document.body.classList.remove('modal');
    }
    function escapeText(value) {
      const div = document.createElement('div');
      div.textContent = value;
      return div.innerHTML;
    }
    function applyProgressText(text) {
      const line = document.getElementById('progressLine');
      if (line) line.textContent = text;
    }
    function applyStatus(message, kind) {
      const slot = document.getElementById('statusSlot');
      if (!slot) return;
      if (!message) {
        slot.innerHTML = '';
        return;
      }
      const safeKind = /^(retry|error|test|success)$/.test(String(kind)) ? String(kind) : 'retry';
      const dots = safeKind === 'retry' ? '<span class="animated-dots">...</span>' : '';
      const fix = safeKind === 'error' && message.includes('404') ? '<button type="button" data-command="chooseModel">🔄 Выбрать доступную модель</button>' : '';
      slot.innerHTML = '<div class="status-banner ' + safeKind + '">' + escapeText(message) + dots + fix + '</div>';
    }
    const live = { text: '', elapsed: 0, tick: false };
    const progressLine = document.getElementById('progressLine');
    if (progressLine) {
      live.text = progressLine.textContent;
      live.elapsed = Number((live.text.match(/⏱\\s*(\\d+)с/) || [])[1] || 0);
      live.tick = progressLine.dataset.live === 'true' && /⏱\\s*\\d+с/.test(live.text);
    }
    const auto = { on: false, done: 0, total: 0, attempt: 0, max: 0, seconds: 0 };
    const autoLine = document.getElementById('autoLine');
    function renderAuto() {
      if (!autoLine) return;
      if (!auto.on) { autoLine.classList.add('hidden'); return; }
      autoLine.classList.remove('hidden');
      autoLine.textContent = '🤖 авто-догон: ' + auto.done + '/' + auto.total + ', попытка ' + auto.attempt + '/' + auto.max + (auto.seconds > 0 ? ' через ' + auto.seconds + 'с' : ' — пробую снова…');
    }
    if (autoLine && !autoLine.classList.contains('hidden')) {
      auto.on = true;
      auto.done = Number(autoLine.dataset.done || 0);
      auto.total = Number(autoLine.dataset.total || 0);
      auto.attempt = Number(autoLine.dataset.attempt || 0);
      auto.max = Number(autoLine.dataset.max || 0);
      auto.seconds = Number(autoLine.dataset.seconds || 0);
    }
    const fileSearch = document.getElementById('fileSearch');
    if (fileSearch) fileSearch.addEventListener('input', () => {
      const q = fileSearch.value.trim().toLowerCase();
      document.querySelectorAll('main section.file-section').forEach((sec) => {
        const h2 = sec.querySelector('h2');
        const name = h2 ? (h2.textContent || '').toLowerCase() : '';
        sec.classList.toggle('hidden', q !== '' && !name.includes(q));
      });
    });
    window.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type === 'progress') {
        live.text = String(data.text || '');
        live.elapsed = Math.floor(Number(data.elapsedMs || 0) / 1000);
        live.tick = true;
        applyProgressText(live.text);
      } else if (data.type === 'status') {
        applyStatus(String(data.message || ''), data.kind === 'error' ? 'error' : data.kind === 'test' ? 'test' : data.kind === 'success' ? 'success' : 'retry');
      } else if (data.type === 'auto') {
        if (data.off) auto.on = false;
        else {
          auto.on = true;
          auto.done = Number(data.done || 0);
          auto.total = Number(data.total || 0);
          auto.attempt = Number(data.attempt || 0);
          auto.max = Number(data.maxAttempts || 0);
          auto.seconds = Number(data.secondsLeft || 0);
        }
        renderAuto();
      }
    });
    setInterval(() => {
      if (!live.tick) return;
      live.elapsed += 1;
      live.text = live.text.replace(/⏱\\s*\\d+с/, '⏱ ' + live.elapsed + 'с');
      applyProgressText(live.text);
    }, 1000);
    setInterval(() => {
      if (!auto.on || auto.seconds <= 0) return;
      auto.seconds -= 1;
      renderAuto();
    }, 1000);
    document.addEventListener('click', (event) => {
      const origin = event.target instanceof Element ? event.target : null;
      if (!origin) return;
      const toggle = origin.closest('#toggleCustomForm');
      if (toggle) {
        const form = document.getElementById('customForm');
        if (form) {
          form.classList.toggle('hidden');
          toggle.textContent = form.classList.contains('hidden') ? '🎯 Своё ревью' : '✖ Свернуть';
        }
        return;
      }
      if (origin.closest('#startCustomReview')) {
        const focusEl = document.getElementById('customFocusText');
        const scopeEl = document.getElementById('customScope');
        const globsEl = document.getElementById('customGlobs');
        const focus = focusEl ? focusEl.value.trim() : '';
        if (!focus) { if (focusEl) focusEl.focus(); return; }
        vscode.postMessage({ command: 'customReview', focus, scope: scopeEl ? scopeEl.value : 'all', globs: globsEl ? globsEl.value.trim() : '' });
        return;
      }
      const anchor = origin.closest('a[data-file]');
      if (anchor) {
        event.preventDefault();
        vscode.postMessage({ command: 'openFile', file: anchor.getAttribute('data-file'), line: anchor.getAttribute('data-line') });
        return;
      }
      const element = origin.closest('[data-command]');
      if (!element) return;
      if (element.classList.contains('welcome-overlay') && event.target !== element) {
        return;
      }
      event.preventDefault();
      vscode.postMessage({ command: element.dataset.command });
    });
    document.addEventListener('change', (event) => {
      const scope = event.target instanceof Element ? event.target.closest('#customScope') : null;
      if (!scope) return;
      const globsEl = document.getElementById('customGlobs');
      if (globsEl) globsEl.classList.toggle('hidden', scope.value !== 'list');
    });
  </script>
</body>
</html>`;
}

export function buildEmptyReportHtml(keyMask = '', keyConfigured = false, provider = 'gemini', model = 'gemini-2.5-flash', welcomeBanner = false, welcomeReason: 'new' | 'stale' = 'new', auditResume?: AuditResumeView): string {
  return buildReportHtml([], { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 }, false, true, '', 'retry', keyMask, keyConfigured, provider, model, false, '', welcomeBanner, welcomeReason, undefined, '', auditResume);
}
