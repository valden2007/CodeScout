// Батч 15: дедлайны запросов (llm-client/providers) + UI-карточка ошибки
// и rich-статус проверки подключения через реальный activate() на vscode-stub.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';
import { CodeScoutPanel } from '../extension/src/panel';
import { OpenAICompatibleProvider, RateLimitError, RequestTimeoutError, requestTimeoutSecondsFromSetting, setDefaultRequestTimeoutMs, getDefaultRequestTimeoutMs } from '../src/llm-client';
import { fetchLiveModels } from '../src/providers';
import { formatError } from '../src/error-classifier';
import { buildReportHtml } from '../extension/src/reportHtml';

const hangFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
  const onAbort = (): void => reject(new DOMException('The operation was aborted', 'AbortError'));
  if (init?.signal?.aborted) { onAbort(); return; }
  init?.signal?.addEventListener('abort', onAbort, { once: true });
});

describe('батч 15: RequestTimeoutError дедлайн инференса', () => {
  const originalTimeout = getDefaultRequestTimeoutMs();
  afterEach(() => setDefaultRequestTimeoutMs(originalTimeout));

  it('зависший провайдер ретраится 3 раза и падает в RateLimitError с категорией rate_limit_exceeded (конструктор-параметр)', async () => {
    const provider = new OpenAICompatibleProvider('k', 'm', hangFetch, async () => undefined, undefined, 'https://mock.test/v1', undefined, 120);
    await expect(provider.review('s', 'u')).rejects.toMatchObject({
      name: 'RateLimitError',
      message: expect.stringContaining('Превышен лимит модели m')
    });
    await provider.review('s', 'u').catch((error: unknown) => {
      expect(formatError(error, 'ru').category).toBe('rate_limit_exceeded');
    });
  });

  it('модульный дефолт setDefaultRequestTimeoutMs применяется без пересоздания провайдера', async () => {
    setDefaultRequestTimeoutMs(1200);
    const provider = new OpenAICompatibleProvider('k', 'm', hangFetch, async () => undefined, undefined, 'https://mock.test/v1');
    await expect(provider.review('s', 'u')).rejects.toMatchObject({
      name: 'RateLimitError',
      message: expect.stringContaining('Превышен лимит модели m')
    });
  }, 20000);

  it('пользовательский cancel при активном дедлайне остаётся AbortError, не timeout', async () => {
    const controller = new AbortController();
    setDefaultRequestTimeoutMs(5000);
    const provider = new OpenAICompatibleProvider('k', 'm', hangFetch, async () => undefined, undefined, 'https://mock.test/v1', controller.signal);
    const pending = provider.review('s', 'u');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  }, 20000);

  it('requestTimeoutSecondsFromSetting: дефолт 60, кламп 10-600, мусор → дефолт', () => {
    expect(requestTimeoutSecondsFromSetting(undefined)).toBe(60);
    expect(requestTimeoutSecondsFromSetting('')).toBe(60);
    expect(requestTimeoutSecondsFromSetting('abc')).toBe(60);
    expect(requestTimeoutSecondsFromSetting(3)).toBe(10);
    expect(requestTimeoutSecondsFromSetting(9999)).toBe(600);
    expect(requestTimeoutSecondsFromSetting('120')).toBe(120);
  });

  it('/models: жёсткий 5с AbortSignal.timeout → категория timeout в UI-тексте', async () => {
    // таймаут прогона проверяем малым значением; дефолт аргумента = 5000 — контракт providers.ts
    const started = Date.now();
    await expect(fetchLiveModels('https://mock.test/v1', 'k', hangFetch, 200)).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(4000);
    const timedOut = await fetchLiveModels('https://mock.test/v1', 'k', async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), { once: true });
    }), 100).then(() => undefined, (error: unknown) => error);
    const formatted = formatError(timedOut, 'ru');
    expect(formatted.category).toBe('timeout');
    expect(formatted.message).toContain('5 с');
    const source = await import('../src/providers');
    expect(source.fetchLiveModels.toString() + source.probeLocalServer.toString()).toMatch(/AbortSignal\.timeout/);
  }, 20000);
});

