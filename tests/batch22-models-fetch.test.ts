// Батч 22: фикс получения списка моделей — таймаут 10с, санитизация ключа
// в одной точке, Accept: application/json, категоризация редиректов при
// redirect:'manual' (SSRF-замок не трогаем), кэш списков TTL 10 минут,
// состояние «Загружаем модели…» в центре настроек.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';
import { t } from '../src/i18n';
import { OpenAICompatibleProvider } from '../src/llm-client';
import {
  clearModelsCache,
  fetchLiveModels,
  fetchLiveModelsCached,
  GEMINI_MODELS_TIMEOUT_MS,
  GEMINI_STATIC_MODELS,
  MODELS_CACHE_TTL_MS,
  MODELS_FETCH_TIMEOUT_MS,
  sanitizeApiKey
} from '../src/providers';

const okList = (ids: string[]) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });

describe('батч 22 п.1: таймауты', () => {
  it('константы: общий таймаут /models 10000мс, потолок Gemini 10000мс, TTL кэша 10 минут', () => {
    expect(MODELS_FETCH_TIMEOUT_MS).toBe(10000);
    expect(GEMINI_MODELS_TIMEOUT_MS).toBe(10000);
    expect(MODELS_CACHE_TTL_MS).toBe(600000);
  });
});

describe('батч 22 п.2: санитизация ключа и заголовки', () => {
  it('sanitizeApiKey: пробелы/переносы/окружающие кавычки убираются', () => {
    expect(sanitizeApiKey('  gsk_abc\n')).toBe('gsk_abc');
    expect(sanitizeApiKey('\r\nsk-123 \t')).toBe('sk-123');
    expect(sanitizeApiKey('"sk-123"')).toBe('sk-123');
    expect(sanitizeApiKey("'gsk_x'")).toBe('gsk_x');
    expect(sanitizeApiKey('`sk-q`')).toBe('sk-q');
    expect(sanitizeApiKey(' "sk-in-out" ')).toBe('sk-in-out');
    expect(sanitizeApiKey('')).toBe('');
  });

  it('/models: в Authorization уходит trimmed-ключ, есть Accept: application/json, redirect manual сохранён', async () => {
    let capturedInit: RequestInit | undefined;
    await fetchLiveModels('https://api.groq.com/openai/v1', '\n  gsk_with_spaces  \n', (async (_url, init) => {
      capturedInit = init;
      return okList(['m1']);
    }) as typeof fetch, 5000, 'groq', () => undefined);
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer gsk_with_spaces');
    expect(headers.get('accept')).toBe('application/json');
    expect(capturedInit?.redirect).toBe('manual');
    expect(capturedInit?.signal).not.toBeNull();
  });

  it('review-запрос использует ту же санитизацию (одна точка)', async () => {
    const seen: RequestInit[] = [];
    const provider = new OpenAICompatibleProvider('  "sk-padded"\n ', 'm', (async (_u, init) => {
      if (init) seen.push(init);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[]}' } }] }), { status: 200 });
    }) as typeof fetch, async () => undefined, undefined, 'https://mock.test/v1');
    await provider.review('s', 'u');
    expect(new Headers(seen[0].headers).get('authorization')).toBe('Bearer sk-padded');
  });
});

