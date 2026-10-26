// МИКРО-БАТЧ 28.4: аккордеон (форма ВНУТРИ карточки профиля) + честный
// комбобокс моделей + классификатор платёжной квоты.
// Контракты:
//  1) рендер: при открытом draft узел #kcForm находится ВНУТРИ карточки
//     профиля (проверка по дереву div-ов), ровно одна открытая форма на
//     список; новый/удалённый профиль — целевая карточка = add-card в конце;
//     закрытая форма живёт в хабе #kcFormHome;
//  2) комбобокс: чистое ядро (cs-combo-core) из живого скрипта вебвью —
//     при 11 подтянутых моделях и непустом текущем значении раскрытие
//     даёт 11 опций БЕЗ фильтрации; печать фильтрует подстрокой без учёта
//     регистра; markup: dropdown вместо datalist, счётчик/галочка/клавиши;
//  3) quota: 402/«insufficient_quota»/«billing»/«Upgrade to … Tier» →
//     категория quota (не unknown); skipBreakerFeed по quota прозрачна;
//     по unknown/auth/parse breaker по-прежнему стопит; llm-client: 402
//     с failover-хуком усыпляет ключ и ротирует (reason='quota'), без
//     хука летит наверх мгновенно, без локальной лестницы.
import { describe, expect, it } from 'vitest';
import { buildSettingsHtml, type SettingsState } from '../extension/src/settingsHtml';
import { categorizeError, formatError, ERROR_CATEGORIES } from '../src/error-classifier';
import { OpenAICompatibleProvider, ProviderHttpError, RateLimitError, type FailoverHooks } from '../src/llm-client';
import { formatSkipReason, skipBreakerFeed, type SkipBreakerState } from '../extension/src/projectAudit';
import { t, keysOf } from '../src/i18n';
import type { KeychainProfile } from '../extension/src/keychain';

const base: SettingsState = {
  keyMask: '', keyConfigured: false, provider: 'gemini', model: '', baseUrl: '',
  reportLanguage: 'ru', showAuditBanner: true, docLinks: [], docMaxKb: 50, docMaxLinks: 5,
  maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0,
  auditScope: '', auditPasses: 1, rateLimitPauses: 3, requestTimeoutSeconds: 60, version: 'test',
  uiTheme: 'auto', accentColor: 'auto', uiDensity: 'standard', uiFontSize: 'm', showConfidence: true,
  findingsSort: 'severity', reportTheme: 'auto', customColors: '{}',
  keychainProfiles: [], keychainActiveId: '', failoverEnabled: false, failoverMaxCycles: 0
};

function profile(id: string, label: string): KeychainProfile {
  return { id, label, provider: 'groq', keys: [{ id: 'default', label: 'default', secretId: `keychain.${id}.default`, enabled: true }] };
}

function scriptOf(html: string): string {
  const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

// Проверка по HTML-дереву: стек ОТКРЫТЫХ <div> до позиции маркера —
// предки узла формы. Самодостаточный парсер (в шаблонах div всегда
// сбалансирован, void-элементы — input/br — div не закрывают).
function divAncestorsAt(html: string, marker: string): string[] {
  const idx = html.indexOf(marker);
  expect(idx, `маркер не найден: ${marker}`).toBeGreaterThan(-1);
  const stack: string[] = [];
  const re = /<div\b[^>]*>|<\/div\s*>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && match.index < idx) {
    if (match[0].startsWith('</')) stack.pop();
    else stack.push(match[0]);
  }
  return stack;
}

const openFormCount = (html: string): number => (html.match(/class="kc-form"/g) ?? []).length;
const closedFormCount = (html: string): number => (html.match(/class="kc-form hidden"/g) ?? []).length;

