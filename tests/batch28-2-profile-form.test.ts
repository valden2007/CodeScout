// МИКРО-БАТЧ 28.2: инлайн-форма профиля с явной кнопкой «Сохранить профиль»
// и видимый порядок цикла (номер-бейдж 1..N на строках списка).
// Контракты:
//  1) save с валидными данными → профиль в codescout.keychain + секрет на
//     keychain.<pid>.<kid> + строка с бейджем порядка в списке;
//  2) save с пустым ключом (создание) → ошибка ВНУТРИ формы (kcFormError),
//     черновик вернулся в поля, профиль НЕ создан;
//  3) edit с пустым полем ключа → старый секрет сохранён, метка обновлена;
//  4) cancel/Escape → клиентский закрытий формы без postMessage (контракт
//     исходника скрипта), хост ничего не записывает;
//  5) пустое название → авто-метка «<provider>·профиль-N» (ru) / profile-N (en);
//  6) «Подтянуть модели» (keychainFormModels) отдаёт список мок-фетча и НЕ
//     сохраняет ключ в settings/секреты раньше «Сохранить профиль»;
//  7) стрелки (keychainMove) меняют порядок массива и номера бейджей;
//  8) матрица рендера: форма открыта (draft+error)/закрыта — HTML цел,
//     скрипт парсится чистым JS (new Function), EN без кириллицы.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';
import { buildSettingsHtml, type SettingsState } from '../extension/src/settingsHtml';
import { keySecretId, readProfiles, resetRuntime, type KeychainProfile } from '../extension/src/keychain';
import { clearModelsCache } from '../src/providers';

const KEY_FORM = 'CS_MOCK_KEY_FOR_TESTS_9999';
const KEY_A = 'ZZKEYAAA_1234567890';
const KEY_B = 'ZZKEYBBB_0987654321';

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

function seedProfiles(profiles: KeychainProfile[], activeId: string): void {
  state.set('codescout.keychain', profiles);
  state.set('codescout.keychain.active', activeId);
}