describe('батч 22 п.3: сбои /models без смены redirect-политики', () => {
  it('3xx: категоризированная ошибка «ответил редиректом», сеть дёрнута ровно 1 раз, Location не разыгрывается', async () => {
    let calls = 0;
    let initSeen: RequestInit | undefined;
    const fetcher = (async (_url, init) => {
      calls += 1;
      initSeen = init;
      return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } });
    }) as typeof fetch;
    await expect(fetchLiveModels('https://custom.test/v1', 'k', fetcher, 5000, 'custom')).rejects.toThrow(/ответил редиректом.*HTTP 302/);
    expect(calls).toBe(1);
    expect(initSeen?.redirect).toBe('manual');
  });

  it('3xx при tolerateErrors — фолбэк [] + warning с категорией (UI уйдёт в ручной ввод)', async () => {
    const warnings: string[] = [];
    let calls = 0;
    const models = await fetchLiveModels('https://api.deepseek.com/v1', 'k', async () => {
      calls += 1;
      return new Response('', { status: 301, headers: { location: 'https://evil.test/' } });
    }, 5000, 'deepseek', (m) => warnings.push(m), true);
    expect(models).toEqual([]);
    expect(calls).toBe(1);
    expect(warnings.join('\n')).toContain('редиректом');
  });

  it('таймаут: gemini — статика; новая платформа — пустой список; в метрике есть длительность и байты, ключа нет', async () => {
    const hang = (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const warnings: string[] = [];
    const gemini = await fetchLiveModels('https://mock.test/v1', 'k', hang as typeof fetch, 150, 'gemini', (m) => warnings.push(m));
    expect(gemini).toEqual([...GEMINI_STATIC_MODELS]);
    const metrics: string[] = [];
    const deepseek = await fetchLiveModels('https://api.deepseek.com/v1', 'k-secret-не-в-логи', hang as typeof fetch, 150, 'deepseek', () => undefined, true, (m) => metrics.push(m));
    expect(deepseek).toEqual([]);
    expect(metrics.join('\n')).toMatch(/deepseek GET \/models: \d+ мс, \d+ байт/);
    expect(metrics.join('\n')).not.toContain('k-secret-не-в-логи');
  });

  it('успешный ответ: метрика с размером тела в байтах и числом моделей', async () => {
    const metrics: string[] = [];
    await fetchLiveModels('https://api.groq.com/openai/v1', 'k', async () => okList(['a', 'b']), 5000, 'groq', () => undefined, false, (m) => metrics.push(m));
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatch(/⏱ groq GET \/models: \d+ мс, \d+ байт, HTTP 200, моделей 2/);
  });
});

