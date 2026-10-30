import { uiBodyAttrs, uiTokensCss, normalizeCustomColors, type UiPrefs, type CustomColors } from './uiPrefs';
import { t, type Lang } from '../../src/i18n';
import { CODESCOUT_REPO_URL as REPO_URL } from './reportIssue';
import { PROVIDER_ORDER } from '../../src/providers';
import type { KeychainProfile, KeyRuntimeView } from './keychain';

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
  requestTimeoutSeconds?: number;
  version: string;
  uiTheme: 'auto' | 'dark' | 'light' | 'custom';
  accentColor: 'auto' | 'blue' | 'purple' | 'green' | 'orange' | 'pink';
  uiDensity: 'compact' | 'standard';
  uiFontSize: 's' | 'm' | 'l';
  showConfidence: boolean;
  findingsSort: 'severity' | 'file' | 'line';
  reportTheme: 'auto' | 'dark' | 'light';
  customColors: string;
  // Батч 27: keychain — профили ключей + failover. Опциональны: старые
  // вызовы (тесты) рендерят блок в пустом виде.
  keychainProfiles?: KeychainProfile[];
  keychainActiveId?: string;
  // Батч 28: состояние ключей («profileId/keyId» → asleep/broken) — бейджи.
  keychainRuntime?: Record<string, KeyRuntimeView>;
  // МИКРО-БАТЧ 28.9: метка АКТИВНОГО профиля для строки «сейчас:» —
  // источник один: ключ/провайдер/модель профиля + его метка.
  keyActiveLabel?: string;
  failoverEnabled?: boolean;
  failoverMaxCycles?: number;
  // МИКРО-БАТЧ 28.2: инлайн-форма профиля. draft != undefined = форма
  // открыта хостом (перерисовка после ошибки валидации) с этими значениями;
  // error — текст валидации ВНУТРИ карточки (не в глобальном статусе).
  keychainFormDraft?: { profileId?: string; provider?: string; label?: string; model?: string; baseUrl?: string };
  keychainFormError?: string;
}

export interface SettingsAssets {
  codiconCss: string;
  cspSource: string;
}

// Батч 18: в селекте только реальные провайдеры в порядке PROVIDER_ORDER
// (custom → openai → anthropic → …). Системный 'auto' скрыт из UI:
// автодетект по префиксу ключа живёт под капотом в saveKeyProvider.
const providerValues = [...PROVIDER_ORDER];

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

// HOTFIX: имя локального сервиса по порту OpenAI-совместимого адреса.
// Нужен для строго динамической строки «сейчас:» без устаревших дефолтов.
export function localServiceName(baseUrl: string): string | undefined {
  const match = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?(?:\/|$)/i.exec((baseUrl ?? '').trim());
  if (!match) return undefined;
  if (match[1] === '11434') return 'Ollama';
  if (match[1] === '1234') return 'LM Studio';
  return 'localhost';
}

// Батч 22.2, п.1/п.3: совпадает с isLocalBaseUrl(providers) — оверрайд
// codescout.baseUrl реально применяется только к custom и localhost-режиму.
const LOCAL_BASE_URL_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i;

function currentKeyLine(T: (key: string, vars?: Record<string, string | number>) => string, state: SettingsState): string {
  if (state.keyConfigured) {
    const model = state.model.trim() || T('center.nowModelMissing');
    // МИКРО-БАТЧ 28.9: «сейчас:» = активный профиль (маска ключа, провайдер и
    // модель — из него же) + его метка; legacy-слот в строку не подмешивается.
    const label = state.keyActiveLabel?.trim();
    const tail = label ? ` · ${T('center.nowProfile', { label: escapeHtml(label) })}` : '';
    return `${escapeHtml(state.keyMask)} · ${escapeHtml(state.provider)} · ${escapeHtml(model)}${tail}`;
  }
  const local = localServiceName(state.baseUrl);
  if (state.provider === 'custom' && local) return escapeHtml(T('center.nowLocal', { s: local }));
  return escapeHtml(T('center.nowNone'));
}

// Батч 27: блок «Профили ключей» в секции «Ключ и модель».
// Батч 28: профиль = провайдер + список КЛЮЧЕЙ (label, enabled-индикатор,
// бейджи broken/asleep из runtime-снимка хоста) + стрелки вверх/вниз —
// порядок списка = порядок цикла failover. Кнопки шлют хосту команды
// keychainAdd/keychainRename/keychainDelete/keychainSetActive/keychainMove/
// keychainAddKey/keychainRenameKey/keychainDeleteKey/keychainToggleKey
// (нативные InputBox/QuickPick/модалки — логика в extension/keychain.ts).
// МИКРО-БАТЧ 28.1: тело блока (строки профилей/ключей) рендерится в try/catch:
// исключение НЕ обрывает остальной HTML и <script> — деградация до пустого
// списка + строка в Output хоста через onRenderIssue.
function keychainRowsHtml(T: (key: string, vars?: Record<string, string | number>) => string, state: SettingsState, inject?: { html: string; profileId: string }): string {
  const profiles = state.keychainProfiles ?? [];
  const activeId = state.keychainActiveId ?? '';
  const runtimeInfo = state.keychainRuntime ?? {};
  let placed = false;
  const rows = profiles.map((profile, index) => {
    const isActive = profile.id === activeId;
    const model = escapeHtml(profile.model?.trim() || '');
    const rowBaseUrl = escapeHtml(profile.baseUrl?.trim() || '');
    const keys = profile.keys ?? [];
    const pid = escapeHtml(profile.id);
    // МИКРО-БАТЧ 28.6: карточка в режиме правки получает kc-editing — её
    // рамка становится ЕДИНСТВЕННОЙ рамкой формы (у #kc-form своей рамки
    // больше нет), а отображаемые строки (baseUrl, ключи, кнопки действий)
    // скрываются CSS-правилом (.kc-editing > .kc-* { display: none }):
    // визуально их в карточке нет, но «Отмена» возвращает полный вид без
    // перерисовки хостом. Рамка ровно одна в любом режиме.
    const editingHere = Boolean(inject) && !placed && inject!.profileId === profile.id;
    if (editingHere) placed = true;
    const keyRows = keys.map((key) => {
      const kid = escapeHtml(key.id);
      const rt = runtimeInfo[`${profile.id}/${key.id}`];
      const badges = [
        key.enabled ? `<span class="kc-key-on">${icon('pass')} ${T('keychain.keyOn')}</span>` : `<span class="kc-key-off">${icon('circle-slash')} ${T('keychain.keyOff')}</span>`,
        // 28.9: «тариф» — стена биллинга; такой ключ НЕ спит и выведен из ротации.
        ...(rt?.billing ? [`<span class="kc-key-broken">${icon('credit-card')} ${T('keychain.badgeBilling')}</span>`] : []),
        ...(rt?.broken ? [`<span class="kc-key-broken">${icon('error')} ${T('keychain.badgeBroken')}</span>`] : []),
        ...(rt && rt.sleepSeconds > 0 ? [`<span class="kc-key-asleep">${icon('clock')} ${T('keychain.badgeAsleep', { s: rt.sleepSeconds })}</span>`] : [])
      ].join(' ');
      return `<div class="kc-key-row${key.enabled ? '' : ' kc-key-disabled'}">
        <span class="kc-key-line">${icon('key')} <strong>${escapeHtml(key.label)}</strong> ${badges}</span>
        <span class="kc-key-actions">
          <button type="button" class="secondary" data-kc="keychainToggleKey" data-id="${pid}" data-keyid="${kid}">${icon(key.enabled ? 'circle-slash' : 'pass')}<span>${T(key.enabled ? 'keychain.keyDisable' : 'keychain.keyEnable')}</span></button>
          <button type="button" class="secondary" data-kc="keychainRenameKey" data-id="${pid}" data-keyid="${kid}">${icon('edit')}<span>${T('keychain.rename')}</span></button>
          <button type="button" class="secondary" data-kc="keychainDeleteKey" data-id="${pid}" data-keyid="${kid}">${icon('trash')}<span>${T('keychain.delete')}</span></button>
        </span>
      </div>`;
    }).join('');
    const moveUp = index > 0 ? `<button type="button" class="secondary kc-move" title="${T('keychain.moveUp')}" data-kc="keychainMove" data-id="${pid}" data-dir="-1">${icon('arrow-up')}</button>` : '';
    const moveDown = index < profiles.length - 1 ? `<button type="button" class="secondary kc-move" title="${T('keychain.moveDown')}" data-kc="keychainMove" data-id="${pid}" data-dir="1">${icon('arrow-down')}</button>` : '';
    // МИКРО-БАТЧ 28.2: номер-бейдж = позиция в цикле failover (1 сверху);
    // data-* атрибуты строки питают предзаполнение инлайн-формы (клик
    // «Редактировать» — клиентский, без хоста).
    const orderBadge = `<span class="kc-order-badge" title="${T('keychain.cycleHint')}">${index + 1}</span>`;
    return `<div class="kc-row${isActive ? ' kc-active-row' : ''}${editingHere ? ' kc-editing' : ''}" data-profile-id="${pid}" data-provider="${escapeHtml(profile.provider)}" data-label="${escapeHtml(profile.label)}" data-model="${model}" data-baseurl="${rowBaseUrl}">
      <span class="kc-line">${orderBadge}${moveUp}${moveDown} ${icon('key')} <strong>${escapeHtml(profile.provider)}</strong> · ${escapeHtml(profile.label)}${model ? ` · ${model}` : ''}${isActive ? ` <span class="kc-active-badge">${icon('pass')} ${T('keychain.activeTag')}</span>` : ''}</span>
      <span class="kc-baseurl-row"><label>${T('keychain.baseUrlField')}</label><input class="kc-baseurl" data-id="${pid}" type="text" placeholder="https://api.example.com/v1" value="${rowBaseUrl}"><button type="button" class="secondary" data-kc="keychainBaseUrl" data-id="${pid}">${icon('save')}<span>${T('keychain.baseUrlSave')}</span></button></span>
      <div class="kc-keys">
        <div class="kc-keys-head">${icon('list-unordered')} <span>${T('keychain.keysTitle')}</span><button type="button" class="secondary" data-kc="keychainAddKey" data-id="${pid}">${icon('plus')}<span>${T('keychain.addKey')}</span></button></div>
        ${keyRows}
        <p class="hint">${T('keychain.keysHint')}</p>
      </div>
      <span class="kc-actions">
        <button type="button" class="secondary" data-kc="keychainSetActive" data-id="${pid}">${icon('target')}<span>${T('keychain.makeActive')}</span></button>
        <button type="button" class="secondary" data-kcf="edit" data-id="${pid}">${icon('edit')}<span>${T('keychain.edit')}</span></button>
        <button type="button" class="secondary" data-kc="keychainDelete" data-id="${pid}">${icon('trash')}<span>${T('keychain.delete')}</span></button>
      </span>
      <div class="kc-form-slot">${editingHere ? inject!.html : ''}</div>
    </div>`;
  }).join('');
  // МИКРО-БАТЧ 28.4: аккордеон — карточка «добавить профиль» в КОНЦЕ списка.
  // Обычно скрыта; становится видимой карточкой, когда в неё вселяется
  // открытая форма (draft нового профиля) или клиент переносит туда узел
  // #kcForm по клику «+ Добавить профиль». Рамка add-card (kc-row) =
  // единственная рамка формы: «строка профиля + поля» под одним border.
  const addCardForm = inject && !placed ? inject.html : '';
  const addCard = `<div class="kc-row kc-add-card${addCardForm ? '' : ' hidden'}" data-add-card="1"><div class="kc-form-slot">${addCardForm}</div></div>`;
  return profiles.length === 0
    ? `<p class="hint">${T('keychain.empty')}</p>${addCard}`
    : `<div class="kc-list">${rows}</div>${addCard}<p class="hint">${T('keychain.baseUrlHint')}</p><p class="hint kc-cycle-hint">${T('keychain.cycleHint')}</p>`;
}

