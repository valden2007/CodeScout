import { uiBodyAttrs, uiTokensCss, normalizeCustomColors, type UiPrefs, type CustomColors } from './uiPrefs';
import { t, type Lang } from '../../src/i18n';

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
  rateLimitPauses?: number;
  version: string;
  uiTheme: 'auto' | 'dark' | 'light' | 'custom';
  accentColor: 'auto' | 'blue' | 'purple' | 'green' | 'orange' | 'pink';
  uiDensity: 'compact' | 'standard';
  uiFontSize: 's' | 'm' | 'l';
  showConfidence: boolean;
  findingsSort: 'severity' | 'file' | 'line';
  reportTheme: 'auto' | 'dark' | 'light';
  customColors: string;
}

export interface SettingsAssets {
  codiconCss: string;
  cspSource: string;
}

const providerValues = ['auto', 'gemini', 'groq', 'openrouter', 'github', 'custom'];

const REPO_URL = 'https://github.com/valden2007/CodeScout';

const colorFields: { key: keyof CustomColors }[] = [
  { key: 'bg' },
  { key: 'card' },
  { key: 'fg' },
  { key: 'desc' },
  { key: 'border' },
  { key: 'accent' },
  { key: 'btnBg' },
  { key: 'btnFg' },
  { key: 'btnHover' },
  { key: 'inputBg' },
  { key: 'inputFg' },
  { key: 'error' },
  { key: 'warn' },
  { key: 'pass' },
  { key: 'chipBg' },
  { key: 'chipFg' }
];

const geometryFields: { key: keyof CustomColors; min: number; max: number }[] = [
  { key: 'btnRadius', min: 2, max: 12 },
  { key: 'btnHeight', min: 24, max: 40 },
  { key: 'cardRadius', min: 0, max: 16 }
];

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

