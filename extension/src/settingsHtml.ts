import { uiBodyAttrs, uiTokensCss, type UiPrefs } from './uiPrefs';

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
  uiTheme: 'auto' | 'dark' | 'light';
  accentColor: 'auto' | 'blue' | 'purple' | 'green' | 'orange' | 'pink';
  uiDensity: 'compact' | 'standard';
  uiFontSize: 's' | 'm' | 'l';
  showConfidence: boolean;
  findingsSort: 'severity' | 'file' | 'line';
  reportTheme: 'auto' | 'dark' | 'light';
}

export interface SettingsAssets {
  codiconCss: string;
  cspSource: string;
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

function icon(name: string): string {
  return `<i class="codicon codicon-${name}" aria-hidden="true"></i>`;
}

export function splitScopeGlobs(value: string): string[] {
  return [...new Set((value ?? '').split(',').map((glob) => glob.trim()).filter(Boolean))];
}

export function mergeScopeGlobs(existing: string, added: string[]): string {
  return [...new Set([...splitScopeGlobs(existing), ...added.map((glob) => glob.trim()).filter(Boolean)])].join(', ');
}

export function buildSettingsHtml(state: SettingsState, statusMessage = '', statusKind: 'ok' | 'error' = 'ok', nonce = '', anchor = '', assets?: SettingsAssets): string {
  const scriptSrc = nonce ? `'nonce-${nonce}'` : "'unsafe-inline'";
  const styleSrc = nonce ? `'nonce-${nonce}'` : "'unsafe-inline'";
  const csp = assets
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${assets.cspSource}; img-src data:; style-src ${styleSrc} ${assets.cspSource}; script-src ${scriptSrc};">`
    : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${styleSrc}; script-src ${scriptSrc};">`;
  const codiconLink = assets ? `<link rel="stylesheet" href="${assets.codiconCss}">` : '';
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const providerOptions = providerValues
    .map((value) => `<option value="${value}"${value === state.provider ? ' selected' : ''}>${value === 'auto' ? 'auto — по ключу' : value}</option>`)
    .join('');
  const prefs: UiPrefs = { theme: state.uiTheme, accent: state.accentColor, density: state.uiDensity, fontSize: state.uiFontSize, showConfidence: state.showConfidence, findingsSort: state.findingsSort, reportTheme: state.reportTheme };
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${csp}
${codiconLink}
<style${nonceAttr}>
:root { color-scheme: dark; }
${uiTokensCss()}
* { box-sizing: border-box; }
body { margin: 0; padding: 0; color: var(--cs-fg); background: var(--cs-editor-bg); font-family: var(--vscode-font-family); font-size: var(--cs-font-3); line-height: 1.45; }
.brand { display: flex; align-items: center; gap: var(--cs-space-2); font-size: var(--cs-font-4); font-weight: 700; padding: var(--cs-space-3) var(--cs-space-4); border-bottom: 1px solid var(--cs-border); }
.brand-mark { color: var(--cs-accent); display: inline-flex; }
.layout { display: flex; align-items: flex-start; gap: 0; }
.sidebar { position: sticky; top: 0; flex: 0 0 200px; display: flex; flex-direction: column; gap: 2px; padding: var(--cs-space-3) var(--cs-space-2); border-right: 1px solid var(--cs-border); max-height: 100vh; overflow: auto; }
.nav-link { display: flex; align-items: center; gap: var(--cs-space-2); padding: 7px 10px; border-radius: var(--cs-radius-1); color: var(--cs-fg); text-decoration: none; font-size: var(--cs-font-2); cursor: pointer; border-left: 3px solid transparent; }
.nav-link:hover { background: var(--cs-list-hover); }
.nav-link.active { background: color-mix(in srgb, var(--cs-accent) 14%, transparent); color: var(--cs-accent); font-weight: 600; border-left-color: var(--cs-accent); }
.content { flex: 1 1 auto; min-width: 0; padding: var(--cs-space-3) var(--cs-space-4) 72px; }
section { margin: 0 0 14px; padding: var(--cs-space-3); border: 1px solid var(--cs-card-border); border-radius: var(--cs-radius-2); background: var(--cs-card-bg); box-shadow: var(--cs-shadow); scroll-margin-top: var(--cs-space-2); }
h2 { display: flex; align-items: center; gap: var(--cs-space-2); margin: 0 0 6px; font-size: var(--cs-font-3); font-weight: 600; color: var(--cs-accent); }
label { display: block; margin: 10px 0 var(--cs-space-1); font-size: var(--cs-font-2); color: var(--cs-desc); }
input, select { width: 100%; padding: 6px var(--cs-space-2); border: 1px solid var(--cs-input-border); border-radius: var(--cs-radius-1); color: var(--cs-input-fg); background: var(--cs-input-bg); font: inherit; }
select { color: var(--cs-select-fg); background: var(--cs-select-bg); }
input[type="checkbox"] { accent-color: var(--cs-accent); }
textarea { width: 100%; padding: 6px var(--cs-space-2); border: 1px solid var(--cs-input-border); border-radius: var(--cs-radius-1); color: var(--cs-input-fg); background: var(--cs-input-bg); font: inherit; font-size: var(--cs-font-2); resize: vertical; }
button { display: inline-flex; align-items: center; gap: var(--cs-space-2); padding: 6px var(--cs-space-3); border: 1px solid transparent; border-radius: var(--cs-radius-1); color: var(--cs-btn-fg); background: var(--cs-btn-bg); font: inherit; font-size: var(--cs-font-2); cursor: pointer; }
button:hover:not(:disabled) { background: var(--cs-btn-hover); }
button:active:not(:disabled) { transform: translateY(1px); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button.secondary { color: var(--cs-btn2-fg); background: var(--cs-btn2-bg); }
button.secondary:hover:not(:disabled) { background: var(--cs-btn2-hover); }
button:disabled { opacity: 0.55; cursor: default; }
.row { display: flex; flex-wrap: wrap; gap: var(--cs-space-2); margin-top: var(--cs-space-3); }
.checkbox { display: flex; align-items: center; gap: var(--cs-space-2); }
.checkbox input { width: auto; }
.hint { color: var(--cs-desc); font-size: var(--cs-font-1); margin: 6px 0 0; }
.hidden { display: none; }
.status { margin: 0 0 var(--cs-space-3); padding: var(--cs-space-2) 10px; border-left: 3px solid var(--cs-accent); border-radius: var(--cs-radius-1); background: color-mix(in srgb, var(--cs-accent) 12%, transparent); font-size: var(--cs-font-2); ${statusMessage ? '' : 'display: none;'} }
.status.error { border-left-color: var(--cs-error); color: var(--cs-error); background: color-mix(in srgb, var(--cs-error) 12%, transparent); }
.current-key { margin-top: 6px; font-family: var(--vscode-editor-font-family); font-size: var(--cs-font-1); color: var(--cs-desc); overflow-wrap: anywhere; }
.savebar { position: fixed; left: 200px; right: 0; bottom: 0; display: flex; align-items: center; gap: 10px; padding: 10px var(--cs-space-4); border-top: 1px solid var(--cs-border); background: var(--vscode-editor-background); }
.savebar .dirty { color: var(--cs-desc); font-size: var(--cs-font-1); }
.dirty-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--cs-warn); display: none; }
button.is-dirty .dirty-dot { display: inline-block; }
.about-line { display: flex; align-items: center; gap: var(--cs-space-2); margin: 6px 0; font-size: var(--cs-font-2); }
.scope-chips { display: flex; flex-wrap: wrap; gap: var(--cs-space-1); margin-top: var(--cs-space-2); }
.scope-chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--cs-input-border); border-radius: 999px; padding: 1px var(--cs-space-2); font-size: var(--cs-font-1); font-family: var(--vscode-editor-font-family); background: var(--cs-chip-bg); color: var(--cs-chip-fg); }
.scope-chip button { display: inline-flex; padding: 0; border: none; background: transparent; color: var(--cs-desc); width: auto; flex: 0 0 auto; }
.scope-chip button:hover { background: transparent; color: var(--cs-error); }
.scope-warn { color: var(--cs-warn); font-size: var(--cs-font-1); margin: var(--cs-space-2) 0 0; }
</style>
</head>
<body data-anchor="${escapeHtml(anchor)}" ${uiBodyAttrs(prefs)}>
<div class="brand"><span class="brand-mark">${icon('search')}</span> CodeScout: Настройки</div>
<div class="layout">
<nav class="sidebar" id="sidebar">
  <a class="nav-link active" href="#sec-key" data-target="sec-key">${icon('key')}<span>Ключ и модель</span></a>
  <a class="nav-link" href="#sec-audit" data-target="sec-audit">${icon('sync')}<span>Аудит</span></a>
  <a class="nav-link" href="#sec-project" data-target="sec-project">${icon('folder')}<span>Проект</span></a>
  <a class="nav-link" href="#sec-appearance" data-target="sec-appearance">${icon('symbol-color')}<span>Внешний вид</span></a>
  <a class="nav-link" href="#sec-about" data-target="sec-about">${icon('info')}<span>О расширении</span></a>
