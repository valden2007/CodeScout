// МИКРО-БАТЧ 28.3: живые модели в форме профилей, openrouter/zai во всех
// списках, фикс сырого i18n-ключа кнопки сохранения.
// Контракты:
//  1) openrouter и zai присутствуют в четырёх списках: select формы,
//     legacy-select центра, QuickPick свитча/добавления профилей (e2e),
//     пикер догона батча 25 (исходник) — порядок единый из PROVIDERS;
//  2) рендер-матрица: в видимых подписях <button>/<label> НЕТ сырых ключей
//     вида [a-z]+\.[a-zA-Z]+; каждый L('…') из скрипта вебвью покрыт UI-словарём;
//  3) авто-подтяжка: keychainFormModels эхо-ит requestId, отдаёт countText,
//     категоризирует 401/404/сеть и НЕ пишет секрет (SecretStorage пуст);
//  4) исходник скрипта: дебаунс 600мс, ключ в getState не кладётся, ручной
//     триггер сохранён.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';
import { buildSettingsHtml, type SettingsState } from '../extension/src/settingsHtml';
import { readProfiles, resetRuntime } from '../extension/src/keychain';
import { PROVIDER_ORDER, PROVIDERS, resolveBaseUrl, defaultModel, keyUrl, normalizeProvider, resolveApiKey } from '../src/providers';
import { t, keysOf } from '../src/i18n';

const KEY_FORM = 'CS_MOCK_KEY_FOR_TESTS_9999';

const base: SettingsState = {
  keyMask: '', keyConfigured: false, provider: 'gemini', model: '', baseUrl: '',
  reportLanguage: 'ru', showAuditBanner: true, docLinks: [], docMaxKb: 50, docMaxLinks: 5,
  maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0,
  auditScope: '', auditPasses: 1, rateLimitPauses: 3, requestTimeoutSeconds: 60, version: 'test',
  uiTheme: 'auto', accentColor: 'auto', uiDensity: 'standard', uiFontSize: 'm', showConfidence: true,
  findingsSort: 'severity', reportTheme: 'auto', customColors: '{}',
  keychainProfiles: [], keychainActiveId: '', failoverEnabled: false, failoverMaxCycles: 0
};

