export interface SettingsState {
  keyMask: string;
  keyConfigured: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  reportLanguage: 'ru' | 'en';
  showAuditBanner: boolean;
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

export function buildSettingsHtml(state: SettingsState, statusMessage = ''): string {
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
button { padding: 6px 12px; border: 1px solid transparent; border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; font-size: 12px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.checkbox { display: flex; align-items: center; gap: 8px; }
.checkbox input { width: auto; }
.hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 6px 0 0; }
.hidden { display: none; }
.status { margin-top: 14px; padding: 8px 10px; border-left: 3px solid var(--vscode-textLink-foreground); border-radius: 3px; background: color-mix(in srgb, var(--vscode-textLink-foreground) 12%, transparent); font-size: 12px; ${statusMessage ? '' : 'display: none;'} }
.current-key { margin-top: 6px; font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
</style>
</head>
<body>
<div class="brand"><span class="brand-mark">🕵️</span> CodeScout: Настройки</div>
<div class="status" id="status">${escapeHtml(statusMessage)}</div>
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
    <button id="saveKey" type="button">💾 Сохранить</button>
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
    <button id="saveAppearance" type="button">💾 Сохранить</button>
  </div>
</section>
</main>
<script>
const vscode = acquireVsCodeApi();
const providerSelect = document.getElementById('provider');
const baseUrlRow = document.getElementById('baseUrlRow');
function toggleBaseUrl() { baseUrlRow.classList.toggle('hidden', providerSelect.value !== 'custom'); }
providerSelect.addEventListener('change', toggleBaseUrl);
document.getElementById('revealKey').addEventListener('change', (event) => {
  document.getElementById('apiKey').type = event.target.checked ? 'text' : 'password';
});
document.getElementById('saveKey').addEventListener('click', () => {
  const payload = { command: 'saveKeyProvider', providerKey: providerSelect.value, baseUrl: document.getElementById('baseUrl').value.trim() };
  const key = document.getElementById('apiKey').value.trim();
  if (key) payload.apiKey = key;
  vscode.postMessage(payload);
});
document.getElementById('chooseModel').addEventListener('click', () => vscode.postMessage({ command: 'chooseModel' }));
document.getElementById('clearKey').addEventListener('click', () => vscode.postMessage({ command: 'clearApiKey' }));
document.getElementById('saveAppearance').addEventListener('click', () => {
  vscode.postMessage({
    command: 'saveAppearance',
    reportLanguage: document.getElementById('reportLanguage').value,
    showAuditBanner: document.getElementById('showBanner').checked
  });
});
toggleBaseUrl();
</script>
</body>
</html>`;
}
