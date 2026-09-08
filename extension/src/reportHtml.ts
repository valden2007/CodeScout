import { ReviewIssue } from '../../src/types';
import type { AuditResumeView, FindingsDiffView } from './projectAudit';
import { autoResumeBadgeText } from './projectAudit';
import { uiBodyAttrs, uiTokensCss, normalizeUiPrefs, type UiPrefsInput } from './uiPrefs';

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

export interface WebviewAssets {
  codiconCss: string;
  cspSource: string;
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

function icon(name: string, extra = ''): string {
  return `<i class="codicon codicon-${name}${extra ? ' ' + extra : ''}" aria-hidden="true"></i>`;
}

function severityLabel(severity: ReviewIssue['severity']): string {
  return severity.toUpperCase();
}

function severityIcon(severity: ReviewIssue['severity']): string {
  if (severity === 'critical' || severity === 'high') return icon('error');
  if (severity === 'medium') return icon('warning');
  return icon('pass');
}

function severityClass(severity: ReviewIssue['severity']): string {
  if (severity === 'critical' || severity === 'high') return 'critical';
  return severity;
}

function issueCard(issue: ReviewIssue, isNew = false, showConfidence = true): string {
  const severity = severityClass(issue.severity);
  const code = issue.code ? `<pre><code>${escapeHtml(issue.code)}</code></pre>` : '';
  const suggestion = issue.suggestion ? `<div class="suggestion">${icon('arrow-right')} <span>${escapeHtml(issue.suggestion)}</span></div>` : '';
  const confidence = showConfidence ? `<span class="confidence">${Math.round(issue.confidence * 100)}%</span>` : '';
  return `<article class="issue-card ${severity}">
  <div class="issue-top"><span class="badge ${severity}">${severityIcon(issue.severity)} ${severityLabel(issue.severity)}</span>${isNew ? `<span class="badge new">${icon('add')} новая</span>` : ''}<span class="category">${escapeHtml(issue.category)}</span>${confidence}</div>
  <a class="location" href="#" data-command="openFile" data-file="${escapeHtml(issue.file)}" data-line="${issue.line}">${escapeHtml(issue.file)}:${issue.line}</a>
  <div class="description">${escapeHtml(issue.description)}</div>
  ${code}
  ${suggestion}
</article>`;
}

function autoLineHtml(autoResume?: AutoResumeIndicator): string {
  if (!autoResume) return '<div class="auto-line hidden" id="autoLine"></div>';
  const attemptLabel = autoResume.maxAttempts > 0 ? `попытка ${autoResume.attempt}/${autoResume.maxAttempts}` : `попытка ${autoResume.attempt}`;
  return `<div class="auto-line" id="autoLine" data-done="${autoResume.done}" data-total="${autoResume.total}" data-attempt="${autoResume.attempt}" data-max="${autoResume.maxAttempts}" data-seconds="${autoResume.secondsLeft}">${icon('robot')} авто-догон: ${autoResume.done}/${autoResume.total}, ${attemptLabel} через ${autoResume.secondsLeft}с</div>`;
}

function headHtml(assets?: WebviewAssets, nonce = ''): string {
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const csp = assets
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${assets.cspSource}; img-src data:; style-src${nonce ? ` 'nonce-${nonce}'` : " 'unsafe-inline'"} ${assets.cspSource}; script-src${nonce ? ` 'nonce-${nonce}'` : " 'unsafe-inline'"};">`
    : '';
  const codiconLink = assets ? `<link rel="stylesheet" href="${assets.codiconCss}">` : '';
  return `<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${csp}
${codiconLink}
<style${nonceAttr}>
:root { color-scheme: dark; }
${uiTokensCss()}
* { box-sizing: border-box; }
body { margin: 0; padding: var(--cs-space-4) 14px 24px; color: var(--cs-fg); background: var(--cs-editor-bg); font-family: var(--vscode-font-family); font-size: var(--cs-font-3); line-height: 1.45; }
.header { position: sticky; top: calc(-1 * var(--cs-space-4)); z-index: 2; margin: calc(-1 * var(--cs-space-4)) -14px 0; padding: var(--cs-space-4) 14px var(--cs-space-3); border-bottom: 1px solid var(--cs-border); background: var(--cs-editor-bg); }
.brand { display: flex; align-items: center; gap: var(--cs-space-2); font-size: var(--cs-font-4); font-weight: 700; letter-spacing: -0.2px; }
.brand-settings { flex: 0 0 auto; width: auto; margin-left: auto; padding: 2px var(--cs-space-2); font-size: var(--cs-font-1); font-weight: 400; text-align: center; color: var(--cs-btn2-fg); background: var(--cs-btn2-bg); }
.brand-settings:hover { background: var(--cs-btn2-hover); }
.brand-mark { color: var(--cs-accent); display: inline-flex; }
.cs-btn { display: inline-flex; align-items: center; gap: var(--cs-space-2); }
.cs-btn .codicon { font-size: var(--cs-font-3); }
.key-status { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-top: 7px; color: var(--cs-desc); font-size: var(--cs-font-1); }
.key-status button { width: auto; padding: 2px 5px; font-size: var(--cs-font-1); }
.key-status.ready { color: var(--cs-pass); }
.key-status.missing { color: var(--cs-error); }
.chip { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 1px var(--cs-space-2); font-size: var(--cs-font-1); font-weight: 700; white-space: nowrap; }
.welcome-banner { margin: 0; padding: 9px; border: 1px solid var(--cs-accent); border-radius: var(--cs-radius-1); color: var(--cs-fg); background: var(--cs-card-bg); box-shadow: var(--cs-shadow); }
.welcome-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--cs-space-2); }
.welcome-actions button { flex: 1 1 120px; }
.welcome-overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--cs-editor-bg) 68%, transparent); backdrop-filter: blur(2px); z-index: 9999; pointer-events: auto; }
.welcome-card { pointer-events: auto; }
body.modal { pointer-events: none; }
body.modal .welcome-overlay { pointer-events: auto; }
body.modal .welcome-overlay * { pointer-events: auto; }
.onboarding { padding: 36px 10px; text-align: center; }
.onboarding h1 { margin: 0 0 14px; font-size: var(--cs-font-4); }
.onboarding p { margin: var(--cs-space-3) 0; color: var(--cs-desc); }
.link-button { display: inline; width: auto; padding: 0; color: var(--cs-accent); background: transparent; text-decoration: underline; }
.primary-action { width: auto; margin: var(--cs-space-1) auto var(--cs-space-2); padding: var(--cs-space-2) var(--cs-space-4); text-align: center; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: var(--cs-space-3); }
button { flex: 1 1 150px; width: auto; min-height: var(--cs-btn-height); padding: 6px 9px; border: 1px solid transparent; border-radius: var(--cs-radius-btn); color: var(--cs-btn-fg); background: var(--cs-btn-bg); font: inherit; font-size: var(--cs-font-2); cursor: pointer; text-align: left; }
button:hover:not(:disabled) { background: var(--cs-btn-hover); }
button:active:not(:disabled) { transform: translateY(1px); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button:disabled { opacity: 0.65; cursor: default; }
.cancel-action { display: flex; justify-content: center; margin-top: var(--cs-space-2); border-color: var(--cs-error); color: var(--cs-error); background: color-mix(in srgb, var(--cs-error) 14%, transparent); }
.spinner { display: inline-flex; }
.spinner .codicon { animation: cs-spin 1s linear infinite; }
@keyframes cs-spin { to { transform: rotate(360deg); } }
.status-banner { margin-top: 10px; padding: 7px var(--cs-space-2); border-left: 3px solid var(--cs-warn); border-radius: var(--cs-radius-1); color: var(--cs-warn); background: color-mix(in srgb, var(--cs-warn) 12%, transparent); font-size: var(--cs-font-2); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.status-banner.error { border-left-color: var(--cs-error); color: var(--cs-error); background: color-mix(in srgb, var(--cs-error) 12%, transparent); }
.status-banner.test, .status-banner.success { border-left-color: var(--cs-pass); color: var(--cs-pass); background: color-mix(in srgb, var(--cs-pass) 12%, transparent); }
.status-banner button { width: auto; flex: 0 0 auto; padding: 2px var(--cs-space-2); font-size: var(--cs-font-1); }
.test-badge { display: inline-flex; align-items: center; gap: 4px; margin-left: var(--cs-space-2); color: var(--cs-pass); font-size: var(--cs-font-1); font-weight: 700; }
.animated-dots { display: inline-block; width: 16px; overflow: hidden; animation: dots 1.2s steps(4, end) infinite; }
@keyframes dots { 0% { width: 0; } 25% { width: 5px; } 50% { width: 10px; } 75% { width: 15px; } 100% { width: 16px; } }
.progress-line { margin-top: 7px; color: var(--cs-desc); font-size: var(--cs-font-2); }
.stats { margin-top: 9px; color: var(--cs-desc); font-size: var(--cs-font-2); }
.pills { display: flex; gap: 6px; margin-top: var(--cs-space-3); flex-wrap: wrap; }
.pill, .badge { border-radius: 999px; padding: 2px var(--cs-space-2); font-size: var(--cs-font-1); font-weight: 700; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
.pill.critical, .badge.critical { color: var(--cs-error); background: color-mix(in srgb, var(--cs-error) 15%, transparent); }
.pill.medium, .badge.medium { color: var(--cs-warn); background: color-mix(in srgb, var(--cs-warn) 15%, transparent); }
.pill.low, .badge.low { color: var(--cs-pass); background: color-mix(in srgb, var(--cs-pass) 15%, transparent); }
.file-section { margin-top: 18px; }
h2 { margin: 0 0 var(--cs-space-2); color: var(--cs-accent); font-size: var(--cs-font-3); font-weight: 600; overflow-wrap: anywhere; }
.issue-card { margin: var(--cs-space-2) 0; padding: 10px 10px 11px; border: 1px solid var(--cs-card-border); border-left: 3px solid var(--cs-pass); border-radius: var(--cs-radius-card); background: var(--cs-card-bg); box-shadow: var(--cs-shadow); }
.issue-card.critical { border-left-color: var(--cs-error); }
.issue-card.medium { border-left-color: var(--cs-warn); }
.issue-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.category { color: var(--cs-desc); font-size: var(--cs-font-1); }
.confidence { margin-left: auto; color: var(--cs-desc); font-size: var(--cs-font-1); font-variant-numeric: tabular-nums; }
.location { display: block; margin: 6px 0; color: var(--cs-accent); font-family: var(--vscode-editor-font-family); font-size: var(--cs-font-1); overflow-wrap: anywhere; text-decoration: underline; }
.description { margin-top: 5px; }
pre { margin: 9px 0; padding: var(--cs-space-2); overflow-x: auto; border: 1px solid var(--cs-card-border); border-radius: 3px; background: var(--cs-code-bg); color: var(--cs-fg); font-family: var(--vscode-editor-font-family); font-size: var(--cs-font-1); white-space: pre-wrap; word-break: break-word; }
.suggestion { color: var(--cs-pass); display: flex; align-items: flex-start; gap: 6px; }
.empty { padding: 48px 10px; color: var(--cs-desc); text-align: center; }
.empty-icon { margin-bottom: var(--cs-space-2); color: var(--cs-pass); font-size: 24px; display: flex; justify-content: center; }
.empty small { display: block; margin-top: 5px; }
.diff-summary { margin-top: var(--cs-space-3); padding: 7px 9px; border: 1px solid var(--cs-border); border-left: 3px solid var(--cs-accent); border-radius: var(--cs-radius-1); background: color-mix(in srgb, var(--cs-accent) 8%, transparent); font-size: var(--cs-font-2); display: flex; align-items: center; gap: 6px; }
.badge.new { color: var(--cs-accent); background: color-mix(in srgb, var(--cs-accent) 15%, transparent); }
.fixed-block { margin-top: 18px; }
.fixed-block summary { cursor: pointer; color: var(--cs-pass); font-size: var(--cs-font-2); font-weight: 600; display: flex; align-items: center; gap: 6px; }
.fixed-block ul { margin: var(--cs-space-2) 0; padding-left: 18px; color: var(--cs-desc); font-size: var(--cs-font-2); }
.fixed-block li { margin: var(--cs-space-1) 0; overflow-wrap: anywhere; }
.hidden { display: none; }
.custom-form { margin-top: 10px; padding: 10px; border: 1px solid var(--cs-card-border); border-radius: var(--cs-radius-1); background: var(--cs-card-bg); box-shadow: var(--cs-shadow); }
.custom-form label { display: block; margin: 0 0 5px; color: var(--cs-desc); font-size: var(--cs-font-1); }
.custom-form textarea, .custom-form select, .custom-form input { width: 100%; padding: 6px var(--cs-space-2); border: 1px solid var(--cs-input-border); border-radius: var(--cs-radius-1); color: var(--cs-input-fg); background: var(--cs-input-bg); font: inherit; font-size: var(--cs-font-2); }
.custom-form select { color: var(--cs-select-fg); background: var(--cs-select-bg); }
.custom-form input[type="checkbox"] { accent-color: var(--cs-accent); }
.custom-form textarea { resize: vertical; }
.custom-scope { margin-top: var(--cs-space-2); display: flex; gap: var(--cs-space-2); align-items: center; flex-wrap: wrap; }
.custom-scope select { width: auto; flex: 0 0 auto; }
.custom-scope .custom-globs { flex: 1 1 160px; width: auto; }
.custom-warn { color: var(--cs-warn); font-size: var(--cs-font-1); margin: var(--cs-space-2) 0 0; }
.custom-actions { margin-top: var(--cs-space-2); }
.custom-actions button { width: auto; padding: 6px var(--cs-space-3); text-align: center; }
.audit-resume { margin-top: 10px; padding: 9px; border: 1px solid var(--cs-warn); border-left: 3px solid var(--cs-warn); border-radius: var(--cs-radius-1); background: color-mix(in srgb, var(--cs-warn) 10%, transparent); font-size: var(--cs-font-2); }
.auto-line { margin-top: 7px; color: var(--cs-accent); font-size: var(--cs-font-2); font-weight: 600; display: flex; align-items: center; gap: 6px; }
.auto-badge { margin-top: 6px; color: var(--cs-desc); font-size: var(--cs-font-1); display: flex; align-items: center; gap: 5px; }
.search-line { margin-top: 10px; }
.search-line input { width: 100%; padding: 5px var(--cs-space-2); border: 1px solid var(--cs-input-border); border-radius: var(--cs-radius-1); color: var(--cs-input-fg); background: var(--cs-input-bg); font: inherit; font-size: var(--cs-font-2); }
</style>
</head>`;
}

export function buildReportHtml(issues: ReviewIssue[], stats: ReportStats, isScanning = false, emptyState = false, statusMessage = '', statusKind: 'retry' | 'error' | 'test' | 'success' = 'retry', keyMask = '', keyConfigured = false, provider = 'gemini', model = 'gemini-2.5-flash', testMode = false, progressMessage = '', welcomeBanner = false, welcomeReason: 'new' | 'stale' = 'new', findingsDiff?: FindingsDiffView, customFocus = '', auditResume?: AuditResumeView, autoResume?: AutoResumeIndicator, autoResumeEnabled = false, autoResumeMaxAttempts = 0, autoResumeMaxMinutes = 0, assets?: WebviewAssets, nonce = '', prefs?: UiPrefsInput): string {
  const ui = normalizeUiPrefs(prefs);
  const sorted = [...issues].sort((a, b) => {
    if (ui.findingsSort === 'file') return a.file.localeCompare(b.file) || a.line - b.line || severityOrder[a.severity] - severityOrder[b.severity];
    if (ui.findingsSort === 'line') return a.line - b.line || a.file.localeCompare(b.file) || severityOrder[a.severity] - severityOrder[b.severity];
    return severityOrder[a.severity] - severityOrder[b.severity] || a.file.localeCompare(b.file) || a.line - b.line;
  });
  const newKeys = new Set(findingsDiff?.newKeys ?? []);
  const grouped = new Map<string, ReviewIssue[]>();
  for (const issue of sorted) grouped.set(issue.file, [...(grouped.get(issue.file) ?? []), issue]);
  const sections = [...grouped.entries()].map(([file, fileIssues]) => `<section class="file-section"><h2>${escapeHtml(file)}</h2>${fileIssues.map((issue) => issueCard(issue, newKeys.has(`${issue.file}:${issue.line}:${issue.category}`), ui.showConfidence)).join('')}</section>`).join('');
  const diffSummary = findingsDiff ? `<div class="diff-summary">${icon('diff-added')}${escapeHtml(findingsDiff.summary)}</div>` : '';
  const customBanner = customFocus ? `<div class="diff-summary custom">${icon('target')} Кастомное ревью: ${escapeHtml(customFocus.slice(0, 160))}</div>` : '';
  const fixedBlock = findingsDiff?.fixed?.length
    ? `<details class="fixed-block"><summary>${icon('check')} Починено с прошлого скана (${findingsDiff.fixed.length})</summary><ul>${findingsDiff.fixed.map((entry) => `<li><strong>${escapeHtml(entry.file)}:${entry.line}</strong> · ${escapeHtml(entry.category)} — ${escapeHtml(entry.description.slice(0, 140))}</li>`).join('')}</ul></details>`
    : '';
  const body = sections || (emptyState && !keyConfigured
    ? `<div class="onboarding"><div class="empty-icon">${icon('account')}</div><h1>Привет! Это CodeScout</h1><p><strong>Шаг 1.</strong> Получите API-ключ провайдера в <a class="link-button" href="https://aistudio.google.com/apikey" data-command="openKeyLink">Открыть Google AI Studio</a>.</p><p><strong>Шаг 2.</strong> Нажми кнопку ниже и вставь ключ.</p><button class="primary-action cs-btn" type="button" data-command="setApiKey">${icon('key')}<span>Вставить ключ — провайдер определится сам</span></button><p><strong>Шаг 3.</strong> Готово — кнопки выше заработают.</p></div>`
    : emptyState
      ? `<div class="empty"><div class="empty-icon">${icon('search')}</div><strong>CodeScout готов к работе</strong><small>Нажмите одну из кнопок выше, чтобы начать ревью.</small></div>`
      : testMode
        ? `<div class="empty"><div class="empty-icon">${icon('beaker')}</div><strong>ТЕСТ</strong><small>Проверка завершена на встроенном примере.</small></div>`
        : `<div class="empty"><div class="empty-icon">${icon('pass')}</div><strong>Проверено файлов: ${stats.files} — проблем не найдено</strong><small>Сомневаешься? Проверь, как CodeScout ловит баги:</small><button class="primary-action cs-btn" type="button" data-command="testSample">${icon('beaker')}<span>Тест на примере</span></button></div>`);
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  return `<!DOCTYPE html>
<html lang="en">
${headHtml(assets, nonce)}
<body ${uiBodyAttrs(ui)}>
  <header class="header">
    ${welcomeBanner ? `<div class="welcome-overlay" role="dialog" aria-modal="true" aria-labelledby="welcome-title" tabindex="0" data-command="dismissWelcome"><div class="welcome-card"><div class="welcome-banner"><strong id="welcome-title">${welcomeReason === 'stale' ? 'Модель изменилась — контекст мог устареть. Обновить полным аудитом?' : 'CodeScout может изучить проект целиком — ревью станет точнее. Запустить полный аудит?'}</strong><div class="welcome-actions"><button type="button" class="cs-btn" data-command="startFullAudit">${icon(welcomeReason === 'stale' ? 'sync' : 'play')}<span>${welcomeReason === 'stale' ? 'Обновить' : 'Запустить аудит'}</span></button><button type="button" data-command="dismissWelcome">Позже</button></div></div></div></div>` : ''}
    <div class="brand"><span class="brand-mark">${icon('search')}</span> CodeScout <button class="brand-settings cs-btn" type="button" data-command="openSettingsPage" title="Открыть настройки CodeScout">${icon('settings-gear')}<span>Настройки</span></button></div>
    <div class="key-status ${keyConfigured ? 'ready' : 'missing'}">${keyConfigured ? `${icon('pass')} ${escapeHtml(provider)} · ${escapeHtml(model)} · ${escapeHtml(keyMask)} (защищённо)` : `${icon('error')} Ключ не настроен`} <button type="button" class="cs-btn" data-command="openSettingsPage" data-anchor="sec-key">${icon('key')}<span>Ключ и модель</span></button></div>
    ${testMode ? `<span class="test-badge">${icon('beaker')} ТЕСТ</span>` : ''}
    <div id="statusSlot">${statusMessage ? `<div class="status-banner ${statusKind}">${escapeHtml(statusMessage)}${statusKind === 'retry' ? '<span class="animated-dots">...</span>' : ''}${statusKind === 'error' && /404:|HTTP[^\n]*404/i.test(statusMessage) ? `<button type="button" class="cs-btn" data-command="chooseModel">${icon('sync')}<span>Выбрать доступную модель</span></button>` : ''}</div>` : ''}</div>
    ${auditResume ? `<div class="audit-resume"><strong>${icon('debug-alt')} Аудит оборвался: проверено ${escapeHtml(String(auditResume.done))} из ${escapeHtml(String(auditResume.total))} файлов (${escapeHtml(auditResume.model)})</strong><div class="welcome-actions"><button type="button" class="cs-btn" data-command="resumeAudit">${icon('play')}<span>Продолжить (${escapeHtml(String(auditResume.done))} из ${escapeHtml(String(auditResume.total))})</span></button><button type="button" class="cs-btn" data-command="restartAudit">${icon('refresh')}<span>Начать заново</span></button></div></div>` : ''}
    <div class="actions">
      <button type="button" class="cs-btn" data-command="scanLastCommit" ${isScanning ? 'disabled' : ''}>${isScanning ? `<span class="spinner">${icon('loading')}</span>` : icon('git-commit')}<span>Проверить последний коммит</span></button>
      <button type="button" class="cs-btn" data-command="scanUncommitted" ${isScanning ? 'disabled' : ''}>${isScanning ? `<span class="spinner">${icon('loading')}</span>` : icon('diff')}<span>Проверить изменения до коммита</span></button>
      <button type="button" class="cs-btn" data-command="scanFull" ${isScanning ? 'disabled' : ''}>${icon('telescope')}<span>Полный аудит проекта</span></button>
      <button type="button" class="cs-btn" id="toggleCustomForm" ${isScanning ? 'disabled' : ''}>${icon('beaker')}<span>Своё ревью</span></button>
    </div>
    ${autoResumeEnabled ? `<div class="auto-badge" title="Полный аудит сам догонит прерванное с backoff (codescout.autoResume)">${icon('robot')}<span>${escapeHtml(autoResumeBadgeText(autoResumeMaxAttempts, autoResumeMaxMinutes))}</span></div>` : ''}
    <div class="custom-form hidden" id="customForm">
      <label for="customFocusText">Что проверить?</label>
      <textarea id="customFocusText" rows="3" placeholder="например: все ли обращения к БД внутри транзакций?"></textarea>
      <div class="custom-scope">
        <select id="customScope">
          <option value="all">все файлы проекта</option>
          <option value="active">только открытый файл</option>
          <option value="list">список файлов (глобы через запятую)</option>
        </select>
        <input id="customGlobs" type="text" class="hidden custom-globs" placeholder="src/**/*.ts, tests/*.py" autocomplete="off">
        <button type="button" class="cs-btn secondary hidden" id="pickScopeForm">${icon('folder-opened')}<span>Выбрать файлы/папки</span></button>
      </div>
      <p class="custom-warn hidden" id="customScopeWarn"></p>
      <div class="custom-actions">
        <button type="button" class="cs-btn" id="startCustomReview">${icon('beaker')}<span>Запустить своё ревью</span></button>
      </div>
    </div>
    ${isScanning || progressMessage ? `<div class="progress-line" id="progressLine" data-live="${isScanning}">${escapeHtml(progressMessage || 'Запускаю проверку…')}</div>` : ''}
    ${autoLineHtml(autoResume)}
    ${isScanning ? `<button class="cancel-action cs-btn" type="button" data-command="cancelScan">${icon('debug-stop')}<span>Остановить</span></button>` : ''}
    <div class="stats"><strong>${issues.length} issues</strong> · ${stats.files} files · ${stats.seconds.toFixed(1)}s</div>
    <div class="pills"><span class="pill critical">${icon('error')} ${stats.critical}</span><span class="pill medium">${icon('warning')} ${stats.medium}</span><span class="pill low">${icon('pass')} ${stats.low}</span></div>
  </header>
  ${sections ? `<div class="search-line"><input id="fileSearch" type="search" placeholder="поиск файла…" autocomplete="off" spellcheck="false"></div>` : ''}
  <main>${customBanner}${diffSummary}${body}${fixedBlock}</main>
    <script${nonceAttr}>
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
    function applyProgressText(text) {
      const line = document.getElementById('progressLine');
      if (line) line.textContent = text;
    }
    function applyStatus(message, kind) {
      const slot = document.getElementById('statusSlot');
      if (!slot) return;
      slot.textContent = '';
      if (!message) return;
      const safeKind = /^(retry|error|test|success)$/.test(String(kind)) ? String(kind) : 'retry';
      const banner = document.createElement('div');
      banner.className = 'status-banner ' + safeKind;
      banner.textContent = message;
      if (safeKind === 'retry') {
        const dots = document.createElement('span');
        dots.className = 'animated-dots';
        dots.textContent = '...';
        banner.appendChild(dots);
      }
      if (safeKind === 'error' && /404:|HTTP[^\\n]*404/i.test(message)) {
        const fix = document.createElement('button');
        fix.type = 'button';
        fix.className = 'cs-btn';
        fix.dataset.command = 'chooseModel';
        fix.innerHTML = '<i class="codicon codicon-sync" aria-hidden="true"></i><span>Выбрать доступную модель</span>';
        banner.appendChild(fix);
      }
      slot.appendChild(banner);
    }
    const live = { text: '', elapsed: 0, tick: false };
    const progressLine = document.getElementById('progressLine');
    if (progressLine) {
      live.text = progressLine.textContent;
      live.elapsed = Number((live.text.match(/(\\d+)с[^\\d]*$/) || [])[1] || 0);
      live.tick = progressLine.dataset.live === 'true';
    }
    const auto = { on: false, done: 0, total: 0, attempt: 0, max: 0, seconds: 0 };
    const autoLine = document.getElementById('autoLine');
    function renderAuto() {
      if (!autoLine) return;
      if (!auto.on) { autoLine.classList.add('hidden'); return; }
      autoLine.classList.remove('hidden');
      const attemptLabel = auto.max > 0 ? 'попытка ' + auto.attempt + '/' + auto.max : 'попытка ' + auto.attempt;
      autoLine.innerHTML = '<i class="codicon codicon-robot" aria-hidden="true"></i> авто-догон: ' + auto.done + '/' + auto.total + ', ' + attemptLabel + (auto.seconds > 0 ? ' через ' + auto.seconds + 'с' : ' — пробую снова…');
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
      } else if (data.type === 'scopePickResult') {
        const globsEl = document.getElementById('customGlobs');
        const warn = document.getElementById('customScopeWarn');
        if (globsEl) {
          const merged = [];
          for (const g of [...splitGlobs(globsEl.value), ...(data.globs || [])]) { if (g && !merged.includes(g)) merged.push(g); }
          globsEl.value = merged.join(', ');
        }
        if (warn) {
          const outside = data.outside || [];
          if (data.noWorkspace) { warn.textContent = 'Нет открытой папки — выбор недоступен'; warn.classList.remove('hidden'); }
          else if (outside.length) { warn.textContent = 'вне workspace, не добавлено: ' + outside.join(', '); warn.classList.remove('hidden'); }
          else if ((data.globs || []).length) { warn.textContent = ''; warn.classList.add('hidden'); }
        }
      }
    });
    setInterval(() => {
      if (!live.tick) return;
      live.elapsed += 1;
      live.text = live.text.replace(/\\d+с[^\\d]*$/, live.elapsed + 'с');
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
          const label = toggle.querySelector('span');
          const glyph = toggle.querySelector('.codicon');
          if (label) label.textContent = form.classList.contains('hidden') ? 'Своё ревью' : 'Свернуть';
          if (glyph) glyph.className = 'codicon ' + (form.classList.contains('hidden') ? 'codicon-beaker' : 'codicon-close');
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
      vscode.postMessage({ command: element.dataset.command, anchor: element.dataset.anchor });
    });
    document.addEventListener('change', (event) => {
      const scope = event.target instanceof Element ? event.target.closest('#customScope') : null;
      if (!scope) return;
      const globsEl = document.getElementById('customGlobs');
      const pickBtn = document.getElementById('pickScopeForm');
      const isList = scope.value === 'list';
      if (globsEl) globsEl.classList.toggle('hidden', !isList);
      if (pickBtn) pickBtn.classList.toggle('hidden', !isList);
    });
    const pickFormBtn = document.getElementById('pickScopeForm');
    if (pickFormBtn) pickFormBtn.addEventListener('click', () => vscode.postMessage({ command: 'pickScope' }));
    function splitGlobs(value) {
      const out = [];
      for (const part of String(value || '').split(',')) { const g = part.trim(); if (g && !out.includes(g)) out.push(g); }
      return out;
    }
  </script>
</body>
</html>`;
}

export function buildEmptyReportHtml(keyMask = '', keyConfigured = false, provider = 'gemini', model = 'gemini-2.5-flash', welcomeBanner = false, welcomeReason: 'new' | 'stale' = 'new', auditResume?: AuditResumeView, autoResumeEnabled = false, autoResumeMaxAttempts = 0, autoResumeMaxMinutes = 0, assets?: WebviewAssets, nonce = '', prefs?: UiPrefsInput): string {
  return buildReportHtml([], { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 }, false, true, '', 'retry', keyMask, keyConfigured, provider, model, false, '', welcomeBanner, welcomeReason, undefined, '', auditResume, undefined, autoResumeEnabled, autoResumeMaxAttempts, autoResumeMaxMinutes, assets, nonce, prefs);
}