describe('микробатч 28.4: аккордеон — форма внутри карточки профиля', () => {
  it('draft правки p2: #kcForm ВНУТРИ узла карточки p2, add-card скрыта, открытая форма одна', () => {
    const html = buildSettingsHtml({
      ...base,
      keychainProfiles: [profile('p1', 'Alpha'), profile('p2', 'Beta')],
      keychainActiveId: 'p1',
      keychainFormDraft: { profileId: 'p2', provider: 'groq', label: 'Beta', model: 'llama-3.3-70b-versatile', baseUrl: '' }
    }, '', 'ok', 'n284', '', undefined, 'ru');
    const ancestors = divAncestorsAt(html, '<div id="kcForm"');
    expect(ancestors.some((a) => a.includes('data-profile-id="p2"'))).toBe(true);
    expect(ancestors.some((a) => a.includes('data-profile-id="p1"'))).toBe(false);
    expect(ancestors.some((a) => a.includes('data-add-card'))).toBe(false);
    expect(ancestors.some((a) => a.includes('kc-form-slot'))).toBe(true);
    expect(openFormCount(html)).toBe(1);
    expect(closedFormCount(html)).toBe(0);
    expect(html).toContain('class="kc-row kc-add-card hidden"');
  });

  it('draft нового профиля: форма ВНУТРИ add-card в конце списка (единственная открытая)', () => {
    const html = buildSettingsHtml({
      ...base,
      keychainProfiles: [profile('p1', 'Alpha')],
      keychainFormDraft: { provider: 'openrouter', label: '', model: '', baseUrl: '' }
    }, '', 'ok', 'n284', '', undefined, 'ru');
    const ancestors = divAncestorsAt(html, '<div id="kcForm"');
    expect(ancestors.some((a) => a.includes('data-add-card'))).toBe(true);
    expect(ancestors.some((a) => a.includes('data-profile-id="p1"'))).toBe(false);
    expect(html).toContain('class="kc-row kc-add-card"');
    expect(html).not.toContain('class="kc-row kc-add-card hidden"');
    expect(openFormCount(html)).toBe(1);
    // add-card — ПОСЛЕДНЯЯ карточка списка: её позиция позже строки p1.
    expect(html.indexOf('data-add-card')).toBeGreaterThan(html.indexOf('data-profile-id="p1"'));
  });

  it('draft уже удалённого профиля: форма падает в add-card (не теряется), одна открытая', () => {
    const html = buildSettingsHtml({
      ...base,
      keychainProfiles: [profile('p1', 'Alpha')],
      keychainFormDraft: { profileId: 'ghost', provider: 'groq', label: 'x', model: '', baseUrl: '' }
    }, '', 'ok', 'n284', '', undefined, 'en');
    const ancestors = divAncestorsAt(html, '<div id="kcForm"');
    expect(ancestors.some((a) => a.includes('data-add-card'))).toBe(true);
    expect(openFormCount(html)).toBe(1);
  });

  it('закрытая форма: hidden в хабе #kcFormHome, ни одной открытой, add-card скрыта', () => {
    const html = buildSettingsHtml({ ...base, keychainProfiles: [profile('p1', 'Alpha'), profile('p2', 'Beta')], keychainActiveId: 'p2' }, '', 'ok', 'n284', '', undefined, 'ru');
    const ancestors = divAncestorsAt(html, '<div id="kcForm" class="kc-form hidden"');
    expect(ancestors.some((a) => a.includes('id="kcFormHome"'))).toBe(true);
    expect(openFormCount(html)).toBe(0);
    expect(closedFormCount(html)).toBe(1);
    expect(html).toContain('class="kc-row kc-add-card hidden"');
    // Слот формы есть ВНУТРИ каждой карточки — клиент переносит форму в него.
    const p1Slot = html.slice(html.indexOf('data-profile-id="p1"'), html.indexOf('data-profile-id="p2"'));
    expect(p1Slot).toContain('<div class="kc-form-slot"></div>');
  });

  it('инвариант «одна форма на список» во всех состояниях (ru/en) + скрипт парсится', () => {
    const states: Array<[string, Partial<SettingsState>]> = [
      ['пустой keychain', {}],
      ['закрытая', { keychainProfiles: [profile('p1', 'Alpha'), profile('p2', 'Beta')] }],
      ['правки p2', { keychainProfiles: [profile('p1', 'Alpha'), profile('p2', 'Beta')], keychainFormDraft: { profileId: 'p2', provider: 'groq' } }],
      ['новая', { keychainProfiles: [profile('p1', 'Alpha')], keychainFormDraft: { provider: 'zai' } }],
      ['с ошибкой', { keychainProfiles: [profile('p1', 'Alpha')], keychainFormDraft: { profileId: 'p1', provider: 'groq' }, keychainFormError: 'boom-validation (ascii, both langs)' }]
    ];
    for (const lang of ['ru', 'en'] as const) {
      for (const [name, patch] of states) {
        const html = buildSettingsHtml({ ...base, ...patch } as SettingsState, '', 'ok', `n284-${lang}`, '', undefined, lang, () => undefined);
        expect(openFormCount(html) + closedFormCount(html), `${name}/${lang}: ровно один узел формы`).toBe(1);
        expect(() => new Function(scriptOf(html))).not.toThrow();
        if (lang === 'en') expect(html).not.toMatch(/[\u0400-\u04FF]/);
      }
    }
  });

  it('деградация 28.1: битый keys при открытом draft — onRenderIssue, HTML цел, скрипт парсится', () => {
    const issues: string[] = [];
    const html = buildSettingsHtml({
      ...base,
      keychainProfiles: [{ id: 'p1', label: 'x', provider: 'groq', keys: {} as never }] as never,
      keychainFormDraft: { profileId: 'p1', provider: 'groq' }
    }, '', 'ok', 'n284', '', undefined, 'en', (m) => issues.push(m));
    expect(issues).toHaveLength(1);
    expect(html).toContain('id="kcBlock"');
    expect(html).toContain('id="kcFormHome"');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(() => new Function(scriptOf(html))).not.toThrow();
  });

  it('контракт исходника: единственный узел переносится в слот карточки, скролл — только к новой карточке, фокус без прыжка', () => {
    const source = readScriptSource();
    // Клиент: единственный #kcForm мутирует слотом карточки и возвращается в хаб.
    expect(source).toContain('function mountFormFor(id)');
    expect(source).toContain('slot.appendChild(kcForm)');
    expect(source).toContain('if (kcFormHome) kcFormHome.appendChild(kcForm);');
    // Единственный допустимый скролл — к новой add-карточке; фокус — preventScroll.
    expect(source).toContain("showForm({}, { scroll: true })");
    expect(source).toContain('kcForm.scrollIntoView({ block: \'nearest\', behavior: \'smooth\' })');
    expect(source).toContain('kcFormProvider.focus({ preventScroll: true })');
    // Cancel/Escape сворачивают форму без postMessage: hideForm не отправляет хосту.
    const hide = source.slice(source.indexOf('function hideForm'), source.indexOf('document.addEventListener(\'click\', (event) => {\n  const target'));
    expect(hide).not.toContain('postMessage');
    // Открытие формы внутри карточки не скроллит (аккордеон «на месте»).
    expect(source).toContain("el.getAttribute('data-kcf') === 'edit'");
  });
});