// МИКРО-БАТЧ 28.2/28.4: инлайн-форма (карточка) профиля — АККОРДЕОН.
// Закрыта по умолчанию и живёт в нейтральном контейнере #kcFormHome;
// «Редактировать» у строки и «+ Добавить профиль» ПЕРЕНОСЯТ этот
// единственный узел в .kc-form-slot нужной карточки (клиент, без хоста) —
// поэтому одновременно открыта ровно одна форма, и она появляется там же,
// где нажали (плюс — фокус на первое поле). Хост рендерит форму внутри
// целевой карточки только при перерисовке после ошибки валидации (draft);
// для нового/уже удалённого профиля целевой становится add-card.
// Сохранение — кнопка «Сохранить профиль» (command keychainFormSave),
// отмена/Escape сворачивают без postMessage и без записи. «Подтянуть
// модели» шлёт keychainFormModels с ключом ИЗ ПОЛЯ формы (авто — дебаунс
// 600мс, 28.3) — секрет до «Сохранить» нигде не появляется.
// МИКРО-БАТЧ 28.4/28.9: поле модели — честный комбобокс (input + выпадающий
// список) ВМЕСТО datalist. 28.9: ФИЛЬТР ПРИМЕНЯЕТСЯ К ЛЮБОМУ ИЗМЕНЕНИЮ
// ЗНАЧЕНИЯ (keystroke/paste/drop/программная установка — событие input) и
// раскрытие (стрелка/фокус) ВСЕГДА показывает список, отфильтрованный по
// ТЕКУЩЕМУ значению; при пустом значении это весь список. Текущая помечена
// галочкой; ноль совпадений — «нет совпадений» + «впиши модель руками»;
// над списком счётчик «N моделей», при N=0 — подсказка; клавиши вниз/вверх —
// активная опция, Enter — выбор, Escape — закрыть СПИСОК (не
// форму). Ручной ввод произвольной модели остаётся возможным.
function keychainFormHtml(T: (key: string, vars?: Record<string, string | number>) => string, state: SettingsState): string {
  const draft = state.keychainFormDraft;
  const open = draft !== undefined;
  const editingId = (draft?.profileId ?? '').trim();
  const err = (state.keychainFormError ?? '').trim();
  // Микро-батч 28.5: заголовок отражает РЕЖИМ — «Редактирование: <label>»
  // редактируемого профиля (метка из draft, иначе из списка, иначе id),
  // «Новый профиль» — в режиме создания. Клиент переставляет заголовок и
  // иконку при showForm/hideForm (узел формы тот же, режим — нет).
  const editingLabel = editingId ? ((draft?.label ?? '').trim() || (state.keychainProfiles ?? []).find((profile) => profile.id === editingId)?.label || editingId) : '';
  const providerSelectOptions = `<option value="">${T('center.provider')}</option>` + providerValues
    .map((value) => `<option value="${value}"${value === draft?.provider ? ' selected' : ''}>${value}</option>`)
    .join('');
  return `<div id="kcForm" class="kc-form${open ? '' : ' hidden'}" data-editing="${escapeHtml(editingId)}">
  <h4><i id="kcFormTitleIcon" class="codicon codicon-${editingId ? 'edit' : 'plus'}" aria-hidden="true"></i> <span id="kcFormTitle">${escapeHtml(T(editingId ? 'keychain.formTitleEdit' : 'keychain.formTitleAdd', editingId ? { label: editingLabel } : undefined))}</span></h4>
  <label for="kcFormProvider">${T('keychain.formProvider')}</label>
  <select id="kcFormProvider">${providerSelectOptions}</select>
  <label for="kcFormKey">${T('keychain.formKey')}</label>
  <input id="kcFormKey" type="password" autocomplete="off" placeholder="${escapeHtml(editingId ? T('keychain.formKeyKeep') : T('center.keyPaste'))}">
  <p class="hint">${T('keychain.formKeyHint')}</p>
  <label for="kcFormModel">${T('keychain.formModel')}</label>
  <div class="kc-form-pull">
    <div class="kc-combo" id="kcFormModelCombo">
      <input id="kcFormModel" type="text" role="combobox" aria-expanded="false" aria-controls="kcFormModelDropdown" autocomplete="off" spellcheck="false" placeholder="${T('center.nowModelMissing')}" value="${escapeHtml((draft?.model ?? '').trim())}">
      <button id="kcFormModelArrow" type="button" class="kc-combo-arrow" tabindex="-1" aria-label="${T('keychain.comboToggle')}" title="${T('keychain.comboToggle')}">${icon('chevron-down')}</button>
      <div id="kcFormModelDropdown" class="kc-combo-list hidden" role="listbox" aria-label="${T('keychain.comboToggle')}">
        <p class="kc-combo-count hidden" id="kcFormModelsCount"></p>
        <div id="kcFormModelOptions"></div>
      </div>
    </div>
    <button id="kcFormPullModels" type="button" class="secondary">${icon('cloud-download')}<span>${T('keychain.formPullModels')}</span></button>
  </div>
  <p class="hint kc-form-models-status hidden" id="kcFormModelsStatus"></p>
  <p class="hint">${T('keychain.formModelHint')}</p>
  <label for="kcFormLabel">${T('keychain.formLabel')}</label>
  <input id="kcFormLabel" type="text" autocomplete="off" placeholder="${escapeHtml(T('keychain.formLabelHint'))}" value="${escapeHtml((draft?.label ?? '').trim())}">
  <label for="kcFormBaseUrl">${T('keychain.formBaseUrl')}</label>
  <input id="kcFormBaseUrl" type="text" autocomplete="off" spellcheck="false" placeholder="https://api.example.com/v1" value="${escapeHtml((draft?.baseUrl ?? '').trim())}">
  <p class="kc-form-error${err ? '' : ' hidden'}" id="kcFormError">${escapeHtml(err)}</p>
  <div class="row">
    <button id="kcFormSave" type="button">${icon('save')}<span>${T('keychain.formSave')}</span></button>
    <button id="kcFormCancel" type="button" class="secondary" data-kcf="cancel">${icon('close')}<span>${T('keychain.formCancel')}</span></button>
  </div>
</div>`;
}

