// Батч 17.5: Compliance Core & Network Fixes — SSRF-защита HTTP-клиента
// (redirect: 'manual', отказ на 3xx), заголовки OpenCode Go (User-Agent +
// стабильный x-opencode-session), перехват mailto в панели, модалка
// «логи будут прикреплены» перед Issue и строгий автодетект oc_sk_.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';
import { CodeScoutPanel } from '../extension/src/panel';
import * as reporting from '../extension/src/reportIssue';
import { OpenAICompatibleProvider, USER_AGENT } from '../src/llm-client';
import { fetchLiveModels, probeLocalServer } from '../src/providers';
import { t } from '../src/i18n';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const okResponse = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[]}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });

async function waitFor(check: () => boolean, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timeout; errors: ${state.errorMessages.slice(-4).join(' | ')}`);
    await flush();
  }
}

describe('батч 17.5: SSRF — редиректы запрещены', () => {
  it('POST /chat/completions уходит с redirect:"manual", 302 роняет запрос без перехода по Location', async () => {
    let calls = 0;
    const inits: RequestInit[] = [];
    const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (init) inits.push(init);
      return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    }) as typeof fetch;
    const provider = new OpenAICompatibleProvider('sk-secret', 'm', fetcher, async () => undefined, undefined, 'https://evil.test/v1');
    await expect(provider.review('s', 'u')).rejects.toThrow(/SSRF/);
    expect(inits[0]?.redirect).toBe('manual');
    // ключ и промпт не переезжают на метаданные облака: ровно один запрос,
    // перенаправление не разыгрывается ни в одной попытке
    expect(calls).toBe(1);
    await provider.review('s', 'u').catch((error: unknown) => {
      expect(String(error)).toContain('169.254.169.254');
    });
    expect(calls).toBe(2);
  }, 20000);

  it('opaqueredirect (статус 0 в браузерном fetch) тоже жёстко отклоняется', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, ok: false, redirected: true, headers: new Headers(), text: async () => '' } as unknown as Response;
    const provider = new OpenAICompatibleProvider('k', 'm', (async () => opaque) as typeof fetch, async () => undefined, undefined, 'https://mock.test/v1');
    await expect(provider.review('s', 'u')).rejects.toThrow(/SSRF/);
  }, 20000);

  it('fetchLiveModels и probeLocalServer: redirect:"manual", 3xx = ошибка без повтора на Location', async () => {
    let captured: RequestInit | undefined;
    await fetchLiveModels('https://mock.test/v1', 'k', (async (_url, init) => {
      captured = init;
      return new Response(JSON.stringify({ data: [{ id: 'a' }] }), { status: 200 });
    }) as typeof fetch);
    expect(captured?.redirect).toBe('manual');

    let followCalls = 0;
    await expect(fetchLiveModels('https://mock.test/v1', 'k', (async () => {
      followCalls += 1;
      return new Response('', { status: 301, headers: { location: 'http://169.254.169.254/' } });
    }) as typeof fetch)).rejects.toThrow(/HTTP 301/);
    expect(followCalls).toBe(1);

    let probeInit: RequestInit | undefined;
    const probe = await probeLocalServer('http://localhost:11434', (async (_url, init) => {
      probeInit = init;
      return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-coder' }] }), { status: 200 });
    }) as typeof fetch);
    expect(probeInit?.redirect).toBe('manual');
    expect(probe.ok).toBe(true);
  }, 20000);

  it('2xx/4xx поведение не изменилось: успешный ответ и 401 идут как раньше', async () => {
    let inits: RequestInit[] = [];
    const ok = new OpenAICompatibleProvider('k', 'm', (async (_u, init) => { if (init) inits.push(init); return okResponse(); }) as typeof fetch, async () => undefined, undefined, 'https://mock.test/v1');
    expect(await ok.review('s', 'u')).toBe('{"issues":[]}');
    expect(inits[0]?.redirect).toBe('manual');
    const bad = new OpenAICompatibleProvider('k', 'm', (async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 401 })) as typeof fetch, async () => undefined, undefined, 'https://mock.test/v1');
    await expect(bad.review('s', 'u')).rejects.toBeTruthy();
  }, 20000);
});

describe('батч 17.5: заголовки OpenCode Go', () => {
  it('каждый запрос несёт User-Agent CodeScout/1.5.0', async () => {
    const seen: RequestInit[] = [];
    const provider = new OpenAICompatibleProvider('k', 'm', (async (_u, init) => { if (init) seen.push(init); return okResponse(); }) as typeof fetch, async () => undefined, undefined, 'https://mock.test/v1');
    await provider.review('s', 'u');
    const headers = new Headers(seen[0].headers as HeadersInit);
    expect(headers.get('user-agent')).toBe('CodeScout/1.5.0');
    expect(headers.get('user-agent')).toBe(USER_AGENT);
  }, 20000);

  it('x-opencode-session — UUID v4, стабилен в рамках клиента и уникален между аудитами', async () => {
    const seen: RequestInit[] = [];
    const fetcher = (async (_u: RequestInfo | URL, init?: RequestInit) => { if (init) seen.push(init); return okResponse(); }) as typeof fetch;
    const provider = new OpenAICompatibleProvider('k', 'm', fetcher, async () => undefined, undefined, 'https://mock.test/v1');
    await provider.review('s1', 'u1');
    await provider.review('s2', 'u2');
    const first = new Headers(seen[0].headers as HeadersInit).get('x-opencode-session');
    const second = new Headers(seen[1].headers as HeadersInit).get('x-opencode-session');
    expect(first).toMatch(UUID_RE);
    expect(second).toBe(first);
    // новый клиент = новый скан = новая сессия
    const another = new OpenAICompatibleProvider('k', 'm', fetcher, async () => undefined, undefined, 'https://mock.test/v1');
    expect(another.sessionId).not.toBe(first);
    expect(another.sessionId).toMatch(UUID_RE);
  }, 20000);
});

describe('батч 17.5: автодетект oc_sk_ строго в opencode', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    state.reset();
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-flash' }] }), { status: 200 });
      return okResponse();
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('ключ oc_sk_ при выбранном в селекте gemini сохраняет opencode, а не gemini (e2e через центр)', async () => {
    activate(makeFakeContext() as never);
    await (state.commands.get('codescout.openSettingsPage') as () => Promise<unknown>)();
    await flush();
    const center = state.panels[state.panels.length - 1] as unknown as { webview: { onMessageHandlers: ((message: never) => void)[] } };
    expect(center).toBeDefined();
    center.webview.onMessageHandlers[0]({ command: 'saveKeyProvider', apiKey: 'oc_sk_E2E_123456', providerKey: 'gemini', baseUrl: '' } as never);
    await waitFor(() => state.secrets.get('codescout.provider') === 'opencode');
    expect(state.secrets.get('codescout.apiKey')).toBe('oc_sk_E2E_123456');
    expect(state.secrets.get('codescout.provider')).toBe('opencode');
    expect(state.secrets.get('codescout.model')).toBe('qwen3.8-flash');
  }, 30000);
});

describe('батч 17.5: mailto в панели → openLink → openExternal', () => {
  const realFetch = globalThis.fetch;

  function createView(): { view: unknown; receive: (message: unknown) => void } {
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
    return { view, receive: (message) => handler(message) };
  }

  beforeEach(() => {
    state.reset();
    globalThis.fetch = (async () => { throw new Error('offline in tests'); }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('почта автора и репозиторий проходят whitelist, чужие URL — нет', async () => {
    activate(makeFakeContext() as never);
    const panel = state.providers.get('codescout.panel') as unknown as CodeScoutPanel;
    const { view, receive } = createView();
    panel.resolveWebviewView(view as never);
    receive({ command: 'openLink', url: 'https://evil.example.com/phish' });
    receive({ command: 'openLink', url: 'mailto:attacker@example.com' });
    receive({ command: 'openLink', url: 'https://github.com/malware/other' });
    await flush();
    expect(state.openedUris).toHaveLength(0);
    receive({ command: 'openLink', url: 'mailto:work.valden@gmail.com' });
    receive({ command: 'openLink', url: 'mailto:work.valden@gmail.com?subject=CodeScout%201.5' });
    receive({ command: 'openLink', url: 'https://github.com/valden2007/CodeScout/issues' });
    await waitFor(() => state.openedUris.length === 3);
    const opened = state.openedUris.map((uri) => String((uri as { toString(): string }).toString()));
    expect(opened[0]).toContain('work.valden@gmail.com');
    expect(opened.join(' ')).not.toContain('evil.example.com');
    expect(opened.join(' ')).not.toContain('attacker@example.com');
  }, 20000);

  it('контракт исходников: вебвью перехватывает mailto-клик и шлёт openLink, панель зовёт openExternal', () => {
    const report = readFileSync('extension/src/reportHtml.ts', 'utf8');
    expect(report).toContain('a[href^="mailto:"]');
    expect(report).toContain("vscode.postMessage({ command: 'openLink', url: mail.getAttribute('href') })");
    const panel = readFileSync('extension/src/panel.ts', 'utf8');
    expect(panel).toContain("message.command === 'openLink'");
    expect(panel).toContain('vscode.env.openExternal(vscode.Uri.parse(url))');
  });
});

describe('батч 17.5: модалка «логи будут прикреплены» перед Issue', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    state.reset();
    globalThis.fetch = (async () => { throw new Error('offline in tests'); }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it('без согласия: предупреждение показано, тело Issue не формируется, ссылка не открывается', async () => {
    const formatter = vi.spyOn(reporting, 'buildIssueBody');
    activate(makeFakeContext() as never);
    await (state.commands.get('codescout.reportIssue') as () => Promise<unknown>)();
    await flush();
    expect(state.openedUris).toHaveLength(0);
    expect(formatter).not.toHaveBeenCalled();
    expect(state.warningAnswers).toHaveLength(0); // ответ модалки реально запрошен у пользователя
  }, 20000);

  it('с согласием: issues/new открывается с прикреплёнными (редактированными) логами', async () => {
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    state.warningAnswers.push(t('issue.logsWarnBtn', 'ru'));
    activate(makeFakeContext() as never);
    await (state.commands.get('codescout.reportIssue') as () => Promise<unknown>)();
    await flush();
    expect(state.openedUris).toHaveLength(1);
    const url = String((state.openedUris[0] as { toString(): string }).toString());
    expect(url).toContain('github.com/valden2007/CodeScout/issues/new?body=');
    expect(decodeURIComponent(url.split('body=')[1])).not.toContain('CS_MOCK_KEY_FOR_TESTS');
  }, 20000);

  it('модалка модальная и кнопка — единственный путь продолжить', () => {
    const extension = readFileSync('extension/src/extension.ts', 'utf8');
    expect(extension).toContain("{ modal: true }, t('issue.logsWarnBtn', confirmLang)");
    expect(extension).toContain("if (answer !== t('issue.logsWarnBtn', confirmLang)) return;");
    const ru = JSON.parse(readFileSync('src/i18n/ru.json', 'utf8')) as Record<string, string>;
    expect(ru['issue.logsWarn']).toContain('логи аудита');
    expect(ru['issue.logsWarn']).toContain('Продолжить?');
  });
});