function readScriptSource(): string {
  // Живой источник скрипта — из settingsHtml (тот же текст, что исполняется в
  // вебвью); new Function всей выжимки проверяется матрицей выше.
  const html = buildSettingsHtml({ ...base, keychainProfiles: [profile('p1', 'Alpha')] }, '', 'ok', 'n284s', '', undefined, 'en');
  return scriptOf(html);
}

// 11 подтянутых моделей для честного контракта комбобокса.
const MODELS_11 = [
  'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b', 'gemma2-9b-it',
  'GPT-4o-Mini', 'gpt-4o', 'o3-mini', 'grok-2', 'deepseek-r1', 'qwen-2.5-32b', 'Command-R-Plus'
];

interface ComboCore {
  comboOpenList(models: unknown): string[];
  comboFilter(models: unknown, query: unknown): string[];
  comboIsCurrent(model: unknown, current: unknown): boolean;
}

function comboCore(): ComboCore {
  const script = readScriptSource();
  const m = script.match(/\/\* cs-combo-core:start \*\/([\s\S]*?)\/\* cs-combo-core:end \*\//);
  expect(m, 'маркеры cs-combo-core не найдены в скрипте').toBeTruthy();
  const factory = new Function(`${m![1]}; return { comboOpenList, comboFilter, comboIsCurrent };`);
  return factory() as ComboCore;
}

describe('микробатч 28.4: честный комбобокс моделей (ядро из живого скрипта)', () => {
  const core = comboCore();

  it('раскрытие при НЕПУСТОМ текущем значении — ВСЕ 11 моделей, без фильтрации', () => {
    const current = 'llama-3.3-70b-versatile';
    expect(current).not.toBe('');
    const list = core.comboOpenList(MODELS_11);
    expect(list).toHaveLength(11);
    expect(list).toEqual(MODELS_11);
    // Текущая помечается галочкой через comboIsCurrent — она в списке.
    expect(list.some((model) => core.comboIsCurrent(model, current))).toBe(true);
    expect(core.comboIsCurrent('llama-3.1-8b-instant', current)).toBe(false);
  });

  it('печать фильтрует подстрокой без учёта регистра; пустой запрос — весь список', () => {
    expect(core.comboFilter(MODELS_11, 'LLAMA')).toEqual(['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
    expect(core.comboFilter(MODELS_11, 'gpt-4')).toEqual(['GPT-4o-Mini', 'gpt-4o']);
    expect(core.comboFilter(MODELS_11, '  70B  ')).toEqual(['llama-3.3-70b-versatile']);
    expect(core.comboFilter(MODELS_11, 'zzz-нет-такого')).toEqual([]);
    expect(core.comboFilter(MODELS_11, '')).toHaveLength(11);
    // Независимость от исходного массива (не мутируем стейт).
    const list = core.comboFilter(MODELS_11, '');
    list.pop();
    expect(MODELS_11).toHaveLength(11);
  });

  it('markup: dropdown вместо datalist; счётчик над опциями; aria; галочка текущей', () => {
    const html = buildSettingsHtml({ ...base, keychainProfiles: [profile('p1', 'Alpha')] }, '', 'ok', 'n284m', '', undefined, 'ru');
    expect(html).not.toContain('<datalist');
    expect(html).toContain('id="kcFormModelCombo"');
    expect(html).toContain('id="kcFormModelArrow"');
    expect(html).toContain('id="kcFormModelDropdown"');
    expect(html).toContain('id="kcFormModelsCount"');
    expect(html).toContain('id="kcFormModelOptions"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="listbox"');
    // Счётчик-абзац идёт ДО контейна опций (над списком).
    expect(html.indexOf('id="kcFormModelsCount"')).toBeLessThan(html.indexOf('id="kcFormModelOptions"'));
  });

  it('скрипт: фокус/стрелка открывают ПОЛНЫЙ список, печать фильтрует, стрелки/Enter/Escape клавиатура, ручной ввод жив', () => {
    const source = readScriptSource();
    expect(source).toContain("kcFormModelInput.addEventListener('focus', () => { if (formVisible()) openCombo(); })");
    expect(source).toContain("kcFormModelInput.addEventListener('input', () => { if (formVisible() && comboOpen()) refreshComboTyped(); })");
    expect(source).toContain("kcFormModelArrow.addEventListener('click', () => { if (comboOpen()) closeCombo(); else openCombo(); })");
    expect(source).toContain("event.key === 'ArrowDown' || event.key === 'ArrowUp'");
    expect(source).toContain('moveComboActive(event.key === \'ArrowDown\' ? 1 : -1)');
    expect(source).toContain('if (event.key === \'Enter\')');
    expect(source).toContain('pickComboOption(String(opts[comboActive].getAttribute(\'data-model\') || \'\'))');
    // Escape закрывает СПИСОК, не форму: stopPropagation на инпуте + приоритет
    // closeCombo в документальном обработчике.
    expect(source).toContain('if (comboOpen()) { closeCombo(); event.stopPropagation(); }');
    expect(source).toContain('if (event.key === \'Escape\' && formVisible() && comboOpen()) { closeCombo(); return; }');
    // Ручной ввод: значение инпута никогда не перетирается списком.
    expect(source).toContain('if (data.model && kcFormModelInput && !kcFormModelInput.value) kcFormModelInput.value = String(data.model)');
    // Счётчик «N моделей» и подсказка при N=0 — из UI-словаря, без сырых ключей.
    expect(source).toContain("L('keychain.formModelsCount').replace('{n}'");
    expect(source).toContain("L('keychain.comboEmptyHint')");
    expect(source).toContain("L('keychain.comboNoMatches')");
    expect(() => new Function(source)).not.toThrow();
  });

  it('formModels (28.3 регресс): ответ хоста ложится в formModelsList, не в datalist', () => {
    const source = readScriptSource();
    expect(source).toContain('formModelsList = Array.isArray(data.models) ? data.models.map(String) : [];');
    expect(source).not.toContain('createElement(\'option\')');
  });
});

describe('микробатч 28.4: классификатор платёжной квоты (quota)', () => {
  it('ERROR_CATEGORIES + словари: quota везде (ru/en ключи err.title/msg/hint)', () => {
    expect(ERROR_CATEGORIES).toContain('quota');
    const ru = new Set(keysOf('ru'));
    const en = new Set(keysOf('en'));
    for (const key of ['err.title.quota', 'err.msg.quota', 'err.hint.quota']) {
      expect(ru.has(key), `ru ${key}`).toBe(true);
      expect(en.has(key), `en ${key}`).toBe(true);
    }
  });

  it('HTTP 402 (ProviderHttpError) → quota, НЕ unknown', () => {
    expect(categorizeError(new ProviderHttpError(402, '402: Out of credits — top up your account', ''))).toBe('quota');
    expect(categorizeError(new Error('402: Payment Required'))).toBe('quota');
    expect(categorizeError(new Error('status 402'))).toBe('quota');
  });

  it('groq billing-текст → quota', () => {
    const groq = new Error('Please upgrade to Go (https://console.groq.com/playground) to increase your rate limit. See https://console.groq.com/settings/billing');
    expect(categorizeError(groq)).toBe('quota');
    expect(categorizeError(new Error('Upgrade to a paid tier to keep using this model'))).toBe('quota');
  });

  it('openrouter «insufficient_quota» / credits+billing → quota', () => {
    expect(categorizeError(new Error('insufficient_quota: You exceeded your current quota, please check your plan and billing details'))).toBe('quota');
    expect(categorizeError(new Error('out of credits — top up your billing account'))).toBe('quota');
    expect(categorizeError(new Error('Payment required: add credits to continue'))).toBe('quota');
  });

  it('не ломаем 429: rate limit остаётся rate_limit_exceeded', () => {
    expect(categorizeError(new RateLimitError('Rate limited: 429 too many requests', 60))).toBe('rate_limit_exceeded');
    expect(categorizeError(new Error('HTTP 429 Too Many Requests'))).toBe('rate_limit_exceeded');
    expect(categorizeError(new Error('too many requests'))).toBe('rate_limit_exceeded');
    expect(categorizeError(new Error('overloaded, try again'))).toBe('rate_limit_exceeded');
  });

  it('formatError(quota) — локализованные title/message/hint в ru и en', () => {
    const ru = formatError(new ProviderHttpError(402, '402: insufficient_quota', ''), 'ru');
    expect(ru.category).toBe('quota');
    expect(ru.title).toBe(t('err.title.quota', 'ru'));
    expect(ru.actionHint).toBe(t('err.hint.quota', 'ru'));
    const en = formatError(new ProviderHttpError(402, '402: insufficient_quota', ''), 'en');
    expect(en.actionHint).toBe(t('err.hint.quota', 'en'));
    expect(en.actionHint).not.toMatch(/[\u0400-\u04FF]/);
  });

  it('formatSkipReason: 402 → категория quota + HTTP 402 в чекпоинт', () => {
    const reason = formatSkipReason(new ProviderHttpError(402, '402: billing', 'details'));
    expect(reason.category).toBe('quota');
    expect(reason.http).toBe(402);
  });

  it('breaker: quota прозрачна (никогда не стопит), unknown/auth/parse — стопят по-прежнему', () => {
    const q: SkipBreakerState = { count: 0 };
    for (let i = 0; i < 20; i += 1) expect(skipBreakerFeed(q, 'quota', 4), `quota #${i}`).toBe(false);
    expect(q.category).toBeUndefined();
    expect(q.count).toBe(0);
    // quota не сбрасывает и не суммирует чужую серию: 4 auth подряд (вперемешку
    // с quota) всё равно стопят.
    const mix: SkipBreakerState = { count: 0 };
    expect(skipBreakerFeed(mix, 'auth_invalid_key', 4)).toBe(false);
    expect(skipBreakerFeed(mix, 'quota', 4)).toBe(false);
    expect(skipBreakerFeed(mix, 'auth_invalid_key', 4)).toBe(false);
    expect(skipBreakerFeed(mix, 'quota', 4)).toBe(false);
    expect(skipBreakerFeed(mix, 'auth_invalid_key', 4)).toBe(false);
    expect(mix.count).toBe(3);
    expect(skipBreakerFeed(mix, 'unknown', 4)).toBe(false); // другая серия начата
    const parse: SkipBreakerState = { count: 0 };
    for (let i = 0; i < 3; i += 1) expect(skipBreakerFeed(parse, 'invalid_json', 4)).toBe(false);
    expect(skipBreakerFeed(parse, 'invalid_json', 4)).toBe(true);
    const un: SkipBreakerState = { count: 0 };
    for (let i = 0; i < 3; i += 1) expect(skipBreakerFeed(un, 'unknown', 4)).toBe(false);
    expect(skipBreakerFeed(un, 'unknown', 4)).toBe(true);
  });

  it('llm-client 402 + failover: reason=quota, ключ усыпляется ротацией switch, повтор с новым ключом', async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    const fetcher = (async (url: string | URL, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      calls.push({ url: String(url), auth });
      if (calls.length === 1) return new Response(JSON.stringify({ error: { message: 'insufficient_quota: upgrade to a paid tier' } }), { status: 402, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok-quota-switch' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const hookCalls: Array<{ waitSeconds: number | undefined; reason?: string }> = [];
    const hooks: FailoverHooks = {
      async onRateLimit(waitSeconds, reason) {
        hookCalls.push({ waitSeconds, reason });
        return { action: 'switch', apiKey: 'KEY-SECOND', baseUrl: 'https://api.groq.com/openai/v1', model: 'm2' };
      },
      async onAuthError() { /* noop */ }
    };
    const provider = new OpenAICompatibleProvider('KEY-FIRST', 'm1', fetcher, async () => { /* мгновенный sleep */ }, undefined, 'https://api.groq.com/openai/v1', undefined, undefined, hooks);
    const content = await provider.review('sys', 'user');
    expect(content).toBe('ok-quota-switch');
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0].reason).toBe('quota');
    expect(calls[0].auth).toBe('Bearer KEY-FIRST');
    expect(calls[1].auth).toBe('Bearer KEY-SECOND');
  });

  it('llm-client 402 без failover: мгновенный ProviderHttpError, без локальной лестницы ретраев', async () => {
    let fetches = 0;
    const slept: number[] = [];
    const fetcher = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ error: { message: 'please check your billing details' } }), { status: 402, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider('K', 'm', fetcher, async (ms) => { slept.push(ms); }, undefined, 'https://api.groq.com/openai/v1');
    await expect(provider.review('sys', 'user')).rejects.toBeInstanceOf(ProviderHttpError);
    await provider.review('sys', 'user').then(() => { throw new Error('must reject'); }, (error: unknown) => {
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect((error as ProviderHttpError).status).toBe(402);
      expect(categorizeError(error)).toBe('quota');
    });
    expect(fetches).toBe(2);
    // Никаких пауз лестницы 30/60/120 — только внутренний pacing ≤2с.
    expect(slept.every((ms) => ms <= 2000)).toBe(true);
  });

  it('llm-client 402 + stop: AllProfilesAsleepError вместо бесконечной ротации', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ error: { message: 'insufficient_quota' } }), { status: 402, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const hooks: FailoverHooks = {
      async onRateLimit() { return { action: 'stop', waitMs: 60000, wakeLabel: 'k1' }; },
      async onAuthError() { /* noop */ }
    };
    const provider = new OpenAICompatibleProvider('K', 'm', fetcher, async () => undefined, undefined, 'https://api.groq.com/openai/v1', undefined, undefined, hooks);
    await expect(provider.review('sys', 'user')).rejects.toThrow(/asleep/);
  });
});