function keychainBlockHtml(T: (key: string, vars?: Record<string, string | number>) => string, state: SettingsState, onRenderIssue?: (message: string) => void): string {
  const failoverOn = state.failoverEnabled === true;
  const draft = state.keychainFormDraft;
  const editingId = draft ? (draft.profileId ?? '').trim() : '';
  let listHtml = '';
  let formHtml = '';
  let homeHtml = '';
  try {
    // Микро-батч 28.4 (аккордеон): при открытом draft форма рендерится
    // ВНУТРИ целевой карточки (или add-card, если профиль удалён/новый);
    // в закрытом состоянии нейтральный дом узла #kcForm — контейнер-хаб,
    // в него клиент возвращает свёрнутую форму.
    formHtml = keychainFormHtml(T, state);
    listHtml = draft ? keychainRowsHtml(T, state, { html: formHtml, profileId: editingId }) : keychainRowsHtml(T, state);
    homeHtml = `<div id="kcFormHome" class="kc-form-home">${draft ? '' : formHtml}</div>`;
  } catch (error) {
    // Деградация: пустой список вместо оборванного HTML; причину — в Output хоста.
    const detail = error instanceof Error ? error.message : String(error);
    onRenderIssue?.(`блок профилей keychain деградировал до пустого списка: ${detail}`);
    listHtml = `<p class="hint">${escapeHtml(T('keychain.renderDegraded'))}</p>`;
    homeHtml = '<div id="kcFormHome" class="kc-form-home"></div>';
  }
  return `<div id="kcBlock" class="kc-block">
  <h3>${icon('clippy')} ${T('keychain.title')}</h3>
  ${listHtml}
  ${homeHtml}
  <div class="row">
    <button id="keychainAdd" type="button" class="secondary">${icon('plus')}<span>${T('keychain.add')}</span></button>
  </div>
  <label class="checkbox"><input id="failoverEnabled" type="checkbox"${failoverOn ? ' checked' : ''}> <span>${T('keychain.failoverEnabled')}</span></label>
  <label for="failoverMaxCycles">${T('keychain.failoverMaxCycles')}</label>
  <input id="failoverMaxCycles" type="number" min="0" max="100" step="1" value="${state.failoverMaxCycles ?? 0}">
  <p class="hint">${T('keychain.failoverHint')}</p>
</div>`;
}

export function mergeScopeGlobs(existing: string, added: string[]): string {
  return [...new Set([...splitScopeGlobs(existing), ...added.map((glob) => glob.trim()).filter(Boolean)])].join(', ');
}

export function buildSettingsHtml(state: SettingsState, statusMessage = '', statusKind: 'ok' | 'error' | 'retry' = 'ok', nonce = '', anchor = '', assets?: SettingsAssets, lang: Lang = 'ru', onRenderIssue?: (message: string) => void): string {
  const T = (key: string, vars?: Record<string, string | number>) => t(key, lang, vars);
  const scriptSrc = nonce ? `'nonce-${nonce}'` : "'unsafe-inline'";
  const styleSrc = nonce ? `'nonce-${nonce}'` : "'unsafe-inline'";
  const csp = assets
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${assets.cspSource}; img-src data:; style-src ${styleSrc} ${assets.cspSource}; script-src ${scriptSrc};">`
    : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${styleSrc}; script-src ${scriptSrc};">`;
  const codiconLink = assets ? `<link rel="stylesheet" href="${assets.codiconCss}">` : '';
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const providerOptions = providerValues
    .map((value) => `<option value="${value}"${value === state.provider ? ' selected' : ''}>${value}</option>`)
    .join('');
  // Батч 22.2, п.3: непустой глобальный Base URL при выбранном НЕ-custom
  // провайдере игнорируется (скоуп оверрайда — custom/local) — предупреждаем.
  const baseUrlTrimmed = (state.baseUrl ?? '').trim();
  const baseUrlIgnored = state.provider !== 'custom' && baseUrlTrimmed !== '' && !LOCAL_BASE_URL_RE.test(baseUrlTrimmed);
  const prefs: UiPrefs = { theme: state.uiTheme, accent: state.accentColor, density: state.uiDensity, fontSize: state.uiFontSize, showConfidence: state.showConfidence, findingsSort: state.findingsSort, reportTheme: state.reportTheme, customColors: normalizeCustomColors(state.customColors) };
  const cc = prefs.customColors;
  // Точка расширения: новый язык = добавить словарь src/i18n/<lang>.json
  // (ключи 1:1), <option value="<lang>"> в селект ниже и значение в enum
  // codescout.language манифеста. Больше нигде ветвить не нужно — весь UI
  // идёт через t(key, lang), а глобус в шапке панели дёргает тот же настройку.
  const languageSection = `
<section id="sec-lang">
  <h2>${icon('globe')} ${T('sec.lang')}</h2>
  <label for="reportLanguage">${T('lang.select')}</label>
  <select id="reportLanguage">
    <option value="ru"${state.reportLanguage === 'ru' ? ' selected' : ''}>${T('appear.langRu')}</option>
    <option value="en"${state.reportLanguage === 'en' ? ' selected' : ''}>${T('appear.langEn')}</option>
  </select>
  <p class="hint">${T('lang.hint')}</p>
</section>`;
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
.conn-hint { font-size: var(--cs-font-1); opacity: 0.85; margin-top: 3px; color: var(--cs-desc); }
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
.key-secure { display: flex; align-items: center; gap: var(--cs-space-1); margin-top: 4px; color: var(--cs-pass); font-size: var(--cs-font-1); }
.dev-link { color: var(--cs-accent); text-decoration: underline; cursor: pointer; overflow-wrap: anywhere; }
.key-secure .codicon { color: var(--cs-pass); }
.kc-block { margin-top: var(--cs-space-3); padding-top: var(--cs-space-2); border-top: 1px solid var(--cs-card-border); }
.kc-block h3 { margin: 0 0 var(--cs-space-2); font-size: var(--cs-font-2); text-transform: none; color: var(--cs-fg); display: flex; align-items: center; gap: var(--cs-space-2); }
.kc-list { display: flex; flex-direction: column; gap: 4px; }
.kc-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--cs-space-2); padding: 4px var(--cs-space-2); border: 1px solid var(--cs-card-border); border-radius: var(--cs-radius-1); background: color-mix(in srgb, var(--cs-accent) 4%, transparent); }
.kc-active-row { border-color: var(--cs-accent); }
.kc-line { display: inline-flex; align-items: center; gap: 5px; font-size: var(--cs-font-2); font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
.kc-active-badge { color: var(--cs-pass); font-family: var(--vscode-font-family); font-size: var(--cs-font-1); display: inline-flex; align-items: center; gap: 3px; }
.kc-actions { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.kc-actions button { width: auto; padding: 2px var(--cs-space-2); font-size: var(--cs-font-1); min-height: auto; }
.kc-baseurl-row { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; flex: 1 1 100%; }
.kc-baseurl-row label { font-size: var(--cs-font-1); color: var(--cs-desc); }
.kc-baseurl-row input { flex: 1 1 180px; min-width: 0; font-family: var(--vscode-editor-font-family); }
.kc-baseurl-row button { width: auto; padding: 2px var(--cs-space-2); font-size: var(--cs-font-1); min-height: auto; }
.kc-keys { flex: 1 1 100%; display: flex; flex-direction: column; gap: 2px; margin: 4px 0; padding-left: var(--cs-space-2); border-left: 2px solid var(--cs-card-border); }
.kc-keys-head { display: flex; align-items: center; gap: 5px; font-size: var(--cs-font-1); color: var(--cs-desc); margin-bottom: 2px; }
.kc-keys-head button { width: auto; margin-left: auto; padding: 2px var(--cs-space-2); font-size: var(--cs-font-1); min-height: auto; }
.kc-key-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--cs-space-2); padding: 2px var(--cs-space-2); border-radius: var(--cs-radius-1); }
.kc-key-disabled { opacity: 0.6; }
.kc-key-line { display: inline-flex; align-items: center; gap: 5px; font-size: var(--cs-font-2); font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
.kc-key-on, .kc-key-off, .kc-key-broken, .kc-key-asleep { display: inline-flex; align-items: center; gap: 3px; font-size: var(--cs-font-1); font-family: var(--vscode-font-family); }
.kc-key-on { color: var(--cs-pass); }
.kc-key-off { color: var(--cs-desc); }
.kc-key-broken { color: var(--cs-error); }
.kc-key-asleep { color: var(--cs-warn); }
.kc-key-actions { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.kc-key-actions button { width: auto; padding: 2px var(--cs-space-2); font-size: var(--cs-font-1); min-height: auto; }
.kc-move { width: auto; padding: 2px 6px; min-height: auto; }
.kc-order-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--cs-accent); color: var(--cs-editor-bg); font-size: var(--cs-font-1); font-weight: 700; flex: 0 0 auto; }
/* Batch 28.6: the form has NO frame of its own — it renders INSIDE the
   profile card's frame (same border/background). .kc-editing on the card =
   editing mode: the displayed rows (baseUrl, keys, action buttons) are not
   shown, the accent border moves onto the card. Exactly ONE border per card
   in any mode. Keep this CSS Cyrillic-free (EN render contract). */