</nav>
<div class="content">
<div class="status${statusKind === 'error' ? ' error' : ''}" id="status">${escapeHtml(statusMessage)}</div>
<main>
<section id="sec-key">
  <h2>${icon('key')} Ключ и модель</h2>
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
    <button id="chooseModel" type="button" class="secondary">${icon('cloud-download')}<span>Живые модели…</span></button>
    <button id="clearKey" type="button" class="secondary">${icon('trash')}<span>Забыть ключ</span></button>
  </div>
  <p class="hint">auto = groq-ключ → groq, AIza… → gemini, sk-or-… → openrouter, ghp_… → github.</p>
</section>
<section id="sec-audit">
  <h2>${icon('sync')} Аудит</h2>
  <label for="auditPasses">Кругов проверки на файл (1-3)</label>
  <input id="auditPasses" type="number" min="1" max="3" step="1" value="${state.auditPasses}">
  <label for="maxLines">Макс. строк на файл (0 = без лимита)</label>
  <input id="maxLines" type="number" min="0" max="100000" step="1" value="${state.maxLines}">
  <label for="maxFiles">Макс. файлов на аудит</label>
  <input id="maxFiles" type="number" min="1" max="10000" step="1" value="${state.maxFiles}">
  <label class="checkbox"><input id="autoResume" type="checkbox"${state.autoResume ? ' checked' : ''}> ${icon('robot')}<span>Автономный режим (авто-догон)</span></label>
  <label for="autoResumeMaxAttempts">Авто-догон: макс. попыток (0 = без лимита)</label>
  <input id="autoResumeMaxAttempts" type="number" min="0" max="1000" step="1" value="${state.autoResumeMaxAttempts}">
  <label for="autoResumeMaxMinutes">Авто-догон: макс. минут (0 = без лимита)</label>
  <input id="autoResumeMaxMinutes" type="number" min="0" max="10000" step="1" value="${state.autoResumeMaxMinutes}">
  <p class="hint">maxLines = 0: лимита нет, файлы &gt;800 строк режутся чанками с перекрытием 50 строк; N &gt; 0: файлы длиннее N скипаются. Авто-догон возобновляет прерванный аудит из чекпоинта с backoff 30с→60с→2мин→5мин.</p>