function createView(): { view: unknown; receive: (message: unknown) => void; html: () => string } {
  let handler: (message: unknown) => void = () => {};
  let html = '';
  const view = {
    webview: {
      get html() { return html; },
      set html(value: string) { html = value; },
      options: {},
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri: { toString(): string }) => uri,
      postMessage: async () => true,
      onDidReceiveMessage: (cb: (message: unknown) => void) => { handler = cb; return { dispose: () => {} }; }
    },
    onDidDispose: () => ({ dispose: () => {} })
  };
  return { view, receive: (message) => handler(message), html: () => html };
}

async function waitFor(check: () => boolean, timeoutMs = 15000, stepMs = 25): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timeout; output: ${state.outputLines.slice(-8).join(' | ')}`);
    await new Promise((resolveDone) => setTimeout(resolveDone, stepMs));
  }
}

describe('батч 15: карточка ошибки в панели + повтор скана (e2e)', () => {
  let root = '';
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    state.reset();
    root = mkdtempSync(join(tmpdir(), 'cs-err-'));
    state.workspaceRoot = root;
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  });

  function boot(): { panel: CodeScoutPanel; receive: (message: unknown) => void; html: () => string } {
    activate(makeFakeContext() as never);
    const panel = state.providers.get('codescout.panel') as unknown as CodeScoutPanel;
    const { view, receive, html } = createView();
    panel.resolveWebviewView(view as never);
    return { panel, receive, html };
  }

  const unauthorized = () => new Response(JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } }), { status: 401, headers: { 'content-type': 'application/json' } });

  it('скан с битым ключом: карточка 401 с заголовком, подсказкой и кнопками; нотификация без сырого текста', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return unauthorized();
    }) as typeof fetch;
    const { html } = boot();
    await (state.commands.get('codescout.testSample') as () => Promise<unknown>)();
    await waitFor(() => state.outputLines.some((line) => line.includes('Self-test error')));
    expect(html()).toContain('Неверный API-ключ (401)');
    expect(html()).toContain('data-command="retryScan"');
    expect(html()).toContain('data-command="openSettingsPage"');
    expect(html()).toContain('err-hint');
    expect(html()).toContain('Проверьте ключ в консоли провайдера');
    const notification = state.errorMessages.join('\n');
    expect(notification).toContain('Неверный API-ключ');
    expect(notification).not.toContain('API key not valid');
  }, 40000);

  it('redactSecrets: ключ не попадает в Output даже когда его эхо-вернул провайдер', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'key CS_MOCK_KEY_FOR_TESTS rejected' } }), { status: 401 })) as typeof fetch;
    boot();
    await (state.commands.get('codescout.testSample') as () => Promise<unknown>)();
    await waitFor(() => state.outputLines.some((line) => line.includes('Self-test error')));
    const log = state.outputLines.join('\n');
    expect(log).not.toContain('CS_MOCK_KEY_FOR_TESTS');
  }, 40000);

  it('retryScan перезапускает последний скан того же типа (sample)', async () => {
    globalThis.fetch = (async () => unauthorized()) as typeof fetch;
    boot();
    await (state.commands.get('codescout.testSample') as () => Promise<unknown>)();
    await waitFor(() => state.outputLines.some((line) => line.includes('Self-test error')));
    const firstCount = state.outputLines.filter((line) => line.includes('self-test')).length;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[],"summary":"ok"}' } }] }), { status: 200 });
    }) as typeof fetch;
    await (state.commands.get('codescout.retryScan') as () => Promise<unknown>)();
    await waitFor(() => state.outputLines.filter((line) => line.toLowerCase().includes('self-test')).length > firstCount);
    expect(state.outputLines.some((line) => line.includes('running built-in self-test'))).toBe(true);
  }, 60000);

  it('кнопка retryScan из вебвью маршрутизируется в команду хоста', () => {
    const panelSource = readFileSync('extension/src/panel.ts', 'utf8');
    expect(panelSource).toContain("message.command === 'retryScan'");
    expect(panelSource).toContain("executeCommand('codescout.retryScan')");
  });
});

describe('батч 15: rich-статус проверки подключения в центре настроек', () => {
  const realFetch = globalThis.fetch;
  // settingsPanel — module-level в extension.ts: переживает state.reset()
  // между тестами, поэтому один boot на оба сценария и общий указатель на
  // вебвью (postMessage connResult приходит в него, а не в новый panel).
  let settingsPanel: { webview: { messages: Record<string, unknown>[]; onMessageHandlers: ((message: never) => void)[] } } | undefined;

  beforeEach(() => {
    state.reset();
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    state.secrets.set('codescout.provider', 'custom');
    state.set('codescout.baseUrl', 'https://mock.test/v1');
    activate(makeFakeContext() as never);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function connMessages(): Record<string, unknown>[] {
    return (settingsPanel?.webview.messages ?? []).filter((message) => message.type === 'connResult') as Record<string, unknown>[];
  }

  function lastConn(): Record<string, unknown> | undefined {
    const messages = connMessages();
    return messages[messages.length - 1];
  }

  it('401 → connResult с category/title/hint; сырое тело провайдера не показывается', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 401 })) as typeof fetch;
    await (state.commands.get('codescout.openSettingsPage') as () => Promise<unknown>)();
    settingsPanel = state.panels[state.panels.length - 1] as unknown as typeof settingsPanel;
    expect(settingsPanel).toBeDefined();
    settingsPanel!.webview.onMessageHandlers[0]({ command: 'testConnection' } as never);
    await waitFor(() => Boolean(lastConn()));
    const conn = lastConn();
    expect(conn?.ok).toBe(false);
    expect(conn?.category).toBe('auth_invalid_key');
    expect(String(conn?.message)).toContain('Неверный API-ключ (401)');
    expect(String(conn?.hint)).toContain('консоли провайдера');
    expect(String(conn?.message)).not.toContain('API key not valid');
    const centerSource = readFileSync('extension/src/settingsHtml.ts', 'utf8');
    expect(centerSource).toContain('conn-hint');
    expect(centerSource).toContain('data.category');
  }, 30000);

  it('успех: connResult ok и «Подключение работает: N моделей»', async () => {
    // панель создаётся при открытии центра (см. предыдущий тест-поток): если
    // её ещё нет — открываем явно.
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }), { status: 200 })) as typeof fetch;
    await (state.commands.get('codescout.openSettingsPage') as () => Promise<unknown>)();
    const panel = (state.panels[state.panels.length - 1] ?? settingsPanel) as unknown as typeof settingsPanel;
    settingsPanel = panel;
    expect(settingsPanel).toBeDefined();
    const before = connMessages().length;
    settingsPanel!.webview.onMessageHandlers[0]({ command: 'testConnection' } as never);
    await waitFor(() => connMessages().length > before);
    const conn = lastConn();
    expect(conn?.ok).toBe(true);
    expect(String(conn?.message)).toContain('2 моделей');
  }, 30000);
});

describe('батч 15: карточка ошибки в buildReportHtml без хоста', () => {
  it('errorInfo рисует заголовок, hint и обе кнопки (RU + EN)', () => {
    const stats = { files: 1, seconds: 1, critical: 0, medium: 0, low: 0 };
    const error = new RateLimitError('Rate limited: too many requests', 120, 'raw body');
    const ru = formatError(error, 'ru');
    const htmlRu = buildReportHtml([], stats, false, true, ru.message, 'error', '', true, 'gemini', 'm', false, '', false, 'new', undefined, '', undefined, undefined, false, 0, 0, undefined, 'n', undefined, 'ru', {}, ru.rawMessage, { category: ru.category, title: ru.title, hint: ru.actionHint });
    expect(htmlRu).toContain('Лимит запросов исчерпан (429)');
    expect(htmlRu).toContain('Подождите пару минут');
    expect(htmlRu).toContain('data-command="retryScan"');
    expect(htmlRu).toContain('data-command="openSettingsPage"');
    expect(htmlRu).toContain('details class="diag-block"');
    const en = formatError(error, 'en');
    const htmlEn = buildReportHtml([], stats, false, true, en.message, 'error', '', true, 'gemini', 'm', false, '', false, 'new', undefined, '', undefined, undefined, false, 0, 0, undefined, 'n', undefined, 'en', {}, '', { category: en.category, title: en.title, hint: en.actionHint });
    expect(htmlEn).toContain('Request limit exceeded (429)');
    expect(htmlEn).not.toMatch(/[\u0400-\u04FF]/);
  });
});
