// HOTFIX Settings Persistence & UI Refresh:
// 1) «Сохранить» в центре обязан персистентно класть ключ в SecretStorage
//    и не терять его при перерисовке/перезапуске;
// 2) строка «сейчас:» — строго динамическая (маска · провайдер · реально
//    выбранная модель; локальный сервер — «локальный режим · Ollama»;
//    пусто — нейтральный статус), никакого устаревшего дефолта gemini-2.5-flash;
// 3) белый список команд webview разрешает сохранение.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';
import { buildSettingsHtml, localServiceName } from '../extension/src/settingsHtml';
import { buildReportHtml } from '../extension/src/reportHtml';
import { ReviewIssue } from '../src/types';

async function waitFor(check: () => boolean, timeoutMs = 10000, stepMs = 20): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timeout; errors: ${state.errorMessages.slice(-4).join(' | ')}`);
    await flush();
  }
}

async function openCenter(): Promise<{ html: () => string; send: (message: unknown) => void }> {
  activate(makeFakeContext() as never);
  await (state.commands.get('codescout.openSettingsPage') as () => Promise<unknown>)();
  const panel = state.panels[state.panels.length - 1];
  expect(panel).toBeDefined();
  return {
    html: () => panel!.webview.html,
    send: (message) => panel!.webview.onMessageHandlers[0](message as never)
  };
}

// Батч 27: несекретный список профилей из stub-конфига.
function keychainProfiles(): Array<{ id: string; label: string; provider: string; model?: string }> {
  const value = state.config.get('codescout.keychain')?.globalValue;
  return Array.isArray(value) ? value as Array<{ id: string; label: string; provider: string; model?: string }> : [];
}

describe('hotfix: сохранение API-ключа в центре настроек', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    state.reset();
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'offline in tests' } }), { status: 401 })) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('saveAll кладёт ключ в SecretStorage, и он виден после перерисовки центра', async () => {
    const center = await openCenter();
    center.send({
      command: 'saveAll',
      apiKey: 'oc_sUPERSECRET7',
      providerKey: 'custom',
      baseUrl: '',
      reportLanguage: 'ru',
      linksText: '',
      docMaxKb: 50,
      docMaxLinks: 5,
      maxLines: 0,
      maxFiles: 100,
      autoResume: false,
      autoResumeMaxAttempts: 0,
      autoResumeMaxMinutes: 0,
      auditScope: '',
      auditPasses: 1,
      rateLimitPauses: 3,
      requestTimeoutSeconds: 60,
      uiTheme: 'auto',
      accentColor: 'auto',
      uiDensity: 'standard',
      uiFontSize: 'm',
      findingsSort: 'severity',
      reportTheme: 'auto',
      showConfidence: true,
      customColors: '{}'
    });
    await waitFor(() => state.secrets.get('codescout.apiKey') === 'oc_sUPERSECRET7');
    await waitFor(() => center.html().includes('oc_s') && center.html().includes('custom'));
    // «Перезапуск»: пользователь закрыл вкладку центра (dispose) и открывает
    // заново — панель пересоздаётся, ключ читается из того же SecretStorage.
    state.panels[state.panels.length - 1].dispose();
    const revived = await openCenter();
    await waitFor(() => revived.html().includes('oc_s'));
    // маска есть, сырой ключ — никогда
    expect(revived.html()).not.toContain('oc_sUPERSECRET7');
  }, 20000);

  it('ключ не пропадает, если saveAll пришёл без apiKey (пустое поле = оставить текущий)', async () => {
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    state.secrets.set('codescout.provider', 'custom');
    const center = await openCenter();
    center.send({ command: 'saveAll', apiKey: undefined, providerKey: 'custom', baseUrl: '', reportLanguage: 'ru', linksText: '', docMaxKb: 50, docMaxLinks: 5, maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0, auditScope: '', auditPasses: 1, rateLimitPauses: 3, requestTimeoutSeconds: 60, uiTheme: 'auto', accentColor: 'auto', uiDensity: 'standard', uiFontSize: 'm', findingsSort: 'severity', reportTheme: 'auto', showConfidence: true, customColors: '{}' });
    await waitFor(() => center.html().includes('CS_MOC') || center.html().includes('•'));
    expect(state.secrets.get('codescout.apiKey')).toBe('CS_MOCK_KEY_FOR_TESTS');
    expect(state.secrets.get('codescout.provider')).toBe('custom');
  }, 20000);
});

describe('hotfix: динамическая строка «сейчас:» в центре', () => {
  const base = { reportLanguage: 'ru' as const, showAuditBanner: true, docLinks: [] as string[], docMaxKb: 50, docMaxLinks: 5, maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0, auditScope: '', auditPasses: 1, rateLimitPauses: 3, requestTimeoutSeconds: 60, version: '1.1.2', uiTheme: 'auto' as const, accentColor: 'auto' as const, uiDensity: 'standard' as const, uiFontSize: 'm' as const, showConfidence: true, findingsSort: 'severity' as const, reportTheme: 'auto' as const, customColors: '' };

  it('ключ + провайдер + реально выбранная модель — все три сегмента динамические', () => {
    const html = buildSettingsHtml({ ...base, keyMask: 'oc_s•••E7', keyConfigured: true, provider: 'custom', model: 'qwen3.8-flash', baseUrl: 'https://opencode.example/v1' });
    expect(html).toContain('oc_s•••E7 · custom · qwen3.8-flash');
    expect(html).not.toContain('gemini-2.5-flash');
  });

  it('модель ещё не выбрана — нейтральная плашка вместо дефолта прошлого провайдера', () => {
    const html = buildSettingsHtml({ ...base, keyMask: 'oc_s•••E7', keyConfigured: true, provider: 'custom', model: '', baseUrl: 'https://opencode.example/v1' });
    expect(html).toContain('oc_s•••E7 · custom');
    expect(html).toContain('модель не выбрана');
    expect(html).not.toContain('gemini-2.5-flash');
  });

  it('локальный сервер без ключа — «локальный режим · Ollama/LM Studio»', () => {
    expect(localServiceName('http://localhost:11434/v1')).toBe('Ollama');
    expect(localServiceName('http://127.0.0.1:1234/v1')).toBe('LM Studio');
    expect(localServiceName('http://localhost:8080/v1')).toBe('localhost');
    expect(localServiceName('https://api.groq.com/openai/v1')).toBeUndefined();
    expect(localServiceName('')).toBeUndefined();
    const html = buildSettingsHtml({ ...base, keyMask: '', keyConfigured: false, provider: 'custom', model: 'qwen2.5-coder', baseUrl: 'http://localhost:11434/v1' });
    expect(html).toContain('локальный режим · Ollama');
    const en = buildSettingsHtml({ ...base, keyMask: '', keyConfigured: false, provider: 'custom', model: '', baseUrl: 'http://localhost:1234/v1' }, '', 'ok', 'nonce', '', undefined, 'en');
    expect(en).toContain('local mode · LM Studio');
  });

  it('ничего не настроено — нейтральный статус, маска не светится', () => {
    const html = buildSettingsHtml({ ...base, keyMask: 'SECRET999', keyConfigured: false, provider: 'gemini', model: 'x', baseUrl: '' });
    expect(html).toContain('ключ не настроен');
    expect(html).not.toContain('SECRET999');
  });

  it('EN-версия строки статуса без кириллицы', () => {
    const en = buildSettingsHtml({ ...base, keyMask: 'oc_s•••E7', keyConfigured: true, provider: 'custom', model: '', baseUrl: 'http://localhost:11434/v1' }, '', 'ok', 'nonce', '', undefined, 'en');
    expect(en).toContain('no model selected');
    expect(en).not.toMatch(/[\u0400-\u04FF]/);
  });
});

describe('hotfix: белый список команд webview', () => {
  it('saveAll и saveKeyProvider разрешены в KNOWN_SETTINGS_COMMANDS, кнопка шлёт saveAll', () => {
    const extension = readFileSync('extension/src/extension.ts', 'utf8');
    expect(extension).toMatch(/KNOWN_SETTINGS_COMMANDS = new Set\(\[[^\]]*'saveAll'[^\]]*\]\)/);
    expect(extension).toMatch(/KNOWN_SETTINGS_COMMANDS = new Set\(\[[^\]]*'saveKeyProvider'[^\]]*\]\)/);
    const center = readFileSync('extension/src/settingsHtml.ts', 'utf8');
    expect(center).toContain("command: 'saveAll'");
  });

  it('нет мёртвых ссылок на несуществующую команду saveSettings', () => {
    const center = readFileSync('extension/src/settingsHtml.ts', 'utf8');
    const extension = readFileSync('extension/src/extension.ts', 'utf8');
    const panel = readFileSync('extension/src/panel.ts', 'utf8');
    expect(center).not.toContain("'saveSettings'");
    expect(extension).not.toContain("'saveSettings'");
    expect(panel).not.toContain("'saveSettings'");
  });

  it('center не показывает model-дефолт манифеста для custom: resolveExtensionSelection берёт только явно заданную модель', () => {
    const extension = readFileSync('extension/src/extension.ts', 'utf8');
    expect(extension).toContain("config.inspect<string>('model')");
    expect(extension).not.toContain("config.get<string>('model')?.trim()");
  });
});

// Батч 18.9: смена провайдера в центре настроек обязана сама открывать
// меню выбора модели (codescout.chooseModel) — старая модель гарантированно
// невалидна для нового провайдера. Без смены провайдера попап не показываем.
describe('батч 18.9: авто-выбор модели при смене провайдера', () => {
  const realFetch = globalThis.fetch;
  const realEnv = { base: process.env.CODESCOUT_BASE_URL, groq: process.env.GROQ_API_KEY, gemini: process.env.GEMINI_API_KEY, openai: process.env.OPENAI_API_KEY, go: process.env.OPENCODE_GO_API_KEY };
  const full = { reportLanguage: 'ru', linksText: '', docMaxKb: 50, docMaxLinks: 5, maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0, auditScope: '', auditPasses: 1, rateLimitPauses: 3, requestTimeoutSeconds: 60, uiTheme: 'auto', accentColor: 'auto', uiDensity: 'standard', uiFontSize: 'm', findingsSort: 'severity', reportTheme: 'auto', showConfidence: true, customColors: '{}' };
  beforeEach(() => {
    state.reset();
    // Тесты не должны наследовать машинный CODESCOUT_BASE_URL (например
    // https://api.b.ai/v1) — он перебивает baseUrl провайдера через
    // readBaseUrlInfo и уводит /models-запросы на сторону.
    delete process.env.CODESCOUT_BASE_URL;
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENCODE_GO_API_KEY;
    globalThis.fetch = (async (url: string | URL | undefined) => {
      if (String(url).includes('api.groq.com')) return new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] }), { status: 200 });
      if (String(url).includes('opencode.example')) return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-flash' }] }), { status: 200 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realEnv.base !== undefined) process.env.CODESCOUT_BASE_URL = realEnv.base;
    if (realEnv.groq !== undefined) process.env.GROQ_API_KEY = realEnv.groq;
    if (realEnv.gemini !== undefined) process.env.GEMINI_API_KEY = realEnv.gemini;
    if (realEnv.openai !== undefined) process.env.OPENAI_API_KEY = realEnv.openai;
    if (realEnv.go !== undefined) process.env.OPENCODE_GO_API_KEY = realEnv.go;
  });

  it('gemini → groq: после saveAll сам открывается quickPick модели и выбор пишется (батч 27: стек живёт в профиле keychain)', async () => {
    state.secrets.set('codescout.apiKey', 'AIzaOldKeyForTest');
    state.secrets.set('codescout.provider', 'gemini');
    state.secrets.set('codescout.model', 'gemini-1.5-flash');
    state.quickPickAnswers.push('llama-3.3-70b-versatile');
    const center = await openCenter();
    // Батч 27: activate смигрировал одиночный ключ в профиль «default».
    // Ждём завершения миграции — иначе saveAll гонок с promise-цепочкой.
    await waitFor(() => keychainProfiles().length > 0);
    center.send({ command: 'saveAll', ...full, apiKey: 'gsk_TESTKEY123', providerKey: 'groq' });
    // Провайдер и модель пишутся В АКТИВНЫЙ ПРОФИЛЬ (не в legacy-секреты).
    await waitFor(() => keychainProfiles()[0]?.provider === 'groq');
    await waitFor(() => keychainProfiles()[0]?.model === 'llama-3.3-70b-versatile');
    // quickPick был востребован именно авто-вызовом: очередь пуста
    expect(state.quickPickAnswers).toHaveLength(0);
    expect(state.errorMessages).toHaveLength(0);
  }, 20000);

  it('provider не меняется (custom → custom) — меню НЕ открывается', async () => {
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    state.secrets.set('codescout.provider', 'custom');
    state.secrets.set('codescout.model', 'qwen3.8-flash');
    const center = await openCenter();
    center.send({ command: 'saveAll', ...full, providerKey: 'custom', baseUrl: 'https://opencode.example/v1' });
    await waitFor(() => center.html().includes('CS_M•••STS'));
    await flush(); await flush();
    expect(state.quickPickAnswers).toHaveLength(0);
    expect(state.errorMessages).toHaveLength(0);
    expect(state.secrets.get('codescout.model')).toBe('qwen3.8-flash');
  }, 20000);

  it('контракт исходников: saveKeyProvider считает providerChanged по SecretStorage и ждёт codescout.chooseModel', () => {
    const extension = readFileSync('extension/src/extension.ts', 'utf8');
    expect(extension).toContain('providerChanged');
    // Батч 27: при активном профиле keychain oldProvider берётся из профиля.
    expect(extension).toContain('const oldProvider = profileId ? selection.provider : (oldProviderSecret?.trim() || selection.provider);');
    expect(extension).toContain('const providerChanged = provider !== oldProvider;');
    expect(extension).toContain("await vscode.commands.executeCommand('codescout.chooseModel')");
    expect(extension).toContain('await autoSelectModelAfterProviderChange(context, providerChanged);');
    expect(extension.match(/autoSelectModelAfterProviderChange\(context, (providerChanged|saved\.providerChanged)\);/g)).toHaveLength(2);
    const fetchModels = extension.slice(extension.indexOf('async function fetchModels'), extension.indexOf('async function fetchModels') + 2000);
    // Батч 20a, п.2: provider+onWarn в Output (умный мок Gemini).
    // Батч 21, п.3: tolerateErrors — выбор моделей не падает, тест
    // подключения/мастер вызывают с false.
    // Батч 22: кэш (fetchLiveModelsCached), 10с таймаут, sanitizeApiKey,
    // onMetric — длительность/байты в Output.
    expect(fetchModels).toContain("fetchLiveModelsCached(baseUrl, sanitizeApiKey(selection.key ?? ''), fetch, MODELS_FETCH_TIMEOUT_MS, selection.provider, (message) => (hostOutput ? hostOutput.appendLine(message) : console.warn(message)), tolerateErrors, (message) => hostOutput?.appendLine(message))");
    expect(fetchModels).toContain('notifyModelsBusy(true)');
    expect(fetchModels).toContain('notifyModelsBusy(false)');
  });
});

describe('hotfix: панель находок не печатает устаревшую модель при custom', () => {
  it('key-status в панели: пустая модель кастомного провайдера → нейтральный текст', () => {
    const issues: ReviewIssue[] = [];
    const html = buildReportHtml(issues, { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 }, false, false, '', 'retry', 'oc_s•••E7', true, 'custom', '', false, '', false, 'new', undefined, '', undefined, undefined, false, 0, 0, undefined, 'nonce', undefined, 'ru');
    expect(html).toContain('модель не выбрана');
    expect(html).not.toContain('gemini-2.5-flash');
  });
});