</section>
<section id="sec-project">
  <h2>${icon('folder')} Проект</h2>
  <label for="docLinks">Ссылки на документацию (одна в строке)</label>
  <textarea id="docLinks" rows="4" spellcheck="false" placeholder="https://docs.example.com/api&#10;https://wiki.internal/architecture">${escapeHtml(state.docLinks.join('\n'))}</textarea>
  <label for="docMaxKb">Макс. размер дока в промт (KB)</label>
  <input id="docMaxKb" type="number" min="1" max="2048" step="1" value="${state.docMaxKb}">
  <label for="docMaxLinks">Макс. число ссылок на аудит</label>
  <input id="docMaxLinks" type="number" min="1" max="50" step="1" value="${state.docMaxLinks}">
  <label for="auditScope">Scope аудита (glob через запятую, пусто = все)</label>
  <input id="auditScope" type="text" spellcheck="false" placeholder="src/**, extension/src/**" value="${escapeHtml(state.auditScope)}">
  <div class="row">
    <button id="pickScope" type="button" class="secondary">${icon('folder-opened')}<span>Выбрать файлы/папки</span></button>
    <button id="openRules" type="button" class="secondary">${icon('file')}<span>Открыть rules.md</span></button>
  </div>
  <div class="scope-chips" id="scopeChips"></div>
  <p class="scope-warn hidden" id="scopeWarn"></p>
  <p class="hint">rules.md подмешивается в каждый промт. Документация докачивается (таймаут 5с, oversized усекается с сохранением начала), кэшируется в .codescout/docs-cache.json на 24ч. Scope ограничивает полный аудит; ПКМ-проверка его игнорирует.</p>
