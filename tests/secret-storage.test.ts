import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate, migrateApiKeyFromSettings } from '../extension/src/extension';
import { buildSettingsHtml } from '../extension/src/settingsHtml';

// Батч 17, п.1 и п.3: строгий SecretStorage + раздел «О разработчике».

const LEGACY_KEY = 'LEGACY_PLAINTEXT_KEY_999';
const CENTER_STATE = {
  keyMask: 'AIza•••XYZ', keyConfigured: true, provider: 'gemini', model: 'gemini-2.5-flash', baseUrl: '',
  reportLanguage: 'ru' as const, showAuditBanner: true, docLinks: [], docMaxKb: 50, docMaxLinks: 5,
  maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0,
  auditScope: '', auditPasses: 1, version: '1.5.0', uiTheme: 'auto' as const, accentColor: 'auto' as const,
  uiDensity: 'standard' as const, uiFontSize: 'm' as const, showConfidence: true, findingsSort: 'severity' as const,
  reportTheme: 'auto' as const, customColors: ''
};

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

describe('батч 17: миграция ключа из settings.json в SecretStorage', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    state.reset();
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('plaintext-ключ переезжает в secrets и безжалостно удаляется из config', async () => {
    state.set('codescout.apiKey', LEGACY_KEY);
    await migrateApiKeyFromSettings(makeFakeContext() as never);
    expect(state.secrets.get('codescout.apiKey')).toBe(LEGACY_KEY);
    expect(state.config.get('codescout.apiKey')?.globalValue).toBeUndefined();
  });

  it('существующий секрет не перезаписывается, а config всё равно очищается', async () => {
    state.secrets.set('codescout.apiKey', 'REAL_SECRET_1');
    state.set('codescout.apiKey', LEGACY_KEY);
    state.setWorkspace('codescout.apiKey', 'WS_PLAIN_KEY_2');
    await migrateApiKeyFromSettings(makeFakeContext() as never);
    expect(state.secrets.get('codescout.apiKey')).toBe('REAL_SECRET_1');
    expect(state.config.get('codescout.apiKey')?.globalValue).toBeUndefined();
    expect(state.config.get('codescout.apiKey')?.workspaceValue).toBeUndefined();
  });

  it('activate() гоняет миграцию до первого resolve ключа (e2e через стаб)', async () => {
    state.set('codescout.apiKey', LEGACY_KEY);
    activate(makeFakeContext() as never);
    await waitFor(() => state.secrets.get('codescout.apiKey') === LEGACY_KEY && !state.config.get('codescout.apiKey'));
    await flush();
  });

  it('аутентификация больше НИКОГДА не читает config apiKey (строгий контракт исходника)', () => {
    const extension = readFileSync('extension/src/extension.ts', 'utf8');
    expect(extension).not.toContain("get<string>('apiKey')");
    expect(extension).toContain('resolveApiKeyPriority(secretKey, provider)');
    expect(extension).toContain('migratedLegacyApiKeys');
  });
});

describe('батч 17: центр настроек — бейдж безопасности и «О разработчике»', () => {
  it('сохранённый ключ помечен иконкой замка и текстом про SecretStorage', () => {
    const html = buildSettingsHtml(CENTER_STATE);
    expect(html).toContain('codicon-lock');
    expect(html).toContain('Ключ безопасно зашифрован в ОС (SecretStorage)');
    const en = buildSettingsHtml({ ...CENTER_STATE, reportLanguage: 'en' }, '', 'ok', 'n', '', undefined, 'en');
    expect(en).toContain('Key is securely encrypted in your OS (SecretStorage)');
    expect(en).not.toMatch(/[\u0400-\u04FF]/);
  });

  it('без ключа бейджа нет', () => {
    const html = buildSettingsHtml({ ...CENTER_STATE, keyMask: '', keyConfigured: false });
    expect(html).not.toContain('codicon-lock');
  });

  it('секция «О разработчике»: имя, mailto, GitHub, визитка и призыв (RU + EN)', () => {
    const html = buildSettingsHtml(CENTER_STATE);
    expect(html).toContain('id="sec-dev"');
    expect(html).toContain('О разработчике');
    expect(html).toContain('Яромир (Valden)');
    expect(html).toContain('mailto:work.valden@gmail.com');
    expect(html).toContain('https://github.com/valden2007/CodeScout');
    expect(html).toContain('Сайт в разработке');
    expect(html).toContain('Нашли баг, есть идея или хотите обсудить сотрудничество?');
    const en = buildSettingsHtml({ ...CENTER_STATE, reportLanguage: 'en' }, '', 'ok', 'n', '', undefined, 'en');
    expect(en).toContain('About the developer');
    expect(en).toContain('Yaromir (Valden)');
    expect(en).toContain('mailto:work.valden@gmail.com');
    expect(en).toContain('Website coming soon');
    expect(en).not.toMatch(/[\u0400-\u04FF]/);
  });

  it('клик по ссылке openLink: mailto и репозиторий проходят whitelist, чужой URL — нет (e2e)', async () => {
    const realFetch = globalThis.fetch;
    state.reset();
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
    activate(makeFakeContext() as never);
    await (state.commands.get('codescout.openSettingsPage') as () => Promise<unknown>)();
    await flush();
    const panel = state.panels[state.panels.length - 1] as unknown as { webview: { onMessageHandlers: ((message: never) => void)[] } };
    expect(panel).toBeDefined();
    const send = (message: Record<string, unknown>) => { panel.webview.onMessageHandlers[0](message as never); };
    send({ command: 'openLink', url: 'mailto:work.valden@gmail.com' });
    send({ command: 'openLink', url: 'https://github.com/valden2007/CodeScout/issues' });
    send({ command: 'openLink', url: 'https://evil.example.com/phish' });
    await waitFor(() => state.openedUris.length === 2);
    await flush();
    await flush();
    const opened = state.openedUris.map((uri) => String((uri as { toString(): string }).toString()));
    expect(opened).toHaveLength(2);
    expect(opened[0]).toContain('work.valden@gmail.com');
    expect(opened[1]).toContain('github.com/valden2007/CodeScout');
    expect(opened.join(' ')).not.toContain('evil.example.com');
    globalThis.fetch = realFetch;
  });
});
