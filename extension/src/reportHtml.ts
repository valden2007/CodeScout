import { ReviewIssue } from '../../src/types';

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

function issueCard(issue: ReviewIssue): string {
  const severity = severityClass(issue.severity);
  const code = issue.code ? `<pre><code>${escapeHtml(issue.code)}</code></pre>` : '';
  const suggestion = issue.suggestion ? `<div class="suggestion"><span>→</span> ${escapeHtml(issue.suggestion)}</div>` : '';
  return `<article class="issue-card ${severity}">
  <div class="issue-top"><span class="badge ${severity}">${severityEmoji(issue.severity)} ${severityLabel(issue.severity)}</span><span class="category">${escapeHtml(issue.category)}</span><span class="confidence">${Math.round(issue.confidence * 100)}%</span></div>
  <a class="location" href="#" data-command="openFile" data-file="${escapeHtml(issue.file)}" data-line="${issue.line}">${escapeHtml(issue.file)}:${issue.line}</a>
  <div class="description">${escapeHtml(issue.description)}</div>
  ${code}
  ${suggestion}
</article>`;
}

export function buildReportHtml(issues: ReviewIssue[], stats: ReportStats, isScanning = false, emptyState = false, statusMessage = '', statusKind: 'retry' | 'error' | 'test' = 'retry', keyMask = '', keyConfigured = false, provider = 'gemini', model = 'gemini-2.5-flash', testMode = false, progressMessage = '', welcomeBanner = false, welcomeReason: 'new' | 'stale' = 'new'): string {
  const sorted = [...issues].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const grouped = new Map<string, ReviewIssue[]>();
  for (const issue of sorted) grouped.set(issue.file, [...(grouped.get(issue.file) ?? []), issue]);
  const sections = [...grouped.entries()].map(([file, fileIssues]) => `<section class="file-section"><h2>${escapeHtml(file)}</h2>${fileIssues.map(issueCard).join('')}</section>`).join('');
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
</style>
</head>
<body>
  <header class="header">
    ${welcomeBanner ? `<div class="welcome-overlay" role="dialog" aria-modal="true" aria-labelledby="welcome-title" tabindex="0" data-command="dismissWelcome"><div class="welcome-card"><div class="welcome-banner"><strong id="welcome-title">${welcomeReason === 'stale' ? '⚙️ Модель изменилась — контекст мог устареть. Обновить полным аудитом?' : '🔬 CodeScout может изучить проект целиком — ревью станет точнее. Запустить полный аудит?'}</strong><div class="welcome-actions"><button type="button" data-command="startFullAudit">${welcomeReason === 'stale' ? '🔄 Обновить' : '🚀 Запустить аудит'}</button><button type="button" data-command="dismissWelcome">Позже</button></div></div></div></div>` : ''}
    <div class="brand"><span class="brand-mark">🕵️</span> CodeScout</div>
    <div class="key-status ${keyConfigured ? 'ready' : 'missing'}">${keyConfigured ? `🟢 ${escapeHtml(provider)} · ${escapeHtml(model)} · ${escapeHtml(keyMask)} (защищённо)` : '🔴 Ключ не настроен'} <button type="button" data-command="setApiKey">${keyConfigured ? 'Изменить' : 'Настроить'}</button><button type="button" data-command="openSettings" title="Настройки CodeScout">⚙️</button>${keyConfigured ? `<button type="button" data-command="chooseModel">⚙️ Модель: ${escapeHtml(model)}</button><button type="button" data-command="clearApiKey">Очистить</button>` : ''}</div>
    ${testMode ? '<span class="test-badge">🧪 ТЕСТ</span>' : ''}
    ${statusMessage ? `<div class="status-banner ${statusKind}">${escapeHtml(statusMessage)}${statusKind === 'retry' ? '<span class="animated-dots">...</span>' : ''}${statusKind === 'error' && statusMessage.includes('404') ? '<button type="button" data-command="chooseModel">🔄 Выбрать доступную модель</button>' : ''}</div>` : ''}
    <div class="actions">
      <button type="button" data-command="scanLastCommit" ${isScanning ? 'disabled' : ''}>${isScanning ? '<span class="spinner">◌</span>' : '🔍'} Проверить последний коммит</button>
      <button type="button" data-command="scanUncommitted" ${isScanning ? 'disabled' : ''}>${isScanning ? '<span class="spinner">◌</span>' : '📝'} Проверить изменения до коммита</button>
      <button type="button" data-command="scanFull" ${isScanning ? 'disabled' : ''}>🔬 Полный аудит проекта</button>
    </div>
    ${progressMessage ? `<div class="progress-line" data-ticker="${/^(?:🤖 Модель думает|🔎 Проверяю|🔬 Полный аудит)/.test(progressMessage) ? 'true' : 'false'}">${escapeHtml(progressMessage)}</div>` : ''}
    ${isScanning ? '<button class="cancel-action" type="button" data-command="cancelScan">⛔ Остановить</button>' : ''}
    <div class="stats"><strong>${issues.length} issues</strong> · ${stats.files} files · ${stats.seconds.toFixed(1)}s</div>
    <div class="pills"><span class="pill critical">🔴 ${stats.critical}</span><span class="pill medium">🟡 ${stats.medium}</span><span class="pill low">🟢 ${stats.low}</span></div>
  </header>
  <main>${body}</main>
    <script>
    const vscode = acquireVsCodeApi();
    const overlay = document.querySelector('.welcome-overlay');
    if (overlay) {
      document.body.classList.add('modal');
      if (!document.body.dataset.codescoutWelcomeBound) {
        document.body.dataset.codescoutWelcomeBound = 'true';
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
      }
    } else {
      document.body.classList.remove('modal');
    }
    document.querySelectorAll('[data-command]:not(a[data-file])').forEach((element) => {
      element.addEventListener('click', (event) => {
        if (element.classList.contains('welcome-overlay') && event.target !== element) return;
        event.preventDefault();
        vscode.postMessage({ command: element.dataset.command });
      });
    });
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('a[data-file]') : null;
      if (!target) return;
      event.preventDefault();
      vscode.postMessage({ command: 'openFile', file: target.getAttribute('data-file'), line: target.getAttribute('data-line') });
    });
    const ticker = document.querySelector('[data-ticker="true"]');
    if (ticker) {
      let elapsed = Number((ticker.textContent.match(/⏱\\s*(\\d+)с/) || [])[1] || 0);
      setInterval(() => {
        elapsed += 1;
        ticker.textContent = ticker.textContent.replace(/⏱\\s*\\d+с/, '⏱ ' + elapsed + 'с');
      }, 1000);
    }
  </script>
</body>
</html>`;
}

export function buildEmptyReportHtml(keyMask = '', keyConfigured = false, provider = 'gemini', model = 'gemini-2.5-flash', welcomeBanner = false, welcomeReason: 'new' | 'stale' = 'new'): string {
  return buildReportHtml([], { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 }, false, true, '', 'retry', keyMask, keyConfigured, provider, model, false, '', welcomeBanner, welcomeReason);
}
