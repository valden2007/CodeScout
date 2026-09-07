export interface SettingsState {
  keyMask: string;
  keyConfigured: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  reportLanguage: 'ru' | 'en';
  showAuditBanner: boolean;
  docLinks: string[];
  docMaxKb: number;
  docMaxLinks: number;
  maxLines: number;
  maxFiles: number;
  autoResume: boolean;
  autoResumeMaxAttempts: number;
  autoResumeMaxMinutes: number;
  auditScope: string;
  auditPasses: number;
  version: string;
}

const providerValues = ['auto', 'gemini', 'groq', 'openrouter', 'github', 'custom'];

const REPO_URL = 'https://github.com/valden2007/CodeScout';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildSettingsHtml(state: SettingsState, statusMessage = '', statusKind: 'ok' | 'error' = 'ok', nonce = '', anchor = ''): string {
  const scriptSrc = nonce ? `'nonce-${nonce}'` : "'unsafe-inline'";
  const providerOptions = providerValues
    .map((value) => `<option value="${value}"${value === state.provider ? ' selected' : ''}>${value === 'auto' ? 'auto — по ключу' : value}</option>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src ${scriptSrc};">
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 0; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.45; }
.brand { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 700; padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
.brand-mark { color: var(--vscode-textLink-foreground); }
.layout { display: flex; align-items: flex-start; gap: 0; }
.sidebar { position: sticky; top: 0; flex: 0 0 190px; display: flex; flex-direction: column; gap: 2px; padding: 12px 8px; border-right: 1px solid var(--vscode-panel-border); max-height: 100vh; overflow: auto; }
.nav-link { display: block; padding: 7px 10px; border-radius: 4px; color: var(--vscode-foreground); text-decoration: none; font-size: 12px; cursor: pointer; }
.nav-link:hover { background: var(--vscode-list-hoverBackground); }
.nav-link.active { background: color-mix(in srgb, var(--vscode-textLink-foreground) 16%, transparent); color: var(--vscode-textLink-foreground); font-weight: 600; }
.content { flex: 1 1 auto; min-width: 0; padding: 12px 16px 72px; }
section { margin: 0 0 14px; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; scroll-margin-top: 8px; }
h2 { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--vscode-textLink-foreground); }
label { display: block; margin: 10px 0 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
input, select { width: 100%; padding: 6px 8px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; }
textarea { width: 100%; padding: 6px 8px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; font-size: 12px; resize: vertical; }
button { padding: 6px 12px; border: 1px solid transparent; border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; font-size: 12px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.55; cursor: default; }
button:disabled:hover { background: var(--vscode-button-background); }
.row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.checkbox { display: flex; align-items: center; gap: 8px; }
.checkbox input { width: auto; }
.hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 6px 0 0; }
.hidden { display: none; }
.status { margin: 0 0 12px; padding: 8px 10px; border-left: 3px solid var(--vscode-textLink-foreground); border-radius: 3px; background: color-mix(in srgb, var(--vscode-textLink-foreground) 12%, transparent); font-size: 12px; ${statusMessage ? '' : 'display: none;'} }
.status.error { border-left-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); }
.current-key { margin-top: 6px; font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
.savebar { position: fixed; left: 190px; right: 0; bottom: 0; display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
.savebar .dirty { color: var(--vscode-descriptionForeground); font-size: 11px; }
.about-line { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 12px; }
</style>
</head>
<body data-anchor="${escapeHtml(anchor)}">
<div class="brand"><span class="brand-mark">🕵️</span> CodeScout: Настройки</div>
<div class="layout">
<nav class="sidebar" id="sidebar">
  <a class="nav-link active" href="#sec-key" data-target="sec-key">🔑 Ключ и модель</a>
  <a class="nav-link" href="#sec-audit" data-target="sec-audit">🔄 Аудит</a>
  <a class="nav-link" href="#sec-project" data-target="sec-project">📁 Проект</a>
  <a class="nav-link" href="#sec-appearance" data-target="sec-appearance">🎨 Внешний вид</a>
  <a class="nav-link" href="#sec-about" data-target="sec-about">ℹ️ О расширении</a>
</nav>
<div class="content">
<div class="status${statusKind === 'error' ? ' error' : ''}" id="status">${escapeHtml(statusMessage)}</div>
<main>
<section id="sec-key">
  <h2>🔑 Ключ и модель</h2>
  <label for="provider">Провайдер</label>
  <select id="provider">${providerOptions}</select>
  <label for="apiKey">API-ключ ( SecretStorage )</label>
  <input id="apiKey" type="password" autocomplete="off" placeholder="${state.keyConfigured ? 'пустое поле = оставить текущий ключ' : 'вставь ключ — провайдер определится сам'}">
  <label class="checkbox"><input id="revealKey" type="checkbox"> показать введённый ключ</label>
  <div id="baseUrlRow" class="${state.provider === 'custom' ? '' : 'hidden'}">
    <label for="baseUrl">Base URL (OpenAI-совместимый эндпоинт)</label>
    <input id="baseUrl" type="text" autocomplete="off" placeholder="http://localhost:11434/v1" value="${escapeHtml(state.baseUrl)}">
    <p class="hint">Нужен для custom: Ollama, LM Studio, свой прокси. Приоритет: эта настройка &gt; env CODESCOUT_BASE_URL.</p>
  </div>
  <div class="current-key">сейчас: ${state.keyConfigured ? `${escapeHtml(state.keyMask)} · ${escapeHtml(state.provider)} · ${escapeHtml(state.model)}` : 'ключ не настроен'}</div>
  <div class="row">
    <button id="chooseModel" type="button" class="secondary">🧲 Живые модели…</button>
    <button id="clearKey" type="button" class="secondary">⌫ Забыть ключ</button>
  </div>
  <p class="hint">auto = groq-ключ → groq, AIza… → gemini, sk-or-… → openrouter, ghp_… → github.</p>
</section>
<section id="sec-audit">
  <h2>🔄 Аудит</h2>
  <label for="auditPasses">Кругов проверки на файл (1-3)</label>
  <input id="auditPasses" type="number" min="1" max="3" step="1" value="${state.auditPasses}">
  <label for="maxLines">Макс. строк на файл (0 = без лимита)</label>
  <input id="maxLines" type="number" min="0" max="100000" step="1" value="${state.maxLines}">
  <label for="maxFiles">Макс. файлов на аудит</label>
  <input id="maxFiles" type="number" min="1" max="10000" step="1" value="${state.maxFiles}">
  <label class="checkbox"><input id="autoResume" type="checkbox"${state.autoResume ? ' checked' : ''}> 🤖 Автономный режим (авто-догон)</label>
  <label for="autoResumeMaxAttempts">Авто-догон: макс. попыток (0 = без лимита)</label>
  <input id="autoResumeMaxAttempts" type="number" min="0" max="1000" step="1" value="${state.autoResumeMaxAttempts}">
  <label for="autoResumeMaxMinutes">Авто-догон: макс. минут (0 = без лимита)</label>
  <input id="autoResumeMaxMinutes" type="number" min="0" max="10000" step="1" value="${state.autoResumeMaxMinutes}">
  <p class="hint">maxLines = 0: лимита нет, файлы &gt;800 строк режутся чанками с перекрытием 50 строк; N &gt; 0: файлы длиннее N скипаются. Авто-догон возобновляет прерванный аудит из чекпоинта с backoff 30с→60с→2мин→5мин.</p>
</section>
<section id="sec-project">
  <h2>📁 Проект</h2>
  <label for="docLinks">Ссылки на документацию (одна в строке)</label>
  <textarea id="docLinks" rows="4" spellcheck="false" placeholder="https://docs.example.com/api&#10;https://wiki.internal/architecture">${escapeHtml(state.docLinks.join('\n'))}</textarea>
  <label for="docMaxKb">Макс. размер дока в промт (KB)</label>
  <input id="docMaxKb" type="number" min="1" max="2048" step="1" value="${state.docMaxKb}">
  <label for="docMaxLinks">Макс. число ссылок на аудит</label>
  <input id="docMaxLinks" type="number" min="1" max="50" step="1" value="${state.docMaxLinks}">
  <label for="auditScope">Scope аудита (glob через запятую, пусто = все)</label>
  <input id="auditScope" type="text" spellcheck="false" placeholder="src/**, extension/src/**" value="${escapeHtml(state.auditScope)}">
  <div class="row">
    <button id="openRules" type="button" class="secondary">📜 Открыть rules.md</button>
  </div>
  <p class="hint">rules.md подмешивается в каждый промт. Документация докачивается (таймаут 5с, oversized усекается с сохранением начала), кэшируется в .codescout/docs-cache.json на 24ч. Scope ограничивает полный аудит; ПКМ-проверка его игнорирует.</p>
</section>
<section id="sec-appearance">
  <h2>🎨 Внешний вид</h2>
  <label for="reportLanguage">Язык отчётов</label>
  <select id="reportLanguage">
    <option value="ru"${state.reportLanguage === 'ru' ? ' selected' : ''}>RU — по-русски</option>
    <option value="en"${state.reportLanguage === 'en' ? ' selected' : ''}>EN — English</option>
  </select>
  <label class="checkbox"><input id="showBanner" type="checkbox"${state.showAuditBanner ? ' checked' : ''}> Баннер «запустить полный аудит» при старте</label>
</section>
<section id="sec-about">
  <h2>ℹ️ О расширении</h2>
  <div class="about-line">Версия: <strong>${escapeHtml(state.version)}</strong></div>
  <div class="row">
    <button id="openReadme" type="button" class="secondary" data-url="${REPO_URL}#readme">📖 README</button>
    <button id="openRepo" type="button" class="secondary" data-url="${REPO_URL}">🗂 Репозиторий</button>
    <button id="reportIssue" type="button" class="secondary" data-url="${REPO_URL}/issues">🐛 Сообщить о проблеме</button>
  </div>
</section>
</main>
</div>
</div>
<div class="savebar">
  <button id="saveAll" type="button" disabled>💾 Сохранить</button>
  <span class="dirty" id="dirtyHint">нет несохранённых изменений</span>
</div>
<script${nonce ? ` nonce="${nonce}"` : ''}>
const vscode = acquireVsCodeApi();
const providerSelect = document.getElementById('provider');
const baseUrlRow = document.getElementById('baseUrlRow');
const baseUrlInput = document.getElementById('baseUrl');
const keyInput = document.getElementById('apiKey');
const langSelect = document.getElementById('reportLanguage');
const bannerBox = document.getElementById('showBanner');
const docLinksInput = document.getElementById('docLinks');
const docMaxKbInput = document.getElementById('docMaxKb');
const docMaxLinksInput = document.getElementById('docMaxLinks');
const maxLinesInput = document.getElementById('maxLines');
const maxFilesInput = document.getElementById('maxFiles');
const auditScopeInput = document.getElementById('auditScope');
const auditPassesInput = document.getElementById('auditPasses');
const autoResumeBox = document.getElementById('autoResume');
const autoResumeMaxAttemptsInput = document.getElementById('autoResumeMaxAttempts');
const autoResumeMaxMinutesInput = document.getElementById('autoResumeMaxMinutes');
const saveAllBtn = document.getElementById('saveAll');
const dirtyHint = document.getElementById('dirtyHint');
function snapshot() {
  return JSON.stringify({
    providerKey: providerSelect.value, baseUrl: baseUrlInput.value, key: keyInput.value,
    reportLanguage: langSelect.value, showAuditBanner: bannerBox.checked,
    docLinks: docLinksInput.value, docMaxKb: docMaxKbInput.value, docMaxLinks: docMaxLinksInput.value,
    maxLines: maxLinesInput.value, maxFiles: maxFilesInput.value, auditScope: auditScopeInput.value,
    auditPasses: auditPassesInput.value, autoResume: autoResumeBox.checked,
    autoResumeMaxAttempts: autoResumeMaxAttemptsInput.value, autoResumeMaxMinutes: autoResumeMaxMinutesInput.value
  });
}
let initial = snapshot();
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min) return String(Math.min(max, Math.max(min, Number(fallback))));
  return String(Math.min(max, Math.max(min, n)));
}
function toggleBaseUrl() { baseUrlRow.classList.toggle('hidden', providerSelect.value !== 'custom'); }
providerSelect.addEventListener('change', toggleBaseUrl);
function refreshDirty() {
  const dirty = snapshot() !== initial;
  saveAllBtn.disabled = !dirty;
  dirtyHint.textContent = dirty ? 'есть несохранённые изменения' : 'нет несохранённых изменений';
}
document.querySelectorAll('input, select, textarea').forEach((el) => {
  el.addEventListener('input', refreshDirty);
  el.addEventListener('change', refreshDirty);
});
document.getElementById('revealKey').addEventListener('change', (event) => {
  keyInput.type = event.target.checked ? 'text' : 'password';
});
saveAllBtn.addEventListener('click', () => {
  saveAllBtn.disabled = true;
  saveAllBtn.textContent = '⏳ Сохраняю…';
  vscode.postMessage({
    command: 'saveAll',
    providerKey: providerSelect.value,
    baseUrl: baseUrlInput.value.trim(),
    apiKey: keyInput.value.trim() || undefined,
    reportLanguage: langSelect.value,
    showAuditBanner: bannerBox.checked,
    linksText: docLinksInput.value,
    docMaxKb: Number(clampInt(docMaxKbInput.value, 1, 2048, '50')),
    docMaxLinks: Number(clampInt(docMaxLinksInput.value, 1, 50, '5')),
    maxLines: Number(clampInt(maxLinesInput.value, 0, 100000, '0')),
    maxFiles: Number(clampInt(maxFilesInput.value, 1, 10000, '100')),
    auditScope: auditScopeInput.value.trim(),
    auditPasses: Number(clampInt(auditPassesInput.value, 1, 3, '1')),
    autoResume: autoResumeBox.checked,
    autoResumeMaxAttempts: Number(clampInt(autoResumeMaxAttemptsInput.value, 0, 1000, '0')),
    autoResumeMaxMinutes: Number(clampInt(autoResumeMaxMinutesInput.value, 0, 10000, '0'))
  });
});
document.getElementById('chooseModel').addEventListener('click', () => vscode.postMessage({ command: 'chooseModel' }));
document.getElementById('clearKey').addEventListener('click', () => vscode.postMessage({ command: 'clearApiKey' }));
document.getElementById('openRules').addEventListener('click', () => vscode.postMessage({ command: 'openRules' }));
document.querySelectorAll('#sec-about button[data-url]').forEach((btn) => {
  btn.addEventListener('click', () => vscode.postMessage({ command: 'openLink', url: btn.getAttribute('data-url') }));
});
const sections = Array.prototype.slice.call(document.querySelectorAll('main section[id]'));
const navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav-link'));
function setActive(id) { navLinks.forEach((l) => l.classList.toggle('active', l.getAttribute('data-target') === id)); }
function onScroll() {
  let current = sections.length ? sections[0].id : '';
  for (const s of sections) { if (s.getBoundingClientRect().top <= 120) current = s.id; }
  setActive(current);
}
window.addEventListener('scroll', onScroll, { passive: true });
navLinks.forEach((l) => l.addEventListener('click', (event) => {
  event.preventDefault();
  const target = document.getElementById(l.getAttribute('data-target'));
  if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); setActive(l.getAttribute('data-target')); }
}));
toggleBaseUrl();
refreshDirty();
onScroll();
const anchor = document.body.getAttribute('data-anchor');
if (anchor) { const el = document.getElementById(anchor); if (el) { el.scrollIntoView(); setActive(anchor); } }
</script>
</body>
</html>`;
}