.kc-form { margin-top: var(--cs-space-1); }
.kc-row.kc-editing { border-color: var(--cs-accent); }
.kc-row.kc-editing > .kc-baseurl-row, .kc-row.kc-editing > .kc-keys, .kc-row.kc-editing > .kc-actions { display: none; }
.kc-form h4 { display: flex; align-items: center; gap: var(--cs-space-2); margin: 0 0 var(--cs-space-1); font-size: var(--cs-font-2); color: var(--cs-accent); }
.kc-form label { margin: 10px 0 var(--cs-space-1); }
.kc-form-pull { display: flex; align-items: center; gap: var(--cs-space-2); }
.kc-form-pull input { flex: 1 1 auto; min-width: 0; }
.kc-form-pull button { width: auto; flex: 0 0 auto; }
.kc-form-error { color: var(--cs-error); background: color-mix(in srgb, var(--cs-error) 12%, transparent); border-radius: var(--cs-radius-1); padding: var(--cs-space-1) var(--cs-space-2); font-size: var(--cs-font-1); margin: var(--cs-space-2) 0 0; }
.kc-form-models-status { margin: var(--cs-space-1) 0 0; }
.kc-form-models-status.is-error { color: var(--cs-error); }
.kc-form-slot { flex: 1 1 100%; min-width: 0; }
.kc-combo { position: relative; flex: 1 1 auto; min-width: 0; }
.kc-combo > input { width: 100%; padding-right: 30px; }
.kc-combo-arrow { position: absolute; top: 3px; right: 3px; bottom: 3px; width: 24px; min-height: 0; padding: 0; border: none; background: transparent; color: var(--cs-desc); display: inline-flex; align-items: center; justify-content: center; z-index: 2; }
.kc-combo-arrow:hover { background: var(--cs-list-hover); color: var(--cs-fg); }
.kc-combo-list { position: absolute; z-index: 40; top: calc(100% + 3px); left: 0; right: 0; max-height: 180px; overflow-y: auto; padding: 2px; border: 1px solid var(--cs-input-border); border-radius: var(--cs-radius-1); background: var(--cs-input-bg); box-shadow: var(--cs-shadow); }
.kc-combo-count { position: sticky; top: 0; margin: 0; padding: 2px var(--cs-space-2); background: var(--cs-input-bg); color: var(--cs-desc); font-size: var(--cs-font-1); }
.kc-combo-opt { display: flex; align-items: center; gap: 5px; padding: 3px var(--cs-space-2); border-radius: var(--cs-radius-1); color: var(--cs-input-fg); font-family: var(--vscode-editor-font-family); font-size: var(--cs-font-2); cursor: pointer; }
.kc-combo-opt:hover, .kc-combo-opt.active { background: var(--cs-list-hover); }
.kc-combo-opt .kc-combo-check { visibility: hidden; display: inline-flex; color: var(--cs-pass); }
.kc-combo-opt.is-current .kc-combo-check { visibility: visible; }
.kc-combo-empty { margin: 0; padding: 4px var(--cs-space-2); color: var(--cs-desc); font-size: var(--cs-font-1); }
</style>
</head>
<body data-anchor="${escapeHtml(anchor)}" ${uiBodyAttrs(prefs)}>
<div class="brand"><span class="brand-mark">${icon('search')}</span> ${T('title.center')}</div>
<div class="layout">
<nav class="sidebar" id="sidebar">
  <a class="nav-link active" href="#sec-key" data-target="sec-key">${icon('key')}<span>${T('sec.key')}</span></a>
  <a class="nav-link" href="#sec-lang" data-target="sec-lang">${icon('globe')}<span>${T('sec.lang')}</span></a>
  <a class="nav-link" href="#sec-audit" data-target="sec-audit">${icon('sync')}<span>${T('sec.audit')}</span></a>
  <a class="nav-link" href="#sec-project" data-target="sec-project">${icon('folder')}<span>${T('sec.project')}</span></a>
  <a class="nav-link" href="#sec-appearance" data-target="sec-appearance">${icon('symbol-color')}<span>${T('sec.appearance')}</span></a>
  <a class="nav-link" href="#sec-about" data-target="sec-about">${icon('info')}<span>${T('sec.about')}</span></a>
  <a class="nav-link" href="#sec-dev" data-target="sec-dev">${icon('account')}<span>${T('sec.dev')}</span></a>
</nav>
<div class="content">
<div class="status${statusKind === 'error' ? ' error' : ''}" id="status">${escapeHtml(statusMessage)}</div>
<main>
<section id="sec-key">
  <h2>${icon('key')} ${T('sec.key')}</h2>
  <label for="provider">${T('center.provider')}</label>
  <select id="provider">${providerOptions}</select>
  <label for="apiKey">${T('center.apiKeyLabel')}</label>
  <input id="apiKey" type="password" autocomplete="off" placeholder="${state.keyConfigured ? T('center.keyKeep') : (state.provider === 'custom' && state.baseUrl && state.baseUrl.startsWith('http://localhost') ? T('center.keyLocalHint') : T('center.keyPaste'))}">
  <label class="checkbox"><input id="revealKey" type="checkbox"> ${T('center.reveal')}</label>
  <div id="baseUrlRow" class="${state.provider === 'custom' ? '' : 'hidden'}">
    <label for="baseUrl">${T('center.baseUrl')}</label>
    <input id="baseUrl" type="text" autocomplete="off" placeholder="http://localhost:11434/v1" value="${escapeHtml(state.baseUrl)}">
    <p class="hint">${T('center.baseUrlHint')}</p>
  </div>
  <p class="scope-warn${baseUrlIgnored ? '' : ' hidden'}" id="baseUrlIgnoredWarn">${icon('warning')} ${T('center.baseUrlIgnored')}</p>
  <div class="current-key">${T('center.now')} ${currentKeyLine(T, state)}</div>
  ${state.keyConfigured ? `<div class="key-secure">${icon('lock')}<span>${T('center.secureNote')}</span></div>` : ''}
  <div class="row">
    <button id="chooseModel" type="button" class="secondary">${icon('cloud-download')}<span>${T('center.liveModels')}</span></button>
    <button id="testConnection" type="button" class="secondary">${icon('sync')}<span>${T('center.retry')}</span></button>
    <button id="clearKey" type="button" class="secondary">${icon('trash')}<span>${T('center.forgetKey')}</span></button>
  </div>
  ${keychainBlockHtml(T, state, onRenderIssue)}
