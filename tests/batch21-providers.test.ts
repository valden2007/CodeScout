// Батч 21: топ-12 zero-config OpenAI-совместимых провайдеров, развилка
// QuickPick для неоднозначного `sk-` и неубиваемый fetchLiveModels.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate } from '../extension/src/extension';
import {
  completionUrl,
  defaultModel,
  detectProvider,
  fetchLiveModels,
  keyUrl,
  normalizeProvider,
  PROVIDER_ORDER,
  resolveApiKey,
  resolveBaseUrl,
  SK_AMBIGUOUS_OPTIONS
} from '../src/providers';

describe('батч 21: автодетект по префиксу ключа', () => {
  it('строгие префиксы: gsk_ → groq, sk-or- → openrouter, sk-ant- → anthropic, AIza → gemini, ghp_/github_pat_ → github', () => {
    expect(detectProvider('gsk_ABC123def')).toEqual({ provider: 'groq', model: 'llama-3.3-70b-versatile' });
    expect(detectProvider('sk-or-v1-9f2c')).toEqual({ provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' });
    expect(detectProvider('sk-ant-api03-xyz')).toEqual({ provider: 'anthropic', model: 'claude-3-5-haiku-latest' });
    expect(detectProvider('AIzaSyD-test')).toEqual({ provider: 'gemini', model: 'gemini-1.5-flash' });
    expect(detectProvider('ghp_1234567890')).toEqual({ provider: 'github', model: 'gpt-4o-mini' });
    expect(detectProvider('github_pat_11ABCDEFG')).toEqual({ provider: 'github', model: 'gpt-4o-mini' });
    // nvapi- — строгий префикс NVIDIA NIM (батч 21, бонусом к провайдеру nvidia)
    expect(detectProvider('nvapi-abcdef')).toEqual({ provider: 'nvidia', model: 'meta-llama/llama-3.1-70b-instruct' });
  });

  it('краевой sk-: голое sk- — догадка с ambiguous=true, sk-proj- — явный OpenAI без гадалки', () => {
    const guess = detectProvider('sk-abc123');
    expect(guess).not.toBeNull();
    expect(guess?.provider).toBe('openai');
    expect(guess?.ambiguous).toBe(true);
    // sk-proj- — формат project-ключей OpenAI: здесь гадать не нужно
    expect(detectProvider('sk-proj-xyz')).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(detectProvider('sk-proj-xyz')?.ambiguous).toBeUndefined();
    // строгие длинные префиксы не помечаются ambiguous
    expect(detectProvider('sk-or-v1-abc')?.ambiguous).toBeUndefined();
    expect(detectProvider('sk-ant-api03-abc')?.ambiguous).toBeUndefined();
    expect(detectProvider('unknown-key')).toBeNull();
  });

  it('список развилки sk- = OpenAI, DeepSeek, Together AI, SambaNova, SiliconFlow, Hyperbolic, Cerebras, Custom', () => {
    expect(SK_AMBIGUOUS_OPTIONS.map((option) => option.label)).toEqual([
      'OpenAI', 'DeepSeek', 'Together AI', 'SambaNova', 'SiliconFlow', 'Hyperbolic', 'Cerebras', 'Custom'
    ]);
    expect(SK_AMBIGUOUS_OPTIONS.map((option) => option.provider)).toEqual([
      'openai', 'deepseek', 'together', 'sambanova', 'siliconflow', 'hyperbolic', 'cerebras', 'custom'
    ]);
    // все метки резолвятся: не-custom — готовые эндпоинты, custom — требует baseUrl (по контракту)
    for (const option of SK_AMBIGUOUS_OPTIONS) {
      expect(() => normalizeProvider(option.provider)).not.toThrow();
      if (option.provider === 'custom') expect(() => resolveBaseUrl('custom')).toThrow(/base-url/i);
      else expect(resolveBaseUrl(option.provider)).toMatch(/^https:\/\//);
    }
  });
});

describe('батч 21: конфигурация топ-12 провайдеров', () => {
  it('baseUrl ровно по спецификации продукта', () => {
    expect(resolveBaseUrl('groq')).toBe('https://api.groq.com/openai/v1');
    expect(resolveBaseUrl('openrouter')).toBe('https://openrouter.ai/api/v1');
    expect(resolveBaseUrl('deepseek')).toBe('https://api.deepseek.com/v1');
    expect(resolveBaseUrl('together')).toBe('https://api.together.xyz/v1');
    expect(resolveBaseUrl('sambanova')).toBe('https://api.sambanova.ai/v1');
    expect(resolveBaseUrl('siliconflow')).toBe('https://api.siliconflow.cn/v1');
    expect(resolveBaseUrl('nvidia')).toBe('https://integrate.api.nvidia.com/v1');
    expect(resolveBaseUrl('hyperbolic')).toBe('https://api.hyperbolic.xyz/v1');
    expect(resolveBaseUrl('cerebras')).toBe('https://api.cerebras.ai/v1');
    expect(resolveBaseUrl('github')).toBe('https://models.inference.ai.azure.com');
  });

  it('каждый новый провайдер подключен полностью: env, дефолт-модель, keyUrl, chat/completions', () => {
    const envToProvider: [string, string][] = [
      ['DEEPSEEK_API_KEY', 'deepseek'],
      ['TOGETHER_API_KEY', 'together'],
      ['SAMBANOVA_API_KEY', 'sambanova'],
      ['SILICONFLOW_API_KEY', 'siliconflow'],
      ['NVIDIA_API_KEY', 'nvidia'],
      ['HYPERBOLIC_API_KEY', 'hyperbolic'],
      ['CEREBRAS_API_KEY', 'cerebras']
    ];
    for (const [envKey, provider] of envToProvider) {
      expect(normalizeProvider(provider)).toBe(provider);
      expect(resolveApiKey(provider, undefined, { [envKey]: 'k-env' })).toBe('k-env');
      expect(defaultModel(provider)).toBeTruthy();
      expect(keyUrl(provider)).toMatch(/^https:\/\//);
      expect(completionUrl(resolveBaseUrl(provider))).toBe(`${resolveBaseUrl(provider)}/chat/completions`);
    }
  });

  it('витрина PROVIDER_ORDER включает новых, openrouter остаётся за витриной', () => {
    for (const provider of ['deepseek', 'together', 'sambanova', 'siliconflow', 'nvidia', 'hyperbolic', 'cerebras']) {
      expect(PROVIDER_ORDER).toContain(provider);
    }
    expect(PROVIDER_ORDER).not.toContain('openrouter');
    // старый порядок первых семи не тронут
    expect(PROVIDER_ORDER.slice(0, 7)).toEqual(['custom', 'openai', 'anthropic', 'opencode', 'gemini', 'groq', 'github']);
  });

  it('normalizeProvider знает новых; ошибка перечисляет список', () => {
    expect(() => normalizeProvider('bogus')).toThrow('Неизвестный provider');
    expect(() => normalizeProvider('bogus')).toThrow('deepseek');
  });
});

describe('батч 21: универсальный неубиваемый fetchLiveModels', () => {
  it('GET {baseUrl}/models + Authorization Bearer для OpenAI-совместимых платформ', async () => {
    const seen: { url: string; auth: string | null; redirect: unknown }[] = [];
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
      return new Response(JSON.stringify({ data: [{ id: 'm-one' }, { id: 'm-two' }] }), { status: 200 });
    }) as typeof fetch;
    for (const provider of ['groq', 'deepseek', 'together', 'sambanova', 'siliconflow', 'nvidia', 'hyperbolic', 'cerebras', 'openrouter', 'github']) {
      const models = await fetchLiveModels(resolveBaseUrl(provider), 'k-test', fetcher, 5000, provider, () => undefined);
      expect(models).toEqual(['m-one', 'm-two']);
    }
    expect(seen.length).toBe(10);
    expect(seen[0].url).toBe('https://api.groq.com/openai/v1/models');
    expect(seen[1].url).toBe('https://api.deepseek.com/v1/models');
    for (const request of seen) {
      expect(request.auth).toBe('Bearer k-test');
      expect(request.redirect).toBe('manual');
    }
  });

  it('401/404/битый JSON/таймаут при tolerateErrors — тихо [], UI не падает', async () => {
    const warnings: string[] = [];
    await expect(fetchLiveModels('https://api.deepseek.com/v1', 'k', async () => new Response('{"error":{}}', { status: 401 }), 5000, 'deepseek', (m) => warnings.push(m), true)).resolves.toEqual([]);
    await expect(fetchLiveModels('https://api.together.xyz/v1', 'k', async () => new Response('', { status: 404 }), 5000, 'together', () => undefined, true)).resolves.toEqual([]);
    await expect(fetchLiveModels('https://api.cerebras.ai/v1', 'k', async () => { throw new Error('connection reset'); }, 5000, 'cerebras', () => undefined, true)).resolves.toEqual([]);
    await expect(fetchLiveModels('https://api.groq.com/openai/v1', 'k', async () => new Response('не json', { status: 200 }), 5000, 'groq', () => undefined, true)).resolves.toEqual([]);
    const hang = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')), { once: true });
    });
    await expect(fetchLiveModels('https://api.hyperbolic.xyz/v1', 'k', hang, 100, 'hyperbolic', () => undefined, true)).resolves.toEqual([]);
    expect(warnings.some((line) => line.includes('deepseek') && line.includes('/models'))).toBe(true);
  });

  it('строгий режим (без tolerateErrors) сохранён: 401 летит наружу — контракт теста подключения', async () => {
    await expect(fetchLiveModels('https://mock.test/v1', 'k', async () => new Response('', { status: 401 }), 5000)).rejects.toThrow(/HTTP 401/);
    await expect(fetchLiveModels('https://api.deepseek.com/v1', 'k', async () => new Response('', { status: 401 }), 5000, 'deepseek', () => undefined)).rejects.toThrow(/HTTP 401/);
    // битый baseUrl валидируется строго всегда
    await expect(fetchLiveModels('http://evil.example/v1', 'k', async () => { throw new Error('must not be called'); }, 5000, 'deepseek', () => undefined, true)).rejects.toThrow(/http/);
  });
});