</section>
<section id="sec-appearance">
  <h2>${icon('symbol-color')} Внешний вид</h2>
  <label for="reportLanguage">Язык отчётов</label>
  <select id="reportLanguage">
    <option value="ru"${state.reportLanguage === 'ru' ? ' selected' : ''}>RU — по-русски</option>
    <option value="en"${state.reportLanguage === 'en' ? ' selected' : ''}>EN — English</option>
  </select>
  <label for="uiTheme">Тема интерфейса</label>
  <select id="uiTheme">
    <option value="auto"${state.uiTheme === 'auto' ? ' selected' : ''}>auto — как в VS Code</option>
    <option value="dark"${state.uiTheme === 'dark' ? ' selected' : ''}>dark — фиксированная тёмная</option>
    <option value="light"${state.uiTheme === 'light' ? ' selected' : ''}>light — фиксированная светлая</option>
  </select>
  <label for="accentColor">Акцентный цвет</label>
  <select id="accentColor">
    <option value="auto"${state.accentColor === 'auto' ? ' selected' : ''}>auto — кнопка VS Code</option>
    <option value="blue"${state.accentColor === 'blue' ? ' selected' : ''}>blue</option>
    <option value="purple"${state.accentColor === 'purple' ? ' selected' : ''}>purple</option>
    <option value="green"${state.accentColor === 'green' ? ' selected' : ''}>green</option>
    <option value="orange"${state.accentColor === 'orange' ? ' selected' : ''}>orange</option>
    <option value="pink"${state.accentColor === 'pink' ? ' selected' : ''}>pink</option>
  </select>
  <label for="uiDensity">Плотность</label>
  <select id="uiDensity">
    <option value="standard"${state.uiDensity === 'standard' ? ' selected' : ''}>standard</option>
    <option value="compact"${state.uiDensity === 'compact' ? ' selected' : ''}>compact</option>
  </select>
  <label for="uiFontSize">Размер шрифта</label>
  <select id="uiFontSize">
    <option value="s"${state.uiFontSize === 's' ? ' selected' : ''}>s — мелкий</option>
    <option value="m"${state.uiFontSize === 'm' ? ' selected' : ''}>m — обычный</option>
    <option value="l"${state.uiFontSize === 'l' ? ' selected' : ''}>l — крупный</option>
  </select>
  <label for="findingsSort">Сортировка находок</label>
  <select id="findingsSort">
    <option value="severity"${state.findingsSort === 'severity' ? ' selected' : ''}>по важности</option>
    <option value="file"${state.findingsSort === 'file' ? ' selected' : ''}>по файлу</option>
    <option value="line"${state.findingsSort === 'line' ? ' selected' : ''}>по строке</option>
  </select>
  <label for="reportTheme">Тема экспортируемого отчёта</label>
  <select id="reportTheme">
    <option value="auto"${state.reportTheme === 'auto' ? ' selected' : ''}>auto</option>
    <option value="dark"${state.reportTheme === 'dark' ? ' selected' : ''}>dark</option>
    <option value="light"${state.reportTheme === 'light' ? ' selected' : ''}>light</option>
  </select>
  <label class="checkbox"><input id="showConfidence" type="checkbox"${state.showConfidence ? ' checked' : ''}> Показывать % уверенности у находок</label>
  <label class="checkbox"><input id="showBanner" type="checkbox"${state.showAuditBanner ? ' checked' : ''}> Баннер «запустить полный аудит» при старте</label>
</section>
<section id="sec-about">
  <h2>${icon('info')} О расширении</h2>
  <div class="about-line">Версия: <strong>${escapeHtml(state.version)}</strong></div>
  <div class="row">
    <button id="openReadme" type="button" class="secondary" data-url="${REPO_URL}#readme">${icon('book')}<span>README</span></button>
    <button id="openRepo" type="button" class="secondary" data-url="${REPO_URL}">${icon('repo')}<span>Репозиторий</span></button>
    <button id="reportIssue" type="button" class="secondary" data-url="${REPO_URL}/issues">${icon('report')}<span>Сообщить о проблеме</span></button>
  </div>
