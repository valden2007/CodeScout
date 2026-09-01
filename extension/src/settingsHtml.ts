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
  autoResume: boolean;
  auditScope: string;
}

const providerValues = ['auto', 'gemini', 'groq', 'openrouter', 'github', 'custom'];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildSettingsHtml(state: SettingsState, statusMessage = '', statusKind: 'ok' | 'error' = 'ok'): string {
  const providerOptions = providerValues
    .map((value) => `<option value="${value}"${value === state.provider ? ' selected' : ''}>${value === 'auto' ? 'auto — по ключу' : value}</option>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px 14px 24px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.45; }
.brand { display: flex; align-items: center; gap: 8px; font-size: 17px; font-weight: 700; letter-spacing: -0.2px; }
.brand-mark { color: var(--vscode-textLink-foreground); }
section { margin-top: 16px; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
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
.status { margin-top: 14px; padding: 8px 10px; border-left: 3px solid var(--vscode-textLink-foreground); border-radius: 3px; background: color-mix(in srgb, var(--vscode-textLink-foreground) 12%, transparent); font-size: 12px; ${statusMessage ? '' : 'display: none;'} }
.status.error { border-left-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); }
.current-key { margin-top: 6px; font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
</style>
</head>
<body>
<div class="brand"><span class="brand-mark">🕵️</span> CodeScout: Настройки</div>
<div class="status${statusKind === 'error' ? ' error' : ''}" id="status">${escapeHtml(statusMessage)}</div>
<main>
<section>
  <h2>🔑 Ключ и провайдер</h2>
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
    <button id="saveKey" type="button" disabled>💾 Сохранить</button>
    <button id="chooseModel" type="button" class="secondary">🧲 Живые модели…</button>
    <button id="clearKey" type="button" class="secondary">⌫ Забыть ключ</button>
  </div>
  <p class="hint">auto = groq-ключ → groq, AIza… → gemini, sk-or-… → openrouter, ghp_… → github.</p>
</section>
<section>
  <h2>🎨 Внешний вид</h2>
  <label for="reportLanguage">Язык отчётов</label>
  <select id="reportLanguage">
    <option value="ru"${state.reportLanguage === 'ru' ? ' selected' : ''}>RU — по-русски</option>
    <option value="en"${state.reportLanguage === 'en' ? ' selected' : ''}>EN — English</option>
  </select>
  <label class="checkbox"><input id="showBanner" type="checkbox"${state.showAuditBanner ? ' checked' : ''}> Баннер «запустить полный аудит» при старте</label>
  <div class="row">
    <button id="saveAppearance" type="button" disabled>💾 Сохранить</button>
  </div>
</section>
<section>
  <h2>📁 Проект</h2>
  <label for="docLinks">Ссылки на документацию (одна в строке)</label>
  <textarea id="docLinks" rows="4" spellcheck="false" placeholder="https://docs.example.com/api&#10;https://wiki.internal/architecture">${escapeHtml(state.docLinks.join('\n'))}</textarea>
  <label for="docMaxKb">Макс. размер дока в промт (KB)</label>
  <input id="docMaxKb" type="number" min="1" max="2048" step="1" value="${state.docMaxKb}">
  <label for="docMaxLinks">Макс. число ссылок на аудит</label>
  <input id="docMaxLinks" type="number" min="1" max="50" step="1" value="${state.docMaxLinks}">
  <label for="maxLines">Макс. строк на файл (0 = без лимита)</label>
  <input id="maxLines" type="number" min="0" max="100000" step="1" value="${state.maxLines}">
  <label for="auditScope">Scope аудита (glob через запятую, пусто = все)</label>
  <input id="auditScope" type="text" spellcheck="false" placeholder="src/**, extension/src/**" value="${escapeHtml(state.auditScope)}">
  <label class="checkbox"><input id="autoResume" type="checkbox"${state.autoResume ? ' checked' : ''}> 🤖 Автономный режим (авто-догон)</label>
  <div class="row">
    <button id="saveProject" type="button" disabled>💾 Сохранить</button>
    <button id="openRules" type="button" class="secondary">📜 Открыть rules.md</button>
  </div>
  <p class="hint">rules.md (.codescout/rules.md) подмешивается в каждый промт ревью, создаётся с шаблоном. Ссылки идут в полный аудит: тексты докачиваются (лимиты выше, таймаут 5с; oversized-док усекается до лимита, начало сохраняется), кэшируются в .codescout/docs-cache.json на 24 часа и попадают в промт секцией «Документация проекта». Суммарно больше 100KB — предупреждение про плотный контекст. maxLines = 0: лимита нет, файлы &gt;800 строк режутся чанками с перекрытием 50 строк; maxLines = N: файлы длиннее N скипаются (для слабых моделей).</p>
</section>
</main>
<script>
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
const auditScopeInput = document.getElementById('auditScope');
const autoResumeBox = document.getElementById('autoResume');
const saveKeyBtn = document.getElementById('saveKey');
const saveAppearanceBtn = document.getElementById('saveAppearance');
const saveProjectBtn = document.getElementById('saveProject');
const initial = { providerKey: providerSelect.value, baseUrl: baseUrlInput.value, reportLanguage: langSelect.value, showAuditBanner: bannerBox.checked, docLinks: docLinksInput.value, docMaxKb: docMaxKbInput.value, docMaxLinks: docMaxLinksInput.value, maxLines: maxLinesInput.value, auditScope: auditScopeInput.value, autoResume: autoResumeBox.checked };
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min) return String(Math.min(max, Math.max(min, Number(fallback))));
  return String(Math.min(max, Math.max(min, n)));
}
function toggleBaseUrl() { baseUrlRow.classList.toggle('hidden', providerSelect.value !== 'custom'); }
providerSelect.addEventListener('change', toggleBaseUrl);
function keyDirty() { return providerSelect.value !== initial.providerKey || keyInput.value.trim() !== '' || baseUrlInput.value.trim() !== initial.baseUrl.trim(); }
function appearanceDirty() { return langSelect.value !== initial.reportLanguage || bannerBox.checked !== initial.showAuditBanner; }
function projectDirty() { return docLinksInput.value !== initial.docLinks || docMaxKbInput.value !== initial.docMaxKb || docMaxLinksInput.value !== initial.docMaxLinks || maxLinesInput.value !== initial.maxLines || auditScopeInput.value !== initial.auditScope || autoResumeBox.checked !== initial.autoResume; }
function refreshDirty() {
  saveKeyBtn.disabled = !keyDirty();
  saveAppearanceBtn.disabled = !appearanceDirty();
  saveProjectBtn.disabled = !projectDirty();
}
document.querySelectorAll('input, select, textarea').forEach((el) => {
  el.addEventListener('input', refreshDirty);
  el.addEventListener('change', refreshDirty);
});
document.getElementById('revealKey').addEventListener('change', (event) => {
  keyInput.type = event.target.checked ? 'text' : 'password';
});
saveKeyBtn.addEventListener('click', () => {
  saveKeyBtn.disabled = true;
  saveKeyBtn.textContent = '⏳ Сохраняю…';
  const payload = { command: 'saveKeyProvider', providerKey: providerSelect.value, baseUrl: baseUrlInput.value.trim() };
  const key = keyInput.value.trim();
  if (key) payload.apiKey = key;
  vscode.postMessage(payload);
});
document.getElementById('chooseModel').addEventListener('click', () => vscode.postMessage({ command: 'chooseModel' }));
document.getElementById('clearKey').addEventListener('click', () => vscode.postMessage({ command: 'clearApiKey' }));
saveAppearanceBtn.addEventListener('click', () => {
  saveAppearanceBtn.disabled = true;
  saveAppearanceBtn.textContent = '⏳ Сохраняю…';
  vscode.postMessage({
    command: 'saveAppearance',
    reportLanguage: langSelect.value,
    showAuditBanner: bannerBox.checked
  });
});
saveProjectBtn.addEventListener('click', () => {
  saveProjectBtn.disabled = true;
  saveProjectBtn.textContent = '⏳ Сохраняю…';
  vscode.postMessage({
    command: 'saveDocLinks',
    linksText: docLinksInput.value,
    docMaxKb: Number(clampInt(docMaxKbInput.value, 1, 2048, initial.docMaxKb || '50')),
    docMaxLinks: Number(clampInt(docMaxLinksInput.value, 1, 50, initial.docMaxLinks || '5')),
    maxLines: Number(clampInt(maxLinesInput.value, 0, 100000, initial.maxLines || '0')),
    auditScope: auditScopeInput.value.trim(),
    autoResume: autoResumeBox.checked
  });
});
document.getElementById('openRules').addEventListener('click', () => vscode.postMessage({ command: 'openRules' }));
toggleBaseUrl();
refreshDirty();
</script>
</body>
</html>`;
}