describe('микробатч 28.2 e2e: форма профиля в центре настроек', () => {
  const realFetch = globalThis.fetch;
  let root = '';
  beforeEach(() => {
    state.reset();
    resetRuntime();
    clearModelsCache();
    root = mkdtempSync(join(tmpdir(), 'cs-28-2-'));
    state.workspaceRoot = root;
    delete process.env.CODESCOUT_BASE_URL;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'offline in tests' } }), { status: 401 })) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  });

  it('save с валидными данными: профиль в settings, секрет на keychain.<pid>.<kid>, бейдж порядка в списке', async () => {
    const center = await openCenter();
    center.send({ command: 'keychainFormSave', provider: 'groq', apiKey: KEY_FORM, label: 'main', model: 'llama-3.3-70b-versatile', baseUrl: '' });
    await settle();
    const profiles = readProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ label: 'main', provider: 'groq', model: 'llama-3.3-70b-versatile' });
    expect(state.secrets.get(keySecretId(profiles[0].id, 'default'))).toBe(KEY_FORM);
    // Строка списка: профиль + номер-бейдж цикла «1».
    const html = center.html();
    expect(html).toContain('kc-order-badge');
    expect(html).toContain('>1<');
    expect(html).toContain('main');
    // Форма закрыта после сохранения.
    expect(html).toContain('id="kcForm" class="kc-form hidden"');
    // Подпись про цикл видна под списком.
    expect(html).toContain('Цикл failover идёт по профилям в порядке списка');
  });

  it('save с пустым ключом: ошибка ВНУТРИ формы, черновик в полях, профиль не создан', async () => {
    const center = await openCenter();
    center.send({ command: 'keychainFormSave', provider: 'groq', apiKey: '', label: 'half-done' });
    await settle();
    expect(readProfiles()).toHaveLength(0);
    const html = center.html();
    // Форма открыта (без hidden), ошибка в kcFormError (без hidden).
    expect(html).toContain('id="kcForm" class="kc-form"');
    expect(html).toContain('class="kc-form-error"');
    expect(html).toContain('Вставь API-ключ');
    // Черновик вернулся в поля: провайдер выбран, название на месте.
    expect(html).toContain('<option value="groq" selected>');
    expect(html).toContain('value="half-done"');
    // Секрет не создан.
    expect([...state.secrets.entries()].some(([, v]) => v.includes('CS_MOCK'))).toBe(false);
  });

  it('save с битым Base URL: ошибка формы, профиль не создан', async () => {
    const center = await openCenter();
    center.send({ command: 'keychainFormSave', provider: 'groq', apiKey: KEY_FORM, baseUrl: 'ftp://nope' });
    await settle();
    expect(readProfiles()).toHaveLength(0);
    expect(center.html()).toContain('Битый Base URL');
  });

  it('edit с пустым полем ключа: старый секрет сохранён, метка обновлена', async () => {
    seedProfiles([{ id: 'a', label: 'Alpha', provider: 'groq', keys: [{ id: 'default', label: 'default', secretId: keySecretId('a', 'default'), enabled: true }] }], 'a');
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    const center = await openCenter();
    center.send({ command: 'keychainFormSave', profileId: 'a', provider: 'groq', apiKey: undefined, label: 'Alpha-Rename', model: '', baseUrl: '' });
    await settle();
    const profiles = readProfiles();
    expect(profiles[0].label).toBe('Alpha-Rename');
    // Секрет НЕ тронут — пустое поле = «оставить прежний».
    expect(state.secrets.get(keySecretId('a', 'default'))).toBe(KEY_A);
  });

  it('edit: непустой ключ формы перезатирает секрет рабочего ключа профиля', async () => {
    seedProfiles([{ id: 'a', label: 'Alpha', provider: 'groq', keys: [{ id: 'default', label: 'default', secretId: keySecretId('a', 'default'), enabled: true }] }], 'a');
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    const center = await openCenter();
    center.send({ command: 'keychainFormSave', profileId: 'a', provider: 'groq', apiKey: KEY_FORM, label: '', baseUrl: '' });
    await settle();
    expect(state.secrets.get(keySecretId('a', 'default'))).toBe(KEY_FORM);
  });

  it('пустое название: авто-метка <provider>·профиль-N по счёту списка', async () => {
    const center = await openCenter();
    center.send({ command: 'keychainFormSave', provider: 'groq', apiKey: KEY_FORM, label: '' });
    await settle();
    expect(readProfiles()[0].label).toBe('groq·профиль-1');
    center.send({ command: 'keychainFormSave', provider: 'openai', apiKey: KEY_B, label: '' });
    await settle();
    expect(readProfiles()[1].label).toBe('openai·профиль-2');
  });

  it('«Подтянуть модели» отдаёт список (мок) и НЕ сохраняет ключ до «Сохранить»', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'gpt-pulled-1' }, { id: 'gpt-pulled-2' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const center = await openCenter();
    center.send({ command: 'keychainFormModels', provider: 'openai', apiKey: KEY_FORM, baseUrl: '' });
    await settle();
    const responses = center.messages().filter((m) => m.type === 'formModels');
    expect(responses.length).toBeGreaterThan(0);
    const last = responses[responses.length - 1];
    expect(last.ok).toBe(true);
    expect(last.models).toContain('gpt-pulled-1');
    // Ключ из поля формы НЕ уехал в settings/секреты — профиль не создан.
    expect(readProfiles()).toHaveLength(0);
    expect([...state.secrets.values()].some((v) => v.includes(KEY_FORM))).toBe(false);
    expect([...state.config.keys()].some((k) => k === 'codescout.keychain')).toBe(false);
  });

  it('«Подтянуть модели» при битом ключа: ok=false с переводом, форма цела', async () => {
    const center = await openCenter();
    center.send({ command: 'keychainFormModels', provider: 'groq', apiKey: KEY_FORM, baseUrl: '' });
    await settle();
    const responses = center.messages().filter((m) => m.type === 'formModels');
    const last = responses[responses.length - 1];
    expect(last.ok).toBe(false);
    expect(String(last.message).length).toBeGreaterThan(3);
    expect(readProfiles()).toHaveLength(0);
  });

  it('стрелки: keychainMove меняет порядок массива И номера бейджей', async () => {
    seedProfiles([
      { id: 'a', label: 'Alpha', provider: 'groq', keys: [{ id: 'default', label: 'default', secretId: keySecretId('a', 'default'), enabled: true }] },
      { id: 'b', label: 'Beta', provider: 'openai', keys: [{ id: 'default', label: 'default', secretId: keySecretId('b', 'default'), enabled: true }] }
    ], 'a');
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    state.secrets.set(keySecretId('b', 'default'), KEY_B);
    const center = await openCenter();
    expect(center.html()).toContain('>1<');
    center.send({ command: 'keychainMove', id: 'b', dir: -1 });
    await settle();
    expect(readProfiles().map((p) => p.id)).toEqual(['b', 'a']);
    const html = center.html();
    // Бейдж «1» теперь у Beta: позиция строки b раньше строки a.
    expect(html.indexOf('data-profile-id="b"')).toBeLessThan(html.indexOf('data-profile-id="a"'));
    const badges = [...html.matchAll(/kc-order-badge" title="[^"]*">(\d+)</g)].map((m) => m[1]);
    expect(badges).toEqual(['1', '2']);
  });
});