</section>${languageSection}
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
  <label for="requestTimeoutSeconds">${T('audit.requestTimeout')}</label>
  <input id="requestTimeoutSeconds" type="number" min="10" max="600" step="1" value="${state.requestTimeoutSeconds ?? 60}">
  <p class="hint">${T('audit.requestTimeoutHint')}</p>
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
    <button id="refreshContext" type="button" class="secondary">${icon('refresh')}<span>${T('project.refreshContext')}</span></button>
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
    <button id="reportIssue" type="button" class="secondary">${icon('report')}<span>${T('about.issue')}</span></button>
  </div>
</section>
<section id="sec-dev">
  <h2>${icon('account')} ${T('sec.dev')}</h2>
  <div class="about-line">${T('about.devAuthor')} <strong>${T('about.devName')}</strong></div>
  <div class="about-line">${T('about.devContact')} <a class="dev-link" href="#" data-action="mailto">work.valden@gmail.com</a></div>
  <div class="about-line">${T('about.devGithub')} <a class="dev-link" href="${REPO_URL}" data-url="${REPO_URL}">valden2007/CodeScout</a> — ${T('about.devIssues')}</div>
  <div class="about-line">${T('about.devCard')} <span class="scope-chip"><span>${T('about.devSiteWip')}</span></span></div>
  <p class="hint">${T('about.devCall')}</p>
</section>
</main>
</div>
</div>
<div class="savebar">
  <button id="saveAll" type="button" disabled><span class="dirty-dot"></span>${icon('save')}<span>${T('save.save')}</span></button>
  <span class="dirty" id="dirtyHint">${T('save.clean')}</span>