describe('батч 22 п.1: кэш живых списков моделей (TTL 10 минут)', () => {
  beforeEach(() => { clearModelsCache(); });

  it('второй вызов в пределах TTL не дёргает сеть; пустой ответ не кэшируется', async () => {
    let calls = 0;
    const fetcher = (async () => { calls += 1; return okList(['m1', 'm2']); }) as typeof fetch;
    const first = await fetchLiveModelsCached('https://api.deepseek.com/v1', 'k-cache', fetcher, 5000, 'deepseek', () => undefined, true);
    const second = await fetchLiveModelsCached('https://api.deepseek.com/v1', 'k-cache', fetcher, 5000, 'deepseek', () => undefined, true);
    expect(first).toEqual(['m1', 'm2']);
    expect(second).toEqual(['m1', 'm2']);
    expect(calls).toBe(1);
    // копия, а не ссылка: мутация результата не отравляет кэш
    second.push('mutate');
    const third = await fetchLiveModelsCached('https://api.deepseek.com/v1', 'k-cache', fetcher, 5000, 'deepseek', () => undefined, true);
    expect(third).toEqual(['m1', 'm2']);
    // ошибка (пустой список) — в сеть снова, в кэш не пишется
    const boom = (async () => { throw new Error('401'); }) as typeof fetch;
    await expect(fetchLiveModelsCached('https://api.together.xyz/v1', 'k-err', boom, 5000, 'together', () => undefined, true)).resolves.toEqual([]);
    await expect(fetchLiveModelsCached('https://api.together.xyz/v1', 'k-err', boom, 5000, 'together', () => undefined, true)).resolves.toEqual([]);
  });

  it('TTL истёк — сеть снова дёргается', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetcher = (async () => { calls += 1; return okList(['m1']); }) as unknown as typeof fetch;
      const base = Date.parse('2026-01-01T00:00:00Z');
      vi.setSystemTime(base);
      await fetchLiveModelsCached('https://api.groq.com/openai/v1', 'k-ttl', fetcher, 5000, 'groq', () => undefined, true);
      await fetchLiveModelsCached('https://api.groq.com/openai/v1', 'k-ttl', fetcher, 5000, 'groq', () => undefined, true);
      expect(calls).toBe(1);
      vi.setSystemTime(base + MODELS_CACHE_TTL_MS + 1);
      await fetchLiveModelsCached('https://api.groq.com/openai/v1', 'k-ttl', fetcher, 5000, 'groq', () => undefined, true);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('строгий режим (tolerateErrors=false — тест подключения) кэш не читает и не пишет', async () => {
    let calls = 0;
    const fetcher = (async () => { calls += 1; return okList(['fresh']); }) as typeof fetch;
    await fetchLiveModelsCached('https://api.cerebras.ai/v1', 'k-strict', fetcher, 5000, 'cerebras', () => undefined, false);
    await fetchLiveModelsCached('https://api.cerebras.ai/v1', 'k-strict', fetcher, 5000, 'cerebras', () => undefined, false);
    expect(calls).toBe(2);
    // и из tolerate-вызова после strict-двух — сеть тоже дёрнется (strict не нагрел кэш)
    await fetchLiveModelsCached('https://api.cerebras.ai/v1', 'k-strict', fetcher, 5000, 'cerebras', () => undefined, true);
    expect(calls).toBe(3);
  });
});

describe('батч 22 п.1 e2e: «Загружаем модели…» в центре настроек + подсказка при фолбэке (vscode-stub)', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { state.reset(); clearModelsCache(); });
  afterEach(() => { globalThis.fetch = realFetch; });

  function bootAndOpenCenter(): { send: (message: Record<string, unknown>) => void; messages: () => Record<string, unknown>[] } {
    activate(makeFakeContext() as never);
    void (state.commands.get('codescout.openSettingsPage') as () => Promise<unknown>)();
    const panel = state.panels[state.panels.length - 1] as unknown as { webview: { messages: Record<string, unknown>[]; onMessageHandlers: ((message: never) => void)[] } };
    return {
      send: (message) => panel.webview.onMessageHandlers[0](message as never),
      messages: () => panel.webview.messages
    };
  }

  it('chooseModel: до fetch — modelsBusy true с переводом «Загружаем модели…», после — false', async () => {
    globalThis.fetch = (async () => okList(['model-a'])) as typeof fetch;
    state.secrets.set('codescout.apiKey', 'gsk_busy_e2e');
    state.secrets.set('codescout.provider', 'groq');
    state.secrets.set('codescout.model', 'x');
    const center = bootAndOpenCenter();
    state.quickPickAnswers.push('model-a');
    await (state.commands.get('codescout.chooseModel') as () => Promise<unknown>)();
    await flush();
    const busyMessages = center.messages().filter((message) => message.type === 'modelsBusy');
    expect(busyMessages.length).toBeGreaterThanOrEqual(2);
    expect(busyMessages[0].busy).toBe(true);
    expect(busyMessages[0].label).toBe(t('models.loading', 'ru'));
    expect(busyMessages[busyMessages.length - 1].busy).toBe(false);
    expect(state.secrets.get('codescout.model')).toBe('model-a');
    // диагностика fetch: длительность и байты в Output, ключ — никогда
    expect(state.outputLines.some((line) => /⏱ groq GET \/models: \d+ мс, \d+ байт/.test(line))).toBe(true);
    expect(state.outputLines.join('\n')).not.toContain('gsk_busy_e2e');
  });

  it('401 при выборе моделей: UI не падает, показан input с подсказкой ручного ввода', async () => {
    globalThis.fetch = (async () => new Response('{"error":{}}', { status: 401 })) as typeof fetch;
    state.secrets.set('codescout.apiKey', 'CS_B22_H401');
    state.secrets.set('codescout.provider', 'custom');
    state.secrets.set('codescout.model', 'keep-me');
    state.set('codescout.baseUrl', 'https://mock.test/v1');
    bootAndOpenCenter();
    await (state.commands.get('codescout.chooseModel') as () => Promise<unknown>)();
    await flush();
    expect(state.inputBoxCalls.length).toBeGreaterThan(0);
    const prompt = String((state.inputBoxCalls[0][0] as { prompt?: string }).prompt ?? '');
    expect(prompt).toBe(t('model.inputEmpty', 'ru'));
    expect(state.secrets.get('codescout.model')).toBe('keep-me');
  });

  it('контракт разметки центра: обработчик modelsBusy + перевод вшиты в UI-словарь вебвью', () => {
    const center = readFileSync('extension/src/settingsHtml.ts', 'utf8');
    expect(center).toContain("data.type === 'modelsBusy'");
    expect(center).toContain("providerSelect.disabled = busy");
    expect(center).toContain("'models.loading'");
    const ru = JSON.parse(readFileSync('src/i18n/ru.json', 'utf8')) as Record<string, string>;
    const en = JSON.parse(readFileSync('src/i18n/en.json', 'utf8')) as Record<string, string>;
    expect(ru['models.loading']).toBe('Загружаем модели…');
    expect(en['models.loading']).toBe('Loading models…');
    expect(en['audit.requestTimeoutHint']).toContain('wait 10s');
    expect(ru['audit.requestTimeoutHint']).toContain('ждут 10 с');
  });
});