export function buildSettingsHtml(state: SettingsState, statusMessage = '', statusKind: 'ok' | 'error' = 'ok', nonce = '', anchor = '', assets?: SettingsAssets, lang: Lang = 'ru'): string {
  const T = (key: string, vars?: Record<string, string | number>) => t(key, lang, vars);
  const scriptSrc = nonce ? `'nonce-${nonce}'` : "'unsafe-inline'";
  const styleSrc = nonce ? `'nonce-${nonce}'` : "'unsafe-inline'";
  const csp = assets
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${assets.cspSource}; img-src data:; style-src ${styleSrc} ${assets.cspSource}; script-src ${scriptSrc};">`
    : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${styleSrc}; script-src ${scriptSrc};">`;
  const codiconLink = assets ? `<link rel="stylesheet" href="${assets.codiconCss}">` : '';
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const providerOptions = providerValues
    .map((value) => `<option value="${value}"${value === state.provider ? ' selected' : ''}>${value === 'auto' ? T('center.providerAuto') : value}</option>`)
    .join('');
  const prefs: UiPrefs = { theme: state.uiTheme, accent: state.accentColor, density: state.uiDensity, fontSize: state.uiFontSize, showConfidence: state.showConfidence, findingsSort: state.findingsSort, reportTheme: state.reportTheme, customColors: normalizeCustomColors(state.customColors) };
  const cc = prefs.customColors;
  return `<!DOCTYPE html>
<html lang="${lang}">
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
section { margin: 0 0 14px; padding: var(--cs-space-3); border: 1px solid var(--cs-card-border); border-radius: var(--cs-radius-card); background: var(--cs-card-bg); box-shadow: var(--cs-shadow); scroll-margin-top: var(--cs-space-2); }
h2 { display: flex; align-items: center; gap: var(--cs-space-2); margin: 0 0 6px; font-size: var(--cs-font-3); font-weight: 600; color: var(--cs-accent); }
label { display: block; margin: 10px 0 var(--cs-space-1); font-size: var(--cs-font-2); color: var(--cs-desc); }
input, select { width: 100%; padding: 6px var(--cs-space-2); border: 1px solid var(--cs-input-border); border-radius: var(--cs-radius-1); color: var(--cs-input-fg); background: var(--cs-input-bg); font: inherit; }
select { color: var(--cs-select-fg); background: var(--cs-select-bg); }
input[type="checkbox"] { accent-color: var(--cs-accent); }
textarea { width: 100%; padding: 6px var(--cs-space-2); border: 1px solid var(--cs-input-border); border-radius: var(--cs-radius-1); color: var(--cs-input-fg); background: var(--cs-input-bg); font: inherit; font-size: var(--cs-font-2); resize: vertical; }
button { display: inline-flex; align-items: center; gap: var(--cs-space-2); min-height: var(--cs-btn-height); padding: 6px var(--cs-space-3); border: 1px solid transparent; border-radius: var(--cs-radius-btn); color: var(--cs-btn-fg); background: var(--cs-btn-bg); font: inherit; font-size: var(--cs-font-2); cursor: pointer; }
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
.savebar { position: fixed; left: 200px; right: 0; bottom: 0; display: flex; align-items: center; gap: 10px; padding: 10px var(--cs-space-4); border-top: 1px solid var(--cs-border); background: var(--cs-card-bg); color: var(--cs-fg); }
.savebar .dirty { color: var(--cs-desc); font-size: var(--cs-font-1); }
.dirty-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--cs-warn); display: none; }
button.is-dirty .dirty-dot { display: inline-block; }
.about-line { display: flex; align-items: center; gap: var(--cs-space-2); margin: 6px 0; font-size: var(--cs-font-2); }
.scope-chips { display: flex; flex-wrap: wrap; gap: var(--cs-space-1); margin-top: var(--cs-space-2); }
.scope-chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--cs-input-border); border-radius: 999px; padding: 1px var(--cs-space-2); font-size: var(--cs-font-1); font-family: var(--vscode-editor-font-family); background: var(--cs-chip-bg); color: var(--cs-chip-fg); }
.scope-chip button { display: inline-flex; padding: 0; border: none; background: transparent; color: var(--cs-desc); width: auto; flex: 0 0 auto; }
.scope-chip button:hover { background: transparent; color: var(--cs-error); }
.scope-warn { color: var(--cs-warn); font-size: var(--cs-font-1); margin: var(--cs-space-2) 0 0; }
.palette-editor { margin-top: var(--cs-space-2); padding: var(--cs-space-2); border: 1px solid var(--cs-card-border); border-radius: var(--cs-radius-1); background: color-mix(in srgb, var(--cs-accent) 5%, transparent); }
.palette-row { display: grid; grid-template-columns: 1fr auto 92px; align-items: center; gap: var(--cs-space-2); margin: 6px 0; }
.palette-row label { margin: 0; }
.cc-color { width: 40px; height: 26px; padding: 0; border: 1px solid var(--cs-input-border); border-radius: var(--cs-radius-1); background: var(--cs-input-bg); }
.cc-hex { font-family: var(--vscode-editor-font-family); font-size: var(--cs-font-1); }
.contrast-hint { color: var(--cs-warn); background: color-mix(in srgb, var(--cs-warn) 14%, transparent); border-radius: var(--cs-radius-1); padding: var(--cs-space-1) var(--cs-space-2); font-size: var(--cs-font-1); margin: var(--cs-space-2) 0 0; }
.subtabs { display: flex; gap: var(--cs-space-1); margin-bottom: var(--cs-space-3); border-bottom: 1px solid var(--cs-border); }
.subtab-btn { width: auto; border: none; border-bottom: 2px solid transparent; background: transparent; color: var(--cs-desc); border-radius: 0; padding: var(--cs-space-2) var(--cs-space-3); }
.subtab-btn:hover:not(:disabled) { background: transparent; }
.subtab-btn.active { color: var(--cs-accent); border-bottom-color: var(--cs-accent); font-weight: 600; }
#subtab-custom h3 { margin: var(--cs-space-3) 0 var(--cs-space-1); font-size: var(--cs-font-1); text-transform: uppercase; letter-spacing: 0.5px; color: var(--cs-desc); }
.theme-inactive { display: flex; align-items: center; gap: var(--cs-space-2); color: var(--cs-warn); background: color-mix(in srgb, var(--cs-warn) 12%, transparent); border-radius: var(--cs-radius-1); padding: var(--cs-space-2); font-size: var(--cs-font-1); margin: 0 0 var(--cs-space-2); }
.theme-inactive button { width: auto; padding: 3px var(--cs-space-2); font-size: var(--cs-font-1); }
.cc-num { font-family: var(--vscode-editor-font-family); font-size: var(--cs-font-1); }
#themeJson { margin-top: var(--cs-space-2); font-family: var(--vscode-editor-font-family); font-size: var(--cs-font-1); }
</style>
</head>
<body data-anchor="${escapeHtml(anchor)}" ${uiBodyAttrs(prefs)}>
<div class="brand"><span class="brand-mark">${icon('search')}</span> ${T('title.center')}</div>
<div class="layout">
<nav class="sidebar" id="sidebar">
  <a class="nav-link active" href="#sec-key" data-target="sec-key">${icon('key')}<span>${T('sec.key')}</span></a>
  <a class="nav-link" href="#sec-audit" data-target="sec-audit">${icon('sync')}<span>${T('sec.audit')}</span></a>
  <a class="nav-link" href="#sec-project" data-target="sec-project">${icon('folder')}<span>${T('sec.project')}</span></a>
  <a class="nav-link" href="#sec-appearance" data-target="sec-appearance">${icon('symbol-color')}<span>${T('sec.appearance')}</span></a>
  <a class="nav-link" href="#sec-about" data-target="sec-about">${icon('info')}<span>${T('sec.about')}</span></a>
</nav>
<div class="content">
<div class="status${statusKind === 'error' ? ' error' : ''}" id="status">${escapeHtml(statusMessage)}</div>
<main>
<section id="sec-key">
  <h2>${icon('key')} ${T('sec.key')}</h2>
  <label for="provider">${T('center.provider')}</label>
  <select id="provider">${providerOptions}</select>
  <label for="apiKey">${T('center.apiKeyLabel')}</label>
  <input id="apiKey" type="password" autocomplete="off" placeholder="${state.keyConfigured ? T('center.keyKeep') : T('center.keyPaste')}">
  <label class="checkbox"><input id="revealKey" type="checkbox"> ${T('center.reveal')}</label>
  <div id="baseUrlRow" class="${state.provider === 'custom' ? '' : 'hidden'}">
    <label for="baseUrl">${T('center.baseUrl')}</label>
    <input id="baseUrl" type="text" autocomplete="off" placeholder="http://localhost:11434/v1" value="${escapeHtml(state.baseUrl)}">
    <p class="hint">${T('center.baseUrlHint')}</p>
  </div>
  <div class="current-key">${T('center.now')} ${state.keyConfigured ? `${escapeHtml(state.keyMask)} · ${escapeHtml(state.provider)} · ${escapeHtml(state.model)}` : T('center.nowNone')}</div>
  <div class="row">
    <button id="chooseModel" type="button" class="secondary">${icon('cloud-download')}<span>${T('center.liveModels')}</span></button>
    <button id="clearKey" type="button" class="secondary">${icon('trash')}<span>${T('center.forgetKey')}</span></button>
  </div>
  <p class="hint">${T('center.prefixHint')}</p>
</section>
<section id="sec-audit">
  <h2>${icon('sync')} ${T('sec.audit')}</h2>
  <label for="auditPasses">${T('audit.passes')}</label>
  <input id="auditPasses" type="number" min="1" max="3" step="1" value="${state.auditPasses}">
  <label for="maxLines">${T('audit.maxLines')}</label>
  <input id="maxLines" type="number" min="0" max="100000" step="1" value="${state.maxLines}">
  <label for="maxFiles">${T('audit.maxFiles')}</label>
  <input id="maxFiles" type="number" min="1" max="10000" step="1" value="${state.maxFiles}">
  <label class="checkbox"><input id="autoResume" type="checkbox"${state.autoResume ? ' checked' : ''}> ${icon('robot')}<span>${T('audit.autoResume')}</span></label>
  <label for="autoResumeMaxAttempts">${T('audit.autoMaxAttempts')}</label>
  <input id="autoResumeMaxAttempts" type="number" min="0" max="1000" step="1" value="${state.autoResumeMaxAttempts}">
  <label for="autoResumeMaxMinutes">${T('audit.autoMaxMinutes')}</label>
  <input id="autoResumeMaxMinutes" type="number" min="0" max="10000" step="1" value="${state.autoResumeMaxMinutes}">
  <label for="rateLimitPauses">${T('audit.rateLimitPauses')}</label>
  <input id="rateLimitPauses" type="number" min="0" max="5" step="1" value="${state.rateLimitPauses ?? 3}">
  <label for="findingsSort">${T('audit.findingsSort')}</label>
  <select id="findingsSort">
    <option value="severity"${state.findingsSort === 'severity' ? ' selected' : ''}>${T('audit.sortSeverity')}</option>
    <option value="file"${state.findingsSort === 'file' ? ' selected' : ''}>${T('audit.sortFile')}</option>
    <option value="line"${state.findingsSort === 'line' ? ' selected' : ''}>${T('audit.sortLine')}</option>
  </select>
  <p class="hint">${T('audit.hint')}</p>
</section>
<section id="sec-project">
  <h2>${icon('folder')} ${T('sec.project')}</h2>
  <label for="docLinks">${T('project.docLinks')}</label>
  <textarea id="docLinks" rows="4" spellcheck="false" placeholder="https://docs.example.com/api&#10;https://wiki.internal/architecture">${escapeHtml(state.docLinks.join('\n'))}</textarea>
  <label for="docMaxKb">${T('project.docMaxKb')}</label>
  <input id="docMaxKb" type="number" min="1" max="2048" step="1" value="${state.docMaxKb}">
  <label for="docMaxLinks">${T('project.docMaxLinks')}</label>
  <input id="docMaxLinks" type="number" min="1" max="50" step="1" value="${state.docMaxLinks}">
  <label for="auditScope">${T('project.auditScope')}</label>
  <input id="auditScope" type="text" spellcheck="false" placeholder="src/**, extension/src/**" value="${escapeHtml(state.auditScope)}">
  <div class="row">
    <button id="pickScope" type="button" class="secondary">${icon('folder-opened')}<span>${T('project.pickFiles')}</span></button>
    <button id="openRules" type="button" class="secondary">${icon('file')}<span>${T('project.openRules')}</span></button>
  </div>
  <div class="scope-chips" id="scopeChips"></div>
  <p class="scope-warn hidden" id="scopeWarn"></p>
  <p class="hint">${T('project.hint')}</p>
</section>
<section id="sec-appearance">
  <h2>${icon('symbol-color')} ${T('sec.appearance')}</h2>
  <div class="subtabs">
    <button type="button" class="subtab-btn active" data-subtab="subtab-basic">${T('subtab.basic')}</button>
    <button type="button" class="subtab-btn" data-subtab="subtab-custom">${T('subtab.custom')}</button>
  </div>
  <div class="subtab" id="subtab-basic">
    <label for="reportLanguage">${T('appear.language')}</label>
    <select id="reportLanguage">
      <option value="ru"${state.reportLanguage === 'ru' ? ' selected' : ''}>${T('appear.langRu')}</option>
      <option value="en"${state.reportLanguage === 'en' ? ' selected' : ''}>${T('appear.langEn')}</option>
    </select>
    <label for="uiTheme">${T('appear.uiTheme')}</label>
    <select id="uiTheme">
      <option value="auto"${state.uiTheme === 'auto' ? ' selected' : ''}>${T('appear.themeAuto')}</option>
      <option value="dark"${state.uiTheme === 'dark' ? ' selected' : ''}>${T('appear.themeDark')}</option>
      <option value="light"${state.uiTheme === 'light' ? ' selected' : ''}>${T('appear.themeLight')}</option>
      <option value="custom"${state.uiTheme === 'custom' ? ' selected' : ''}>${T('appear.themeCustom')}</option>
    </select>
    <div class="row">
      <button id="openThemeEditor" type="button" class="secondary">${icon('symbol-color')}<span>${T('appear.themeEditor')}</span></button>
    </div>
    <label for="accentColor">${T('appear.accent')}</label>
    <select id="accentColor">
      <option value="auto"${state.accentColor === 'auto' ? ' selected' : ''}>${T('appear.accentAuto')}</option>
      <option value="blue"${state.accentColor === 'blue' ? ' selected' : ''}>blue</option>
      <option value="purple"${state.accentColor === 'purple' ? ' selected' : ''}>purple</option>
      <option value="green"${state.accentColor === 'green' ? ' selected' : ''}>green</option>
      <option value="orange"${state.accentColor === 'orange' ? ' selected' : ''}>orange</option>
      <option value="pink"${state.accentColor === 'pink' ? ' selected' : ''}>pink</option>
    </select>
    <label for="uiDensity">${T('appear.density')}</label>
    <select id="uiDensity">
      <option value="standard"${state.uiDensity === 'standard' ? ' selected' : ''}>${T('appear.densityStandard')}</option>
      <option value="compact"${state.uiDensity === 'compact' ? ' selected' : ''}>${T('appear.densityCompact')}</option>
    </select>
    <label for="reportTheme">${T('appear.reportTheme')}</label>
    <select id="reportTheme">
      <option value="auto"${state.reportTheme === 'auto' ? ' selected' : ''}>${T('appear.rtAuto')}</option>
      <option value="dark"${state.reportTheme === 'dark' ? ' selected' : ''}>${T('appear.rtDark')}</option>
      <option value="light"${state.reportTheme === 'light' ? ' selected' : ''}>${T('appear.rtLight')}</option>
    </select>
    <label class="checkbox"><input id="showConfidence" type="checkbox"${state.showConfidence ? ' checked' : ''}> ${T('appear.showConfidence')}</label>
    <label class="checkbox"><input id="showBanner" type="checkbox"${state.showAuditBanner ? ' checked' : ''}> ${T('appear.showBanner')}</label>
  </div>
  <div class="subtab hidden" id="subtab-custom">
    <p class="theme-inactive${state.uiTheme === 'custom' ? ' hidden' : ''}" id="themeInactiveHint">${T('appear.customHint')}
      <button id="enableCustom" type="button" class="secondary">${icon('wand')}<span>${T('appear.enableCustom')}</span></button>
    </p>
    <div id="themeEditor">
      <h3>${T('palette.colors')}</h3>
      ${colorFields.map((f) => `
      <div class="palette-row">
        <label for="cc-${f.key}">${T('cc.' + f.key)}</label>
        <input id="cc-${f.key}" class="cc-color" type="color" data-key="${f.key}" value="${escapeHtml(String(cc[f.key]))}">
        <input class="cc-hex" type="text" data-key="${f.key}" spellcheck="false" maxlength="7" value="${escapeHtml(String(cc[f.key]))}">
      </div>`).join('')}
      <h3>${T('palette.geometry')}</h3>
      ${geometryFields.map((f) => `
      <div class="palette-row">
        <label for="cg-${f.key}">${T('geom.' + f.key)}</label>
        <input id="cg-${f.key}" class="cc-num" type="number" data-key="${f.key}" min="${f.min}" max="${f.max}" step="1" value="${cc[f.key]}">
        <span></span>
      </div>`).join('')}
      <h3>${T('palette.typography')}</h3>
      <label for="uiFontSize">${T('palette.fontSize')}</label>
      <select id="uiFontSize">
        <option value="s"${state.uiFontSize === 's' ? ' selected' : ''}>${T('palette.fontS')}</option>
        <option value="m"${state.uiFontSize === 'm' ? ' selected' : ''}>${T('palette.fontM')}</option>
        <option value="l"${state.uiFontSize === 'l' ? ' selected' : ''}>${T('palette.fontL')}</option>
      </select>
      <div class="row">
        <button id="resetPalette" type="button" class="secondary">${icon('discard')}<span>${T('palette.reset')}</span></button>
        <button id="copyTheme" type="button" class="secondary">${icon('clippy')}<span>${T('palette.copy')}</span></button>
        <button id="applyTheme" type="button" class="secondary">${icon('desktop-download')}<span>${T('palette.apply')}</span></button>
      </div>
      <textarea id="themeJson" rows="4" spellcheck="false" placeholder='{"bg":"#…","btnRadius":4,…}'></textarea>
      <p class="contrast-hint hidden" id="contrastHint">${T('palette.contrastHint')}</p>
    </div>
  </div>
</section>
<section id="sec-about">
  <h2>${icon('info')} ${T('sec.about')}</h2>
  <div class="about-line">${T('about.version')} <strong>${escapeHtml(state.version)}</strong></div>
  <div class="row">
    <button id="openReadme" type="button" class="secondary" data-url="${REPO_URL}#readme">${icon('book')}<span>${T('about.readme')}</span></button>
    <button id="openRepo" type="button" class="secondary" data-url="${REPO_URL}">${icon('repo')}<span>${T('about.repo')}</span></button>
    <button id="reportIssue" type="button" class="secondary" data-url="${REPO_URL}/issues">${icon('report')}<span>${T('about.issue')}</span></button>
  </div>
</section>
</main>
</div>
</div>
<div class="savebar">
  <button id="saveAll" type="button" disabled><span class="dirty-dot"></span>${icon('save')}<span>${T('save.save')}</span></button>
  <span class="dirty" id="dirtyHint">${T('save.clean')}</span>
</div>
<script${nonceAttr}>
const vscode = acquireVsCodeApi();
const UI = ${JSON.stringify(['save.save', 'save.saving', 'save.clean', 'save.dirty', 'chip.removeTip', 'form.pickOutside', 'form.pickNoWorkspace'].reduce((acc, k) => { acc[k] = T(k); return acc; }, {} as Record<string, string>))};
function L(key) { return UI[key] || key; }
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
const rateLimitPausesInput = document.getElementById('rateLimitPauses');
const saveAllBtn = document.getElementById('saveAll');
const dirtyHint = document.getElementById('dirtyHint');
const themeEditor = document.getElementById('themeEditor');
const contrastHint = document.getElementById('contrastHint');
const themeInactiveHint = document.getElementById('themeInactiveHint');
const CC_KEYS = ['bg', 'card', 'fg', 'desc', 'border', 'accent', 'inputBg', 'inputFg', 'btnBg', 'btnFg', 'btnHover', 'error', 'warn', 'pass', 'chipBg', 'chipFg'];
const CC_VAR = { bg: '--cs-editor-bg', card: '--cs-card-bg', fg: '--cs-fg', desc: '--cs-desc', border: '--cs-border', accent: '--cs-accent', inputBg: '--cs-input-bg', inputFg: '--cs-input-fg', btnBg: '--cs-btn-bg', btnFg: '--cs-btn-fg', btnHover: '--cs-btn-hover', error: '--cs-error', warn: '--cs-warn', pass: '--cs-pass', chipBg: '--cs-chip-bg', chipFg: '--cs-chip-fg' };
const GEOM_KEYS = ['btnRadius', 'btnHeight', 'cardRadius'];
const GEOM_VAR = { btnRadius: ['--cs-radius-btn', 'px'], btnHeight: ['--cs-btn-height', 'px'], cardRadius: ['--cs-radius-card', 'px'] };
const CC_DEFAULT = ${JSON.stringify(cc)};
function hexInputs() { return Array.prototype.slice.call(document.querySelectorAll('#themeEditor .cc-hex')); }
function numInputs() { return Array.prototype.slice.call(document.querySelectorAll('#themeEditor .cc-num')); }
function collectPalette() {
  const m = {};
  hexInputs().forEach((el) => { m[el.getAttribute('data-key')] = el.value; });
  numInputs().forEach((el) => { m[el.getAttribute('data-key')] = Number(el.value); });
  return JSON.stringify(m);
}
function lum(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return null;
  const n = parseInt(h, 16); if (isNaN(n)) return null;
  const ch = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}
function lowContrast(fg, bg) { const a = lum(fg), b = lum(bg); if (a === null || b === null) return false; const hi = Math.max(a, b), lo = Math.min(a, b); return (hi + 0.05) / (lo + 0.05) < 4.5; }
function applyPreview() {
  const isCustom = uiThemeSelect.value === 'custom';
  if (themeInactiveHint) themeInactiveHint.classList.toggle('hidden', isCustom);
  const m = {}; hexInputs().forEach((el) => { m[el.getAttribute('data-key')] = el.value; });
  numInputs().forEach((el) => { m[el.getAttribute('data-key')] = el.value; });
  for (const k of CC_KEYS) { if (isCustom) document.body.style.setProperty(CC_VAR[k], m[k] || ''); else document.body.style.removeProperty(CC_VAR[k]); }
  for (const k of GEOM_KEYS) { if (isCustom) document.body.style.setProperty(GEOM_VAR[k][0], (m[k] || '') + GEOM_VAR[k][1]); else document.body.style.removeProperty(GEOM_VAR[k][0]); }
  if (contrastHint) {
    const low = isCustom && (lowContrast(m.fg, m.bg) || lowContrast(m.fg, m.card) || lowContrast(m.inputFg, m.inputBg) || lowContrast(m.btnFg, m.btnBg) || lowContrast(m.error, m.bg) || lowContrast(m.warn, m.bg) || lowContrast(m.pass, m.bg));
    contrastHint.classList.toggle('hidden', !low);
  }
}
function setColor(key, value) {
  const colorEl = document.querySelector('#themeEditor .cc-color[data-key="' + key + '"]');
  const hexEl = document.querySelector('#themeEditor .cc-hex[data-key="' + key + '"]');
  if (hexEl) hexEl.value = value;
  if (colorEl && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value).trim())) colorEl.value = String(value).trim();
}
function syncRow(el) {
  const key = el.getAttribute('data-key');
  if (el.classList.contains('cc-color')) { const hexEl = document.querySelector('#themeEditor .cc-hex[data-key="' + key + '"]'); if (hexEl) hexEl.value = el.value; }
  if (el.classList.contains('cc-hex')) { const colorEl = document.querySelector('#themeEditor .cc-color[data-key="' + key + '"]'); if (colorEl && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(el.value.trim())) colorEl.value = el.value.trim(); }
}
function ensureCustom() {
  if (uiThemeSelect.value !== 'custom') {
    uiThemeSelect.value = 'custom';
    uiThemeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
document.querySelectorAll('#themeEditor .cc-color, #themeEditor .cc-hex, #themeEditor .cc-num').forEach((el) => {
  el.addEventListener('input', () => { ensureCustom(); syncRow(el); applyPreview(); refreshDirty(); });
});
uiThemeSelect.addEventListener('change', applyPreview);
const openThemeBtn = document.getElementById('openThemeEditor');
if (openThemeBtn) openThemeBtn.addEventListener('click', () => showSubtab('subtab-custom'));
const enableCustomBtn = document.getElementById('enableCustom');
if (enableCustomBtn) enableCustomBtn.addEventListener('click', () => { ensureCustom(); applyPreview(); refreshDirty(); });
const resetBtn = document.getElementById('resetPalette');
if (resetBtn) resetBtn.addEventListener('click', () => {
  ensureCustom();
  for (const k of CC_KEYS) setColor(k, CC_DEFAULT[k]);
  for (const k of GEOM_KEYS) { const numEl = document.querySelector('#themeEditor .cc-num[data-key="' + k + '"]'); if (numEl) numEl.value = CC_DEFAULT[k]; }
  applyPreview();
  refreshDirty();
});
const copyBtn = document.getElementById('copyTheme');
const themeJson = document.getElementById('themeJson');
if (copyBtn && themeJson) copyBtn.addEventListener('click', () => { themeJson.value = collectPalette(); themeJson.select(); });
const applyBtn = document.getElementById('applyTheme');
if (applyBtn && themeJson) applyBtn.addEventListener('click', () => {
  try {
    const parsed = JSON.parse(themeJson.value);
    if (parsed && typeof parsed === 'object') {
      ensureCustom();
      for (const k of CC_KEYS) { if (typeof parsed[k] === 'string') setColor(k, parsed[k]); }
      for (const k of GEOM_KEYS) { if (Number.isFinite(Number(parsed[k]))) { const numEl = document.querySelector('#themeEditor .cc-num[data-key="' + k + '"]'); if (numEl) numEl.value = Number(parsed[k]); } }
      applyPreview();
      refreshDirty();
    }
  } catch (e) { /* ignore malformed JSON */ }
});
function showSubtab(id) {
  document.querySelectorAll('.subtab').forEach((p) => p.classList.toggle('hidden', p.id !== id));
  document.querySelectorAll('.subtab-btn').forEach((b) => b.classList.toggle('active', b.getAttribute('data-subtab') === id));
}
document.querySelectorAll('.subtab-btn').forEach((b) => b.addEventListener('click', () => showSubtab(b.getAttribute('data-subtab'))));
function snapshot() {
  return JSON.stringify({
    providerKey: providerSelect.value, baseUrl: baseUrlInput.value, key: keyInput.value,
    reportLanguage: langSelect.value, showAuditBanner: bannerBox.checked,
    uiTheme: uiThemeSelect.value, accentColor: accentSelect.value, uiDensity: densitySelect.value,
    uiFontSize: fontsizeSelect.value, findingsSort: sortSelect.value, reportTheme: reportThemeSelect.value,
    showConfidence: showConfidenceBox.checked, customColors: collectPalette(),
    docLinks: docLinksInput.value, docMaxKb: docMaxKbInput.value, docMaxLinks: docMaxLinksInput.value,
    maxLines: maxLinesInput.value, maxFiles: maxFilesInput.value, auditScope: auditScopeInput.value,
    auditPasses: auditPassesInput.value, autoResume: autoResumeBox.checked,
    autoResumeMaxAttempts: autoResumeMaxAttemptsInput.value, autoResumeMaxMinutes: autoResumeMaxMinutesInput.value, rateLimitPauses: rateLimitPausesInput.value
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
  dirtyHint.textContent = dirty ? L('save.dirty') : L('save.clean');
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
  if (label) label.textContent = L('save.saving');
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
    customColors: collectPalette(),
    linksText: docLinksInput.value,
    docMaxKb: Number(clampInt(docMaxKbInput.value, 1, 2048, '50')),
    docMaxLinks: Number(clampInt(docMaxLinksInput.value, 1, 50, '5')),
    maxLines: Number(clampInt(maxLinesInput.value, 0, 100000, '0')),
    maxFiles: Number(clampInt(maxFilesInput.value, 1, 10000, '100')),
    auditScope: auditScopeInput.value.trim(),
    auditPasses: Number(clampInt(auditPassesInput.value, 1, 3, '1')),
    autoResume: autoResumeBox.checked,
    autoResumeMaxAttempts: Number(clampInt(autoResumeMaxAttemptsInput.value, 0, 1000, '0')),
    autoResumeMaxMinutes: Number(clampInt(autoResumeMaxMinutesInput.value, 0, 10000, '0')),
    rateLimitPauses: Number(clampInt(rateLimitPausesInput.value, 0, 5, '3'))
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
    remove.title = L('chip.removeTip');
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
    if (data.noWorkspace) { scopeWarn.textContent = L('form.pickNoWorkspace'); scopeWarn.classList.remove('hidden'); }
    else if (outside.length) { scopeWarn.textContent = L('form.pickOutside') + ' ' + outside.join(', '); scopeWarn.classList.remove('hidden'); }
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
applyPreview();
onScroll();
const anchor = document.body.getAttribute('data-anchor');
if (anchor) { const el = document.getElementById(anchor); if (el) { el.scrollIntoView(); setActive(anchor); } }
</script>
</body>
</html>`;
}