</div>
<script${nonceAttr}>
// Batch 28.1: the WHOLE init is wrapped in try/catch — a throw anywhere must
// not silently kill every other listener. Failures go to the webview console
// (DevTools) and to the data-cs-ready marker. Keep this script Cyrillic-free.
try {
const vscode = acquireVsCodeApi();
// Batch 28.3 FIX (raw i18n key): the UI map MUST contain every key the L()
// helper below pulls at runtime — 'keychain.formSave' was missing, so the
// client-opened form showed the raw key on the Save button. A contract test
// now diffs all L('…') call sites against this whitelist.
const UI = ${JSON.stringify(['save.save', 'save.saving', 'save.clean', 'save.dirty', 'chip.removeTip', 'form.pickOutside', 'form.pickNoWorkspace', 'center.connecting', 'center.retry', 'center.liveModels', 'models.loading', 'keychain.formKeyKeep', 'center.keyPaste', 'keychain.formErrProvider', 'keychain.formErrKey', 'keychain.formPullModels', 'keychain.formSave', 'keychain.formModelsLoading', 'keychain.formModelsCount', 'keychain.comboEmptyHint', 'keychain.comboNoMatches', 'keychain.comboManual', 'keychain.formTitleEdit', 'keychain.formTitleAdd'].reduce((acc, k) => { acc[k] = T(k); return acc; }, {} as Record<string, string>))};
function L(key) { return UI[key] || key; }
const providerSelect = document.getElementById('provider');
const baseUrlRow = document.getElementById('baseUrlRow');
const baseUrlInput = document.getElementById('baseUrl');
const baseUrlIgnoredWarn = document.getElementById('baseUrlIgnoredWarn');
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
const requestTimeoutInput = document.getElementById('requestTimeoutSeconds');
const failoverEnabledBox = document.getElementById('failoverEnabled');
const failoverMaxCyclesInput = document.getElementById('failoverMaxCycles');
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
    autoResumeMaxAttempts: autoResumeMaxAttemptsInput.value, autoResumeMaxMinutes: autoResumeMaxMinutesInput.value, rateLimitPauses: rateLimitPausesInput.value,
    requestTimeoutSeconds: requestTimeoutInput.value,
    failoverEnabled: failoverEnabledBox ? failoverEnabledBox.checked : false,
    failoverMaxCycles: failoverMaxCyclesInput ? failoverMaxCyclesInput.value : '0'
  });
}
let initial = snapshot();
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min) return String(Math.min(max, Math.max(min, Number(fallback))));
  return String(Math.min(max, Math.max(min, n)));
}
function isLocalOverride(value) {
  try { const u = new URL(value); return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'); } catch (e) { return false; }
}
function toggleBaseUrl() {
  const custom = providerSelect.value === 'custom';
  baseUrlRow.classList.toggle('hidden', !custom);
  // Batch 22.2 p.3: the global Base URL only takes effect for custom/local
  // mode. For every other provider it is ignored — say it in plain text.
  if (baseUrlIgnoredWarn) {
    const value = baseUrlInput.value.trim();
    baseUrlIgnoredWarn.classList.toggle('hidden', custom || value === '' || isLocalOverride(value));
  }
}
providerSelect.addEventListener('change', toggleBaseUrl);
baseUrlInput.addEventListener('input', toggleBaseUrl);
function refreshDirty() {
  const dirty = snapshot() !== initial;
  saveAllBtn.disabled = !dirty;
  saveAllBtn.classList.toggle('is-dirty', dirty);
  dirtyHint.textContent = dirty ? L('save.dirty') : L('save.clean');
}
document.querySelectorAll('input, select, textarea').forEach((el) => {
  // Batch 28.2: the profile card has its own Save button — its fields must
  // not drive the global settings save bar.
  if (el.closest('#kcForm')) return;
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
    rateLimitPauses: Number(clampInt(rateLimitPausesInput.value, 0, 5, '3')),
    requestTimeoutSeconds: Number(clampInt(requestTimeoutInput.value, 10, 600, '60')),
    failoverEnabled: failoverEnabledBox ? failoverEnabledBox.checked : false,
    failoverMaxCycles: Number(clampInt(failoverMaxCyclesInput ? failoverMaxCyclesInput.value : '0', 0, 100, '0'))
  });
});
document.getElementById('chooseModel').addEventListener('click', () => vscode.postMessage({ command: 'chooseModel' }));
// Batch 28.4: the «Add profile» button opens the same form as a NEW card at
// the end of the list (the trailing add-card) — and scrollIntoView to it is
// the only allowed scroll in this flow.
const keychainAddBtn = document.getElementById('keychainAdd');
if (keychainAddBtn) keychainAddBtn.addEventListener('click', () => showForm({}, { scroll: true }));
// Batch 27: keychain row buttons are delegated — each posts its command + profile id.
// Batch 27.1: keychainBaseUrl additionally carries the row's input value.
// Batch 28: key-level buttons carry data-keyid, move arrows carry data-dir.
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const btn = target ? target.closest('[data-kc]') : null;
  if (!btn) return;
  const command = btn.getAttribute('data-kc');
  const id = btn.getAttribute('data-id');
  if (!command || !id) return;
  if (command === 'keychainBaseUrl') {
    const row = btn.closest('.kc-row');
    const input = row ? row.querySelector('.kc-baseurl') : null;
    vscode.postMessage({ command, id, baseUrl: input ? String(input.value) : '' });
    return;
  }
  const keyId = btn.getAttribute('data-keyid');
  const dir = btn.getAttribute('data-dir');
  // Batch 28.1 REGRESSION FIX: no TypeScript annotations inside this string —
  // the webview parses raw JS, and a type annotation threw SyntaxError that
  // killed EVERY listener (all settings buttons dead). Keep plain JS only.
  const payload = { command: command, id: id };
  if (keyId) payload.keyId = keyId;
  if (dir) payload.dir = Number(dir);
  vscode.postMessage(payload);
});
// ── Batch 28.2: inline profile form (card) ──────────────────────────────────
// Plain JS only inside the template literal (TS annotations kill the script).
// Open/close/prefill/Escape are CLIENT-side; only Save (keychainFormSave) and
// Pull models (keychainFormModels) reach the host. The API key value lives in
// the DOM field and the posted message only — NEVER in vscode.getState(), so a
// re-render clears it. Host re-renders the form open ONLY to show a validation
// error inside the card with the draft values back in the fields.
const kcForm = document.getElementById('kcForm');
const kcFormError = document.getElementById('kcFormError');
const kcFormProvider = document.getElementById('kcFormProvider');
const kcFormKeyInput = document.getElementById('kcFormKey');
const kcFormModelInput = document.getElementById('kcFormModel');
const kcFormPullBtn = document.getElementById('kcFormPullModels');
const kcFormLabelInput = document.getElementById('kcFormLabel');
const kcFormBaseUrlInput = document.getElementById('kcFormBaseUrl');
const kcFormSaveBtn = document.getElementById('kcFormSave');
// Batch 28.4: combobox parts (the old datalist sibling #kcFormModelList is
// gone) + accordion mount points: the neutral hub #kcFormHome and the
// trailing add-card. #kcForm is ONE node moved into the target card's
// .kc-form-slot — that is why exactly one form can be open at any moment.
const kcFormModelCombo = document.getElementById('kcFormModelCombo');
const kcFormModelDropdown = document.getElementById('kcFormModelDropdown');
const kcFormModelArrow = document.getElementById('kcFormModelArrow');
const kcFormModelsCountEl = document.getElementById('kcFormModelsCount');
const kcFormModelOptions = document.getElementById('kcFormModelOptions');
const kcFormHome = document.getElementById('kcFormHome');
const kcAddCard = document.querySelector('[data-add-card]');
let formEditing = '';
// Batch 28.3: live models in the form. After the key was pasted or the
// provider changed we wait 600 ms (debounce) and post keychainFormModels
// with the key FROM THE FIELD; the «Pull models» button stays a manual
// instant trigger. Stale answers (requestId) are dropped, the status line
// shows loading → "N models" counter or the category hint (401/404/net);
// the model can always be typed by hand.
const kcFormModelsStatus = document.getElementById('kcFormModelsStatus');
let formPullTimer = 0;
let formPullSeq = 0;
// Batch 28.4: pulled model ids (non-secret — safe for vscode.getState) and the
// highlighted option index. Batch 28.9: NO "unfiltered open" mode anymore —
// every render (typing, paste, programmatic set, opening) filters by the
// current input value; empty value keeps the full list.
let formModelsList = [];
let comboActive = -1;
function setFormModelsStatus(text, isError) {
  if (!kcFormModelsStatus) return;
  kcFormModelsStatus.textContent = text || '';
  kcFormModelsStatus.classList.toggle('is-error', Boolean(isError));
  kcFormModelsStatus.classList.toggle('hidden', !text);
}
function clearFormPullTimer() { if (formPullTimer) { clearTimeout(formPullTimer); formPullTimer = 0; } }
function requestFormModels() {
  if (!kcFormProvider || !kcFormKeyInput) return;
  clearFormPullTimer();
  formPullSeq += 1;
  setFormPullBusy(true);
  setFormModelsStatus(L('keychain.formModelsLoading'), false);
  vscode.postMessage({
    command: 'keychainFormModels',
    requestId: formPullSeq,
    provider: kcFormProvider.value,
    apiKey: kcFormKeyInput.value.trim() || undefined,
    profileId: formEditing || undefined,
    baseUrl: kcFormBaseUrlInput ? kcFormBaseUrlInput.value.trim() : ''
  });
}
function scheduleFormPull() {
  clearFormPullTimer();
  if (!formVisible() || !kcFormProvider || !kcFormKeyInput) return;
  if (!kcFormProvider.value || !kcFormKeyInput.value.trim()) return;
  formPullTimer = setTimeout(() => { formPullTimer = 0; requestFormModels(); }, 600);
}
function readFormState() { try { const s = vscode.getState(); return (s && s.csProfileForm) || null; } catch (e) { return null; } }
function writeFormState(value) { try { const s = vscode.getState() || {}; s.csProfileForm = value; vscode.setState(s); } catch (e) { /* state unsupported */ } }
function formVisible() { return Boolean(kcForm) && !kcForm.classList.contains('hidden'); }
function setFormError(msg) { if (!kcFormError) return; kcFormError.textContent = msg || ''; kcFormError.classList.toggle('hidden', !msg); }
function setFormPullBusy(busy) { if (!kcFormPullBtn) return; kcFormPullBtn.disabled = busy; const label = kcFormPullBtn.querySelector('span:last-child'); if (label) label.textContent = busy ? L('models.loading') : L('keychain.formPullModels'); }
function persistForm() {
  if (!kcForm || !formVisible()) return;
  // models = non-secret pulled list (28.4); the API KEY never enters state.
  writeFormState({ editing: formEditing, provider: kcFormProvider.value, model: kcFormModelInput.value, label: kcFormLabelInput.value, baseUrl: kcFormBaseUrlInput.value, models: formModelsList });
}
// ── Batch 28.4/28.9: model combobox core. Pure functions below the markers
// are extracted and unit-tested as-is (tests/batch28-4, batch28-9). 28.9:
// opening ALWAYS applies the current filter (comboFilter), so no
// unfiltered-open helper remains. Plain JS only.
/* cs-combo-core:start */
function comboFilter(models, query) {
  const list = Array.isArray(models) ? models.slice() : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter(function (m) { return String(m).toLowerCase().indexOf(q) !== -1; });
}
function comboIsCurrent(model, current) { return String(model || '') === String(current || ''); }
/* cs-combo-core:end */
function comboOpen() { return Boolean(kcFormModelDropdown) && !kcFormModelDropdown.classList.contains('hidden'); }
function setComboExpanded(open) { if (kcFormModelInput) kcFormModelInput.setAttribute('aria-expanded', open ? 'true' : 'false'); }
function comboItems() { return comboFilter(formModelsList, kcFormModelInput ? kcFormModelInput.value : ''); }
function comboOptEls() { return kcFormModelOptions ? Array.prototype.slice.call(kcFormModelOptions.querySelectorAll('.kc-combo-opt')) : []; }
function renderCombo() {
  if (!kcFormModelOptions || !kcFormModelDropdown) return;
  const items = comboItems();
  if (kcFormModelsCountEl) {
    if (formModelsList.length) { kcFormModelsCountEl.textContent = L('keychain.formModelsCount').replace('{n}', String(formModelsList.length)); kcFormModelsCountEl.classList.remove('hidden'); }
    else { kcFormModelsCountEl.textContent = ''; kcFormModelsCountEl.classList.add('hidden'); }
  }
  kcFormModelOptions.textContent = '';
  const current = kcFormModelInput ? kcFormModelInput.value : '';
  items.forEach(function (model, i) {
    const opt = document.createElement('div');
    opt.className = 'kc-combo-opt' + (i === comboActive ? ' active' : '') + (comboIsCurrent(model, current) ? ' is-current' : '');
    opt.setAttribute('role', 'option');
    opt.setAttribute('data-model', String(model));
    const check = document.createElement('span');
    check.className = 'kc-combo-check';
    check.innerHTML = '<i class="codicon codicon-check" aria-hidden="true"></i>';
    const name = document.createElement('span');
    name.textContent = String(model);
    opt.appendChild(check);
    opt.appendChild(name);
    kcFormModelOptions.appendChild(opt);
  });
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'kc-combo-empty';
    // N=0 pulled → «press Pull models» hint; typing-no-match → «no matches»
    // plus «type the model manually» (28.9: the filter never blocks manual input).
    empty.textContent = formModelsList.length ? L('keychain.comboNoMatches') + ' — ' + L('keychain.comboManual') : L('keychain.comboEmptyHint');
    kcFormModelOptions.appendChild(empty);
  }
}
function openCombo() {
  if (!kcFormModelDropdown) return;
  comboActive = -1;
  renderCombo();
  kcFormModelDropdown.classList.remove('hidden');
  setComboExpanded(true);
}
function refreshComboTyped() {
  comboActive = -1;
  renderCombo();
  if (!kcFormModelDropdown || !comboOpen()) {
    if (kcFormModelDropdown) kcFormModelDropdown.classList.remove('hidden');
    setComboExpanded(true);
  }
}
function closeCombo() {
  if (!kcFormModelDropdown) return;
  kcFormModelDropdown.classList.add('hidden');
  comboActive = -1;
  setComboExpanded(false);
}
function moveComboActive(delta) {
  const opts = comboOptEls();
  if (!opts.length) return;
  comboActive = delta > 0 ? (comboActive + 1) % opts.length : (comboActive <= 0 ? opts.length - 1 : comboActive - 1);
  opts.forEach(function (el, i) { el.classList.toggle('active', i === comboActive); });
  try { opts[comboActive].scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
}
function pickComboOption(model) {
  if (kcFormModelInput) kcFormModelInput.value = model;
  closeCombo();
  persistForm();
}
// Batch 28.5: the SAME #kcForm node serves create AND edit, so the header
// must follow the mode on the client: «Editing: <label>» with the edit icon
// in edit mode, «New profile» with the plus icon in create mode.
function setFormTitle(editing, label) {
  const title = document.getElementById('kcFormTitle');
  const ic = document.getElementById('kcFormTitleIcon');
  if (ic) ic.className = 'codicon codicon-' + (editing ? 'edit' : 'plus');
  if (!title) return;
  if (editing) title.textContent = L('keychain.formTitleEdit').replace('{label}', String(label || editing));
  else title.textContent = L('keychain.formTitleAdd');
}
// Batch 28.4 accordion: mount the single #kcForm node into the target card's
// slot; unknown/empty id → the trailing add-card (visible when mounted).
// Batch 28.6: the mounted card gets .kc-editing — its border becomes the ONE
// frame of the editing card (the form has no border of its own). The displayed
// rows (keys, actions, baseUrl) are physically REMOVED from the card while
// editing (contract: an editing card has no displayed key rows in the DOM)
// and restored untouched on cancel/Escape/save — a full host re-render is not
// needed to bring the card back to view mode.
const hiddenRows = new Map();
function cardRows(card) {
  const nodes = [];
  const kids = card.children;
  for (let i = 0; i < kids.length; i += 1) {
    const el = kids[i];
    if (el.matches && el.matches('.kc-baseurl-row, .kc-keys, .kc-actions')) nodes.push(el);
  }
  return nodes;
}
function hideCardRows(card) {
  if (!card || hiddenRows.has(card)) return;
  const nodes = cardRows(card);
  if (!nodes.length) return;
  hiddenRows.set(card, nodes);
  nodes.forEach(function (el) { el.parentNode.removeChild(el); });
}
function restoreCardRows(card) {
  const nodes = hiddenRows.get(card);
  if (!nodes) return;
  hiddenRows.delete(card);
  const slot = card.querySelector('.kc-form-slot');
  nodes.forEach(function (el) { if (slot) card.insertBefore(el, slot); else card.appendChild(el); });
}
function clearEditingCards() {
  document.querySelectorAll('.kc-row.kc-editing').forEach(function (el) { el.classList.remove('kc-editing'); restoreCardRows(el); });
}
function mountFormFor(id) {
  if (!kcForm) return;
  clearEditingCards();
  let slot = null;
  let card = null;
  if (id) {
    const rows = Array.prototype.slice.call(document.querySelectorAll('.kc-row[data-profile-id]'));
    for (const row of rows) {
      if ((row.getAttribute('data-profile-id') || '') === id) { slot = row.querySelector('.kc-form-slot'); card = row; break; }
    }
  }
  if (!slot && kcAddCard) {
    slot = kcAddCard.querySelector('.kc-form-slot');
    card = kcAddCard;
    if (slot) kcAddCard.classList.remove('hidden');
  }
  if (slot) {
    slot.appendChild(kcForm);
    if (card) { card.classList.add('kc-editing'); hideCardRows(card); }
  }
}
function showForm(values, opts) {
  if (!kcForm) return;
  const d = values || {};
  const o = opts || {};
  clearFormPullTimer();
  closeCombo();
  setFormModelsStatus('', false);
  formEditing = d.id ? String(d.id) : (d.editing ? String(d.editing) : '');
  kcForm.setAttribute('data-editing', formEditing);
  formModelsList = Array.isArray(d.models) ? d.models.map(String) : [];
  mountFormFor(formEditing);
  setFormTitle(formEditing, d.label || '');
  kcForm.classList.remove('hidden');
  if (kcFormProvider) kcFormProvider.value = d.provider || '';
  if (kcFormModelInput) kcFormModelInput.value = d.model || '';
  if (kcFormLabelInput) kcFormLabelInput.value = d.label || '';
  if (kcFormBaseUrlInput) kcFormBaseUrlInput.value = d.baseUrl || '';
  if (kcFormKeyInput) { kcFormKeyInput.value = ''; kcFormKeyInput.placeholder = formEditing ? L('keychain.formKeyKeep') : L('center.keyPaste'); }
  if (kcFormSaveBtn) { kcFormSaveBtn.disabled = false; const span = kcFormSaveBtn.querySelector('span:last-child'); if (span) span.textContent = L('keychain.formSave'); }
  setFormPullBusy(false);
  setFormError('');
  // Batch 28.4: the ONLY allowed scroll is toward the newly added card;
  // focus lands on the first field without moving the viewport (no jump).
  if (o.scroll) { try { kcForm.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { try { kcForm.scrollIntoView(); } catch (e2) { /* ignore */ } } }
  if (kcFormProvider) { try { kcFormProvider.focus({ preventScroll: true }); } catch (e) { try { kcFormProvider.focus(); } catch (e2) { /* ignore */ } } }
  persistForm();
}
function hideForm() {
  if (!kcForm) return;
  clearFormPullTimer();
  closeCombo();
  kcForm.classList.add('hidden');
  kcForm.setAttribute('data-editing', '');
  formEditing = '';
  formModelsList = [];
  setFormTitle('', '');
  clearEditingCards();
  if (kcFormHome) kcFormHome.appendChild(kcForm);
  if (kcAddCard) kcAddCard.classList.add('hidden');
  writeFormState(null);
}
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const el = target ? target.closest('[data-kcf]') : null;
  if (!el) return;
  event.preventDefault();
  if (el.getAttribute('data-kcf') === 'edit') {
    const row = el.closest('.kc-row');
    showForm(row ? {
      id: row.getAttribute('data-profile-id') || el.getAttribute('data-id') || '',
      provider: row.getAttribute('data-provider') || '',
      label: row.getAttribute('data-label') || '',
      model: row.getAttribute('data-model') || '',
      baseUrl: row.getAttribute('data-baseurl') || ''
    } : { id: el.getAttribute('data-id') || '' });
  } else if (el.getAttribute('data-kcf') === 'cancel') {
    hideForm();
  }
});
document.addEventListener('keydown', (event) => {
  // Batch 28.4: while the pulled-models list is open Escape closes the LIST
  // first (a second Escape then collapses the form without saving).
  if (event.key === 'Escape' && formVisible() && comboOpen()) { closeCombo(); return; }
  if (event.key === 'Escape' && formVisible()) hideForm();
});
// Batch 28.4 combobox events: arrow click and focus open the FULL unfiltered
// list (current model checked); typing filters it case-insensitively.
// ArrowDown/Up move the active option, Enter selects it, Escape closes only
// the list (stopPropagation keeps the form open). Manual typing stays valid.
if (kcFormModelArrow) kcFormModelArrow.addEventListener('click', () => { if (comboOpen()) closeCombo(); else openCombo(); });
if (kcFormModelInput) {
  kcFormModelInput.addEventListener('focus', () => { if (formVisible()) openCombo(); });
  kcFormModelInput.addEventListener('input', () => { if (formVisible()) refreshComboTyped(); });
  kcFormModelInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { if (comboOpen()) { closeCombo(); event.stopPropagation(); } return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!comboOpen()) openCombo();
      moveComboActive(event.key === 'ArrowDown' ? 1 : -1);
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter') {
      if (!comboOpen()) return;
      const opts = comboOptEls();
      if (comboActive >= 0 && opts[comboActive]) pickComboOption(String(opts[comboActive].getAttribute('data-model') || ''));
      else closeCombo();
      event.preventDefault();
    }
  });
}
if (kcFormModelOptions) kcFormModelOptions.addEventListener('click', (event) => {
  const hit = event.target instanceof Element ? event.target : null;
  const opt = hit ? hit.closest('.kc-combo-opt') : null;
  if (opt) pickComboOption(String(opt.getAttribute('data-model') || ''));
});
// Click anywhere outside the combo closes the dropdown (the form stays open).
document.addEventListener('click', (event) => {
  if (!comboOpen()) return;
  const hit = event.target instanceof Element ? event.target : null;
  if (hit && kcFormModelCombo && kcFormModelCombo.contains(hit)) return;
  closeCombo();
});
[kcFormProvider, kcFormKeyInput, kcFormModelInput, kcFormLabelInput, kcFormBaseUrlInput].forEach((el) => {
  if (!el) return;
  el.addEventListener('input', persistForm);
  el.addEventListener('change', persistForm);
});
// Batch 28.3: manual trigger stays — instant, and it cancels a pending
// debounced auto-pull. Auto trigger: key paste / provider change → 600 ms.
if (kcFormPullBtn) kcFormPullBtn.addEventListener('click', requestFormModels);
if (kcFormKeyInput) kcFormKeyInput.addEventListener('input', scheduleFormPull);
if (kcFormProvider) kcFormProvider.addEventListener('change', scheduleFormPull);
if (kcFormSaveBtn) kcFormSaveBtn.addEventListener('click', () => {
  if (!kcFormProvider || !kcFormKeyInput) return;
  // Client-side gate first: provider picked; a NEW profile needs a key.
  if (!kcFormProvider.value) { setFormError(L('keychain.formErrProvider')); return; }
  if (!formEditing && !kcFormKeyInput.value.trim()) { setFormError(L('keychain.formErrKey')); return; }
  kcFormSaveBtn.disabled = true;
  const span = kcFormSaveBtn.querySelector('span:last-child');
  if (span) span.textContent = L('save.saving');
  writeFormState({ editing: formEditing, provider: kcFormProvider.value, model: kcFormModelInput ? kcFormModelInput.value : '', label: kcFormLabelInput ? kcFormLabelInput.value : '', baseUrl: kcFormBaseUrlInput ? kcFormBaseUrlInput.value : '', submitted: true });
  vscode.postMessage({
    command: 'keychainFormSave',
    profileId: formEditing || undefined,
    provider: kcFormProvider.value,
    apiKey: kcFormKeyInput.value.trim() || undefined,
    model: kcFormModelInput ? kcFormModelInput.value.trim() : '',
    label: kcFormLabelInput ? kcFormLabelInput.value.trim() : '',
    baseUrl: kcFormBaseUrlInput ? kcFormBaseUrlInput.value.trim() : ''
  });
});
// Form init after each host render: an OPEN card (validation redraft) keeps
// its server-rendered values; otherwise restore the client draft unless the
// previous one was already submitted (success re-render must close the card).
(function initForm() {
  if (!kcForm) return;
  if (formVisible()) {
    formEditing = kcForm.getAttribute('data-editing') || '';
    if (kcFormKeyInput) kcFormKeyInput.placeholder = formEditing ? L('keychain.formKeyKeep') : L('center.keyPaste');
    // Batch 28.6: the host-rendered editing card (validation redraft) must
    // ALSO physically drop its displayed rows — same contract as clicking
    // the card's Edit button: no displayed key rows while the form is open.
    const serverCard = kcForm.closest ? kcForm.closest('.kc-row') : null;
    if (serverCard && serverCard.classList.contains('kc-editing')) hideCardRows(serverCard);
    const prev = readFormState();
    if (prev && !prev.submitted && Array.isArray(prev.models)) formModelsList = prev.models.map(String);
    persistForm();
    return;
  }
  const st = readFormState();
  if (!st) return;
  if (st.submitted) { writeFormState(null); return; }
  showForm(st);
})();
const testConnBtn = document.getElementById('testConnection');
testConnBtn.addEventListener('click', () => {
  testConnBtn.disabled = true;
  const label = testConnBtn.querySelector('span:last-child');
  if (label) label.textContent = L('center.connecting');
  vscode.postMessage({ command: 'testConnection' });
});
document.getElementById('clearKey').addEventListener('click', () => vscode.postMessage({ command: 'clearApiKey' }));
document.getElementById('openRules').addEventListener('click', () => vscode.postMessage({ command: 'openRules' }));
document.getElementById('refreshContext').addEventListener('click', () => vscode.postMessage({ command: 'refreshContext' }));
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
  // Batch 28.2/28.4: models pulled inside the profile card — feed the model
  // combobox; the card input keeps a user-typed model (only an empty field is preset).
  if (data.type === 'formModels') {
    // Batch 28.3: a stale answer (the user retyped meanwhile, a newer request
    // is in flight) must NOT unlock the button or overwrite the status line.
    if (data.requestId !== formPullSeq) return;
    setFormPullBusy(false);
    if (data.ok) {
      // Batch 28.4: pulled models land in formModelsList (the datalist is gone);
      // an open dropdown repaints in the SAME mode — full list when opened by
      // focus/arrow (no filtering by the current value), typed-filter otherwise.
      formModelsList = Array.isArray(data.models) ? data.models.map(String) : [];
      if (data.model && kcFormModelInput && !kcFormModelInput.value) kcFormModelInput.value = String(data.model);
      if (comboOpen()) renderCombo();
      persistForm();
      // The status line under the field is host-translated; the counter inside
      // the dropdown is rendered by renderCombo from formModelsList.length.
      setFormModelsStatus(String(data.countText || ''), false);
    } else {
      if (data.message) setFormError(String(data.message));
      // Category hint (401/404/network) lives inside the card too.
      setFormModelsStatus(String(data.hint || data.message || ''), true);
    }
    return;
  }
  // Batch 22 p.1: live GET /models can take up to 10s — during the fetch the
  // provider select, baseUrl and the live-models button are disabled and the
  // button shows the loading label (already translated, sent by the host).
  if (data.type === 'modelsBusy') {
    const busy = data.busy === true;
    providerSelect.disabled = busy;
    baseUrlInput.disabled = busy;
    const modelBtn = document.getElementById('chooseModel');
    if (modelBtn) {
      modelBtn.disabled = busy;
      const label = modelBtn.querySelector('span:last-child');
      if (label) label.textContent = busy ? (data.label || L('models.loading')) : L('center.liveModels');
    }
    return;
  }
  if (data.type === 'connResult') {
    const btn = document.getElementById('testConnection');
    if (btn) {
      btn.disabled = false;
      const label = btn.querySelector('span:last-child');
      if (label) label.textContent = L('center.retry');
    }
    const status = document.getElementById('status');
    if (status) {
      status.textContent = '';
      status.classList.toggle('error', data.ok === false);
      status.dataset.category = String(data.category || (data.ok ? 'ok' : 'unknown'));
      if (status.style.display === 'none') status.style.display = 'block';
      const main = document.createElement('div');
      main.className = 'conn-line';
      main.textContent = data.message || '';
      status.appendChild(main);
      if (data.ok === false && data.hint) {
        const hint = document.createElement('div');
        hint.className = 'conn-hint';
        hint.textContent = data.hint;
        status.appendChild(hint);
      }
    }
    return;
  }
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
// Batch 18: one DELEGATED link handler for about/dev buttons (data-url).
// preventDefault is mandatory: the webview must never try to navigate
// itself (CSP kills mailto navigation silently -> "dead click" UX). The host
// opens whitelisted URLs via openExternal. Keep this script Cyrillic-free.
// Batch 18.9: the mail anchor is NOT a data-url link anymore — it carries
// data-action="mailto" and a dedicated global delegated listener below posts
// the fixed mailto address. No inline onclick (nonce CSP blocks inline
// handlers outright), no literal mailto: in href (CSP blocks navigation):
// the click is pure JS -> postMessage -> host openExternal. Belt-and-braces.
document.addEventListener('click', (e) => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  if (target.closest('[data-action="mailto"]')) {
    e.preventDefault();
    vscode.postMessage({ command: 'openLink', url: 'mailto:work.valden@gmail.com' });
  }
});
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const el = target.closest('[data-url], a[href^="mailto:"]');
  if (!el) return;
  event.preventDefault();
  const url = el.getAttribute('data-url') || el.getAttribute('href') || '';
  if (url) vscode.postMessage({ command: 'openLink', url });
});
const reportIssueBtn = document.getElementById('reportIssue');
if (reportIssueBtn) reportIssueBtn.addEventListener('click', () => vscode.postMessage({ command: 'reportIssue' }));
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
document.body.setAttribute('data-cs-ready', '1');
} catch (initError) {
  console.error('CodeScout settings: script init failed', initError);
  document.body.setAttribute('data-cs-ready', 'error: ' + (initError && initError.message || String(initError)));
}
</script>
</body>
</html>`;
}