describe('батч 21 e2e: развилка sk- в codescout.setApiKey (vscode-stub)', () => {
  const realFetch = globalThis.fetch;

  function mockModels(models: string[]): { urls: string[]; auths: (string | null)[] } {
    const urls: string[] = [];
    const auths: (string | null)[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(url));
      auths.push(new Headers(init?.headers).get('authorization'));
      return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 });
    }) as typeof fetch;
    return { urls, auths };
  }

  beforeEach(() => { state.reset(); });
  afterEach(() => { globalThis.fetch = realFetch; });

  async function runSetApiKey(): Promise<void> {
    activate(makeFakeContext() as never);
    await flush();
    const handler = state.commands.get('codescout.setApiKey');
    expect(handler).toBeDefined();
    await handler!();
    await flush();
  }

  it('неоднозначный sk- вызывает QuickPick со списком платформ; выбор DeepSeek сохраняет связку', async () => {
    const net = mockModels(['deepseek-chat', 'deepseek-reasoner']);
    state.inputBoxAnswers = ['sk-abc123def456'];
    state.quickPickAnswers = [{ label: 'DeepSeek' }];
    await runSetApiKey();
    // первое меню — именно развилка sk-, а не общий PROVIDER_ORDER
    const items = state.quickPickCalls[0]?.[0] as { label: string }[];
    expect(items.map((item) => item.label)).toEqual(['OpenAI', 'DeepSeek', 'Together AI', 'SambaNova', 'SiliconFlow', 'Hyperbolic', 'Cerebras', 'Custom']);
    expect(state.secrets.get('codescout.provider')).toBe('deepseek');
    expect(state.secrets.get('codescout.model')).toBe('deepseek-chat');
    expect(state.secrets.get('codescout.apiKey')).toBe('sk-abc123def456');
    expect(net.urls).toContain('https://api.deepseek.com/v1/models');
    expect(net.auths[net.urls.indexOf('https://api.deepseek.com/v1/models')]).toBe('Bearer sk-abc123def456');
  });

  it('отмена меню sk- = ничего не сохранено (возврат без действия)', async () => {
    mockModels(['x']);
    state.inputBoxAnswers = ['sk-abc123def456'];
    state.quickPickAnswers = [undefined];
    await runSetApiKey();
    expect(state.quickPickCalls.length).toBe(1);
    expect(state.secrets.get('codescout.apiKey')).toBeUndefined();
    expect(state.secrets.get('codescout.provider')).toBeUndefined();
  });

  it('строгий gsk_ по-прежнему летит в groq без всякого меню', async () => {
    mockModels(['llama-3.3-70b-versatile']);
    state.inputBoxAnswers = ['gsk_strict123'];
    await runSetApiKey();
    expect(state.quickPickCalls.length).toBe(0);
    expect(state.secrets.get('codescout.provider')).toBe('groq');
    expect(state.secrets.get('codescout.model')).toBe('llama-3.3-70b-versatile');
  });

  it('падение /models (401) не роняет setApiKey: ключ сохранён, модель спросим вручную', async () => {
    globalThis.fetch = (async () => new Response('{"error":{"message":"invalid api key"}}', { status: 401 })) as typeof fetch;
    state.inputBoxAnswers = ['gsk_key', 'custom-model-v1'];
    // меню развилки нет (gsk_ строгий); validateDefaultModel при [] зовёт
    // showInputBox за ручным вводом — второй ответ очереди.
    await runSetApiKey();
    expect(state.secrets.get('codescout.apiKey')).toBe('gsk_key');
    expect(state.secrets.get('codescout.provider')).toBe('groq');
  });
});