describe('микробатч 28.2: матрица рендера формы (открыта/закрыта) + контракт cancel', () => {
  it('закрытая форма: hidden, пустый draft; EN-рендер без кириллицы', () => {
    const ru = buildSettingsHtml({ ...base, keychainProfiles: [{ id: 'p1', label: 'x', provider: 'groq', keys: [{ id: 'default', label: 'default', secretId: 'keychain.p1.default', enabled: true }] }] }, '', 'ok', 'n282', '', undefined, 'ru');
    expect(ru).toContain('id="kcForm" class="kc-form hidden"');
    expect(ru).toContain('kcFormSave');
    expect(ru).toContain('kcFormPullModels');
    expect(ru).toContain('Сохранить профиль');
    expect(() => new Function(scriptOf(ru))).not.toThrow();
    const en = buildSettingsHtml({ ...base, keychainProfiles: [{ id: 'p1', label: 'x', provider: 'groq', keys: [] as KeychainProfile['keys'] }] }, '', 'ok', 'n282', '', undefined, 'en');
    expect(en).toContain('Save profile');
    expect(en).toContain('Pull models');
    expect(en).not.toMatch(/[\u0400-\u04FF]/);
    expect(() => new Function(scriptOf(en))).not.toThrow();
  });

  it('открытая форма с draft+ошибкой: значения в полях, ошибка видима, скрипт парсится (ru/en)', () => {
    for (const lang of ['ru', 'en'] as const) {
      const html = buildSettingsHtml({
        ...base,
        keychainFormDraft: { profileId: 'p1', provider: 'groq', label: 'draft-label', model: 'm-x', baseUrl: 'https://relay.example/v1' },
        keychainFormError: lang === 'ru' ? 'Профиль уже удалён — нечего редактировать' : 'Profile was already removed — nothing to edit'
      }, '', 'ok', 'n282', '', undefined, lang);
      expect(html).toContain('id="kcForm" class="kc-form"');
      expect(html).toContain('class="kc-form-error"');
      expect(html).toContain('data-editing="p1"');
      expect(html).toContain('value="draft-label"');
      expect(html).toContain('value="m-x"');
      expect(html).toContain('<option value="groq" selected>');
      expect(html).toContain(lang === 'ru' ? 'Редактирование профиля' : 'Edit profile');
      expect(() => new Function(scriptOf(html))).not.toThrow();
      if (lang === 'en') expect(html).not.toMatch(/[\u0400-\u04FF]/);
    }
  });

  it('деградация формы не рвёт HTML: битый profile.keys → пустой список + onRenderIssue, script валиден', () => {
    const issues: string[] = [];
    const broken = [{ id: 'p1', label: 'x', provider: 'groq', keys: {} as unknown as KeychainProfile['keys'] }];
    const html = buildSettingsHtml({ ...base, keychainProfiles: broken, keychainActiveId: 'p1' } as SettingsState, '', 'ok', 'n', '', undefined, 'en', (m) => issues.push(m));
    expect(issues).toHaveLength(1);
    expect(html).toContain('id="kcBlock"');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(() => new Function(scriptOf(html))).not.toThrow();
  });

  it('контракт исходника скрипта: cancel/Escape — только клиентский hideForm, без postMessage', () => {
    const source = readFileSync('extension/src/settingsHtml.ts', 'utf8');
    // Кнопка «Отмена» и клик-делегат закрытия.
    expect(source).toContain('data-kcf="cancel"');
    expect(source).toMatch(/'cancel'\)\s*\{\s*hideForm\(\);/);
    // Escape закрывает форму.
    expect(source).toMatch(/key === 'Escape' && formVisible\(\)\)\s*hideForm\(\)/);
    // В обработчике [data-kcf] нет отправки хосту (cancel/edit — клиентские).
    const handler = source.slice(source.indexOf("closest('[data-kcf]')"), source.indexOf("document.addEventListener('keydown'"));
    expect(handler.length).toBeGreaterThan(100);
    expect(handler).not.toContain('postMessage');
    // Кнопка «+ Добавить профиль» больше не шлёт keychainAdd — открывает ту же
    // форму новой карточкой в конце списка (28.4: единственный допустимый
    // скролл — scrollIntoView к новому месту).
    expect(source).toContain("keychainAddBtn.addEventListener('click', () => showForm({}, { scroll: true }))");
  });

  it('новые команды в KNOWN_SETTINGS_COMMANDS', async () => {
    // Матрица команд микробатча 28.1 проходит по всему множеству — здесь
    // фиксируем только наличие новых команд.
    const extensionSource = readFileSync('extension/src/extension.ts', 'utf8');
    expect(extensionSource).toContain("'keychainFormSave'");
    expect(extensionSource).toContain("'keychainFormModels'");
    expect(typeof activate).toBe('function');
  });
});