</section>
</main>
</div>
</div>
<div class="savebar">
  <button id="saveAll" type="button" disabled><span class="dirty-dot"></span>${icon('save')}<span>Сохранить</span></button>
  <span class="dirty" id="dirtyHint">нет несохранённых изменений</span>
</div>
<script${nonceAttr}>
const vscode = acquireVsCodeApi();
const providerSelect = document.getElementById('provider');
const baseUrlRow = document.getElementById('baseUrlRow');
const baseUrlInput = document.getElementById('baseUrl');
const keyInput = document.getElementById('apiKey');
const langSelect = document.getElementById('reportLanguage');
const bannerBox = document.getElementById('showBanner');
const uiThemeSelect = document.getElementById('uiTheme');
const accentSelect = document.getElementById('accentColor');
const densitySelect = document.getElementById('uiDensity');
const fontsizeSelect = document.getElementById('uiFontSize');
const sortSelect = document.getElementById('findingsSort');
const reportThemeSelect = document.getElementById('reportTheme');
const showConfidenceBox = document.getElementById('showConfidence');
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
    uiTheme: uiThemeSelect.value, accentColor: accentSelect.value, uiDensity: densitySelect.value,
    uiFontSize: fontsizeSelect.value, findingsSort: sortSelect.value, reportTheme: reportThemeSelect.value,
    showConfidence: showConfidenceBox.checked,
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
  saveAllBtn.classList.toggle('is-dirty', dirty);
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
  saveAllBtn.classList.remove('is-dirty');
  const label = saveAllBtn.querySelector('span:last-child');
  if (label) label.textContent = 'Сохраняю…';
  vscode.postMessage({
    command: 'saveAll',
    providerKey: providerSelect.value,
    baseUrl: baseUrlInput.value.trim(),
    apiKey: keyInput.value.trim() || undefined,
    reportLanguage: langSelect.value,
    showAuditBanner: bannerBox.checked,
    uiTheme: uiThemeSelect.value,
    accentColor: accentSelect.value,
    uiDensity: densitySelect.value,
    uiFontSize: fontsizeSelect.value,
    findingsSort: sortSelect.value,
    reportTheme: reportThemeSelect.value,
    showConfidence: showConfidenceBox.checked,
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
document.getElementById('pickScope').addEventListener('click', () => vscode.postMessage({ command: 'pickScope' }));
const scopeChips = document.getElementById('scopeChips');
const scopeWarn = document.getElementById('scopeWarn');
function splitGlobs(value) {
  const seen = [];
  for (const part of String(value || '').split(',')) { const g = part.trim(); if (g && !seen.includes(g)) seen.push(g); }
  return seen;
}
function renderChips() {
  if (!scopeChips) return;
  scopeChips.textContent = '';
  for (const glob of splitGlobs(auditScopeInput.value)) {
    const chip = document.createElement('span');
    chip.className = 'scope-chip';
    const text = document.createElement('span');
    text.textContent = glob;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = 'Убрать из scope';
    remove.innerHTML = '<i class="codicon codicon-close" aria-hidden="true"></i>';
    remove.addEventListener('click', () => {
      auditScopeInput.value = splitGlobs(auditScopeInput.value).filter((g) => g !== glob).join(', ');
      renderChips();
      refreshDirty();
    });
    chip.appendChild(text);
    chip.appendChild(remove);
    scopeChips.appendChild(chip);
  }
}
auditScopeInput.addEventListener('input', renderChips);
window.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'scopePickResult') return;
  const merged = [];
  for (const g of [...splitGlobs(auditScopeInput.value), ...(data.globs || [])]) { if (g && !merged.includes(g)) merged.push(g); }
  auditScopeInput.value = merged.join(', ');
  renderChips();
  refreshDirty();
  if (scopeWarn) {
    const outside = data.outside || [];
    if (data.noWorkspace) { scopeWarn.textContent = 'Нет открытой папки — выбор недоступен'; scopeWarn.classList.remove('hidden'); }
    else if (outside.length) { scopeWarn.textContent = 'вне workspace, не добавлено: ' + outside.join(', '); scopeWarn.classList.remove('hidden'); }
    else { scopeWarn.textContent = ''; scopeWarn.classList.add('hidden'); }
  }
});
renderChips();
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