function scriptOf(html: string): string {
  const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

function uiDictOf(html: string): Record<string, string> {
  const m = html.match(/const UI = (\{[\s\S]*?\});/);
  expect(m, 'UI-словарь не найден в скрипте').toBeTruthy();
  return JSON.parse(m![1]) as Record<string, string>;
}

function captionsOf(html: string): string[] {
  // Только ВИДИМЫЕ подписи: текст внутри <button>…</button> и <label>…</label>
  // вне <script>/<style> (плейсхолдеры атрибутов — не подписи).
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  const out: string[] = [];
  for (const m of body.matchAll(/<(button|label)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    out.push(m[2].replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').trim());
  }
  return out;
}

async function openCenter(): Promise<{ html: () => string; send: (message: unknown) => void; messages: () => Record<string, unknown>[] }> {
  activate(makeFakeContext() as never);
  await (state.commands.get('codescout.openSettingsPage') as () => Promise<unknown>)();
  await flush();
  const panel = state.panels[state.panels.length - 1];
  expect(panel).toBeDefined();
  return {
    html: () => panel!.webview.html,
    send: (message) => panel!.webview.onMessageHandlers[0](message as never),
    messages: () => panel!.webview.messages as Record<string, unknown>[]
  };
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush();
}

describe('микробатч 28.3: openrouter и zai во всех четырёх списках', () => {
  it('реестр: zai подключён полностью (baseUrl, env, дефолт, keyUrl, normalize)', () => {
    expect(normalizeProvider('zai')).toBe('zai');
    expect(resolveBaseUrl('zai')).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(defaultModel('zai')).toBeTruthy();
    expect(keyUrl('zai')).toMatch(/^https:\/\//);
    expect(resolveApiKey('zai', undefined, { ZAI_API_KEY: 'k-env' })).toBe('k-env');
    expect(PROVIDERS.zai.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
  });

  it('порядки: единый источник PROVIDER_ORDER = custom + ключи PROVIDERS', () => {
    expect(PROVIDER_ORDER[0]).toBe('custom');
    expect(PROVIDER_ORDER.slice(1)).toEqual(Object.keys(PROVIDERS));
    expect(PROVIDER_ORDER).toContain('openrouter');
    expect(PROVIDER_ORDER).toContain('zai');
  });

  it('select формы профиля и legacy-select центра содержат openrouter и zai (оба селекта)', () => {
    const html = buildSettingsHtml({
      ...base,
      keychainFormDraft: { provider: 'openrouter' }
    }, '', 'ok', 'n283', '', undefined, 'ru');
    // legacy-select (#provider) + select формы (kcFormProvider) — минимум 2 вхождения каждого.
    expect((html.match(/<option value="openrouter"[ >]/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((html.match(/<option value="zai"[ >]/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<option value="openrouter" selected>');
  });

  it('QuickPick выбора провайдера профиля: открытый список = PROVIDER_ORDER (e2e keychainAdd)', async () => {
    const realFetch = globalThis.fetch;
    state.reset();
    resetRuntime();
    const root = mkdtempSync(join(tmpdir(), 'cs-28-3-'));
    state.workspaceRoot = root;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'glm-4.5-air' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    try {
      state.inputBoxAnswers.push('Matrix profile', KEY_FORM);
      state.quickPickAnswers.push('zai');
      activate(makeFakeContext() as never);
      await (state.commands.get('codescout.openSettingsPage') as () => Promise<unknown>)();
      await flush();
      const panel = state.panels[state.panels.length - 1];
      panel!.webview.onMessageHandlers[0]({ command: 'keychainAdd' } as never);
      await settle();
      const call = state.quickPickCalls[0];
      expect(call).toBeDefined();
      const items = call![0] as string[];
      expect(items).toEqual([...PROVIDER_ORDER]);
      expect(items).toContain('openrouter');
      expect(items).toContain('zai');
      const profiles = readProfiles();
      expect(profiles.map((p) => p.provider)).toContain('zai');
    } finally {
      globalThis.fetch = realFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('манифест: enum codescout.provider синхронен с PROVIDER_ORDER (openrouter, zai)', () => {
    const manifest = JSON.parse(readFileSync('extension/package.json', 'utf8')) as {
      contributes: { configuration: { properties: { 'codescout.provider': { enum: string[] } } } };
    };
    const enumList = manifest.contributes.configuration.properties['codescout.provider'].enum;
    expect(enumList).toEqual([...PROVIDER_ORDER]);
  });

  it('пикер догона (батч 25) и свитч центра берут порядок из PROVIDER_ORDER', () => {
    const resume = readFileSync('extension/src/auditResume.ts', 'utf8');
    expect(resume).toContain('[...PROVIDER_ORDER]');
    const ext = readFileSync('extension/src/extension.ts', 'utf8');
    expect(ext).toContain("showQuickPick([...PROVIDER_ORDER], { placeHolder: t('keychain.pickProviderForProfile'");
    expect(ext).toContain("showQuickPick([...PROVIDER_ORDER], { placeHolder: t('key.pickProvider'");
  });
});

describe('микробатч 28.3: контракт «нет сырых i18n-ключей в видимых подписях»', () => {
  // Сырой ключ = совпадение шаблона [a-z]+\.[a-zA-Z]+, которое ЯВЛЯЕТСЯ ключом
  // одного из словарей (t() при пропуске возвращает сам ключ). Тех-термины
  // вроде «rules.md» словарями не являются и не считаются.
  const SHAPE_RE = /\b[a-z][a-z0-9]*\.[a-zA-Z][a-zA-Z0-9]*\b/g;
  const dictKeys = new Set([...keysOf('ru'), ...keysOf('en')]);
  const rawKeyHits = (text: string): string[] => (text.match(SHAPE_RE) ?? []).filter((token) => dictKeys.has(token));
  const states: Record<string, Partial<SettingsState>> = {
    'закрытая форма': { keychainProfiles: [{ id: 'p1', label: 'x', provider: 'groq', keys: [{ id: 'default', label: 'default', secretId: 'keychain.p1.default', enabled: true }] }], keychainActiveId: 'p1' },
    'открытая форма (draft)': { keychainFormDraft: { provider: 'openrouter', label: 'draft', model: '', baseUrl: '' } },
    'форма с ошибкой': { keychainFormDraft: { profileId: 'p1', provider: 'groq' }, keychainFormError: 'Не выбран провайдер.' },
    'пустой keychain': {},
    'деградация (битый keys)': { keychainProfiles: [{ id: 'p1', label: 'x', provider: 'groq', keys: {} as never }] as never }
  };
  for (const lang of ['ru', 'en'] as const) {
    for (const [name, patch] of Object.entries(states)) {
      it(`${name} / ${lang}: подписи кнопок и лейблов без сырых ключей`, () => {
        const html = buildSettingsHtml({ ...base, ...patch }, '', 'ok', `n283-${lang}`, 'sec-key', undefined, lang, () => undefined);
        const captions = captionsOf(html);
        expect(captions.length).toBeGreaterThan(10);
        for (const caption of captions) {
          expect(rawKeyHits(caption), `сырой ключ в подписи: «${caption}»`).toEqual([]);
        }
      });
    }
  }

  it('каждый L(«ключ») из скрипта вебвью покрыт UI-словарём (корень бага formSave)', () => {
    for (const lang of ['ru', 'en'] as const) {
      const html = buildSettingsHtml(base, '', 'ok', 'n283', '', undefined, lang);
      const script = scriptOf(html);
      const dict = uiDictOf(html);
      const used = [...script.matchAll(/\bL\('([a-z][a-z0-9]*\.[a-zA-Z][a-zA-Z0-9]*)'\)/g)].map((m) => m[1]);
      expect(used).toContain('keychain.formSave');
      for (const key of new Set(used)) {
        expect(dict[key], `L('${key}'), но ключа нет в UI-словаре`).toBeTruthy();
        expect(dict[key]).not.toBe(key);
      }
      // Ни одно значение словаря не равно другому ключу (t() fallback = сам ключ).
      for (const value of Object.values(dict)) expect(dictKeys.has(value)).toBe(false);
    }
  });

  it('ru-рендер: кнопка сохранения содержит перевод, а не keychain.formSave', () => {
    const html = buildSettingsHtml(base, '', 'ok', 'n283', '', undefined, 'ru');
    expect(html).toContain('<button id="kcFormSave" type="button">');
    expect(html).toContain('Сохранить профиль');
    const saveCaption = captionsOf(html).find((c) => c.includes('Сохранить профиль'));
    expect(saveCaption).toBeDefined();
    expect(rawKeyHits(saveCaption!)).toEqual([]);
  });
});

describe('микробатч 28.3: авто-подтяжка живых моделей (хост-e2e)', () => {
  const realFetch = globalThis.fetch;
  let root = '';
  beforeEach(() => {
    state.reset();
    resetRuntime();
    root = mkdtempSync(join(tmpdir(), 'cs-28-3b-'));
    state.workspaceRoot = root;
    delete process.env.CODESCOUT_BASE_URL;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  });

  it('успех: requestId эхом, models + countText, SecretStorage НЕ тронут (счётчик ноль)', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'or-model-a' }, { id: 'or-model-b' }, { id: 'or-model-c' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const center = await openCenter();
    const secretsBefore = state.secrets.size;
    center.send({ command: 'keychainFormModels', requestId: 7, provider: 'openrouter', apiKey: KEY_FORM, baseUrl: '' });
    await settle();
    const responses = center.messages().filter((m) => m.type === 'formModels');
    expect(responses.length).toBe(1);
    const last = responses[0];
    expect(last.requestId).toBe(7);
    expect(last.ok).toBe(true);
    expect(last.models).toEqual(['or-model-a', 'or-model-b', 'or-model-c']);
    expect(last.countText).toBe(t('keychain.formModelsCount', 'ru', { n: 3 }));
    // СЕКРЕТ НИКУДА НЕ ЗАПИСАН: ни одного нового ключа в SecretStorage, ни профилей.
    expect(state.secrets.size).toBe(secretsBefore);
    expect([...state.secrets.values()].some((v) => v.includes(KEY_FORM))).toBe(false);
    expect([...state.config.keys()].some((k) => k.includes('keychain'))).toBe(false);
  });

  it('401 → ok=false, категория auth_invalid_key + переведённая подсказка', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })) as unknown as typeof fetch;
    const center = await openCenter();
    center.send({ command: 'keychainFormModels', requestId: 1, provider: 'groq', apiKey: KEY_FORM, baseUrl: '' });
    await settle();
    const last = center.messages().filter((m) => m.type === 'formModels').at(-1)!;
    expect(last.ok).toBe(false);
    expect(last.category).toBe('auth_invalid_key');
    expect(String(last.message).length).toBeGreaterThan(3);
    expect(String(last.hint)).toBe(t('err.hint.auth_invalid_key', 'ru'));
    expect([...state.secrets.values()].some((v) => v.includes(KEY_FORM))).toBe(false);
  });

  it('404 → категория model_not_found (эндпоинт/модель), секрет не писался', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    const center = await openCenter();
    center.send({ command: 'keychainFormModels', requestId: 2, provider: 'openrouter', apiKey: KEY_FORM, baseUrl: '' });
    await settle();
    const last = center.messages().filter((m) => m.type === 'formModels').at(-1)!;
    expect(last.ok).toBe(false);
    expect(last.category).toBe('model_not_found');
    expect(String(last.hint)).toBe(t('err.hint.model_not_found', 'ru'));
  });

  it('сетевой сбой → категория connection_refused с подсказкой внутри карточки', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const center = await openCenter();
    center.send({ command: 'keychainFormModels', requestId: 3, provider: 'groq', apiKey: KEY_FORM, baseUrl: '' });
    await settle();
    const last = center.messages().filter((m) => m.type === 'formModels').at(-1)!;
    expect(last.ok).toBe(false);
    expect(last.category).toBe('connection_refused');
    expect(String(last.hint).length).toBeGreaterThan(3);
  });

  it('хост не дёргает глобальный modelsBusy на форме: fetchLiveModelsCached напрямую', () => {
    const ext = readFileSync('extension/src/extension.ts', 'utf8');
    const start = ext.indexOf("message.command === 'keychainFormModels'");
    const end = ext.indexOf("message.command === 'keychainSetActive'", start);
    const branch = ext.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(branch).toContain('fetchLiveModelsCached');
    expect(branch).toContain('countText');
    expect(branch).toContain('formatError');
    expect(branch).not.toContain('fetchModels(');
  });

  it('исходник скрипта: дебаунс 600мс на ключе/провайдере, ручной триггер жив, ключ в getState не кладётся', () => {
    const source = readFileSync('extension/src/settingsHtml.ts', 'utf8');
    expect(source).toContain("kcFormKeyInput.addEventListener('input', scheduleFormPull)");
    expect(source).toContain("kcFormProvider.addEventListener('change', scheduleFormPull)");
    expect(source).toMatch(/setTimeout\(\(\) => \{ formPullTimer = 0; requestFormModels\(\); \}, 600\)/);
    // Ручная кнопка — мгновенный запрос (requestFormModels сам отменяет дебаунс).
    expect(source).toContain("kcFormPullBtn.addEventListener('click', requestFormModels)");
    // draft в vscode.getState: поля формы БЕЗ ключа.
    const persist = source.slice(source.indexOf('function persistForm'), source.indexOf('function showForm'));
    expect(persist).toContain('provider:');
    expect(persist).not.toContain('kcFormKeyInput.value');
    // Устаревший ответ отбрасывается.
    expect(source).toContain('data.requestId !== formPullSeq');
    // Состояние загрузки и статус «N моделей».
    expect(source).toContain("L('keychain.formModelsLoading')");
    expect(source).toContain('data.countText');
  });
});
