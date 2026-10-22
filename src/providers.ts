export type ProviderName = 'gemini' | 'groq' | 'openrouter' | 'github' | 'opencode' | 'openai' | 'anthropic' | 'custom';

export interface DetectedProvider {
  provider: ProviderName;
  model: string;
}

export function parseLiveModels(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id : ''))
    .filter((id): id is string => Boolean(id));
}

export function assertHttpBaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Некорректный baseUrl: ${url}. Ожидается https://… (или http:// для localhost/127.0.0.1).`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`baseUrl должен быть http(s)://, получено ${parsed.protocol} (${url})`);
  if (parsed.protocol === 'http:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error(`http:// разрешён только для localhost/127.0.0.1 — ключ утечёт в открытом канале (${url}). Используй https://`);
  }
  return url;
}

// Батч 18.8: у Google AI Studio в OpenAI-адаптере НЕТ роута GET /models —
// живой запрос всегда даёт 404/405. Для gemini не дёргаем сеть, отдаём
// статический список бесплатных/платных моделей endpoint'а.
export const GEMINI_STATIC_MODELS = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash', 'gemini-2.5-flash'];

export function isGeminiBaseUrl(url: string): boolean {
  return /:\/\/(generativelanguage\.googleapis\.com|aistudio\.googleapis\.com)(:|\/|$)/i.test(url);
}

export async function fetchLiveModels(baseUrl: string, apiKey: string, fetcher: typeof fetch = fetch, timeoutMs = 5000): Promise<string[]> {
  const safeBase = assertHttpBaseUrl(baseUrl.replace(/\/+$/, ''));
  // Перехват gemini ДО любого HTTP: /models у Google нет — падать/висеть
  // не на чем, сразу resolve со статическим списком.
  if (isGeminiBaseUrl(safeBase)) return [...GEMINI_STATIC_MODELS];
  const response = await fetcher(`${safeBase}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    // Зависший сервер не должен делать настройку бесконечной (батч 13, п.3)
    signal: AbortSignal.timeout(timeoutMs),
    // Батч 17.5 (SSRF): Authorization не уезжает по 3xx-редиректу на
    // внутренние адреса облака — переходы запрещены, 3xx = ошибка.
    redirect: 'manual'
  });
  if (!response.ok) throw new Error(`Не удалось получить список моделей: HTTP ${response.status}`);
  return parseLiveModels(await response.json());
}

// Локальный режим (батч 13, п.2): localhost-серверы (Ollama, LM Studio) не
// требуют ключа — код не покидает машину, аутентификации нет.
export function isLocalBaseUrl(url: string | undefined): boolean {
  const value = url?.trim() || '';
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(value);
}

export function parseOllamaTags(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models
    .map((item) => (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string' ? (item as { name: string }).name : ''))
    .filter((name): name is string => Boolean(name));
}

export type ProbeStatus = 'ok' | 'noAnswer' | 'error';

export interface LocalProbeResult {
  ok: boolean;
  status: ProbeStatus;
  /** Нормализованный OpenAI-совместимый base URL (всегда с /v1 при успехе). */
  baseUrl: string;
  models: string[];
  message: string;
}

// Проверка доступности локального OpenAI-совместимого сервера (батч 13, п.2):
// Ollama отдаёт список моделей нативно через /api/tags, LM Studio — через /v1/models.
export async function probeLocalServer(rawUrl: string, fetcher: typeof fetch = fetch, timeoutMs = 5000): Promise<LocalProbeResult> {
  const base = rawUrl.trim().replace(/\/+$/, '');
  if (!base) return { ok: false, status: 'error', baseUrl: '', models: [], message: 'URL не задан' };
  const openAiUrl = base.endsWith('/v1') ? base : `${base}/v1`;
  const ollamaTagsUrl = base.endsWith('/v1') ? `${base.slice(0, -3)}/api/tags` : `${base}/api/tags`;
  const probe = async (url: string): Promise<Response> => fetcher(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  try {
    // LM Studio / OpenAI-совместимые: GET {base}/models
    const direct = await probe(`${openAiUrl}/models`);
    if (direct.ok) return { ok: true, status: 'ok', baseUrl: openAiUrl, models: parseLiveModels(await direct.json()), message: '' };
    // Ollama native: GET {base}/api/tags → {models:[{name}]}
    const tags = await probe(`${base}/api/tags`);
    if (tags.ok) {
      const models = parseOllamaTags(await tags.json());
      return { ok: true, status: 'ok', baseUrl: openAiUrl, models, message: '' };
    }
    return { ok: false, status: 'error', baseUrl: openAiUrl, models: [], message: `HTTP ${direct.status}/${tags.status}` };
  } catch (error) {
    // таймаут (TimeoutError), отказ в соединении, DNS — сервер не ответил
    return { ok: false, status: 'noAnswer', baseUrl: openAiUrl, models: [], message: error instanceof Error ? error.message : String(error) };
  }
}

export interface ProviderDefinition {
  baseUrl: string;
  envKey: string;
  defaultModel: string;
  keyUrl: string;
}

// Батч 18: жёсткий порядок отображения в UI (селект центра, quickPick, wizard).
// Системный 'auto' из списка СКРЫТ: автодетект по префиксу ключа работает
// под капотом в saveKeyProvider/setApiKey. openrouter остаётся рабочим
// (sk-or- детект, env-ключ), но из витрины убран.
export const PROVIDER_ORDER: ProviderName[] = ['custom', 'openai', 'anthropic', 'opencode', 'gemini', 'groq', 'github'];

export const PROVIDERS: Record<Exclude<ProviderName, 'custom'>, ProviderDefinition> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  // OpenAI-совместимый эндпоинт Anthropic (/v1/chat/completions, beta).
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    envKey: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-3-5-haiku-latest',
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  // Батч 16: OpenCode Go — подписочный шлюз opencode.ai с OpenAI-совместимым
  // эндпоинтом /zen/go/v1; ключи начинаются с oc_sk_ (zero-config автовыбор).
  opencode: {
    baseUrl: 'https://opencode.ai/zen/go/v1',
    envKey: 'OPENCODE_GO_API_KEY',
    defaultModel: 'qwen3.8-flash',
    keyUrl: 'https://opencode.ai/auth'
  },
  gemini: {
    // Батч 18.5: OpenAI-совместимый эндпоинт Google живёт на /v1beta/openai/v1 —
    // с этим суффиксом клиентские пути {base}/models и {base}/chat/completions
    // попадают в реальные роуты и автозагрузка списка моделей работает.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/v1',
    envKey: 'GEMINI_API_KEY',
    // Батч 18: 2.5 может отсутствовать в free-tier — дефолт 1.5-flash.
    defaultModel: 'gemini-1.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey'
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com'
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    defaultModel: 'openai/gpt-4o-mini',
    keyUrl: 'https://openrouter.ai/keys'
  },
  github: {
    baseUrl: 'https://models.inference.ai.azure.com',
    envKey: 'GITHUB_TOKEN',
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://github.com/settings/tokens'
  }
};

export function detectProvider(key: string): DetectedProvider | null {
  const value = key.trim();
  // Батч 17.5: oc_sk_ проверяется первым и строго — ключ OpenCode Go обязан
  // давать opencode, никаких соскальзываний на дефолты списка.
  if (value.startsWith('oc_sk_')) return { provider: 'opencode', model: 'qwen3.8-flash' };
  if (value.startsWith('gsk_')) return { provider: 'groq', model: 'llama-3.3-70b-versatile' };
  if (value.startsWith('AIza') || value.startsWith('AQ.')) return { provider: 'gemini', model: 'gemini-1.5-flash' };
  // Батч 18: длинные sk-префиксы раньше голого sk- (иначе openrouter/anthropic
  // схлопнулись бы в openai).
  if (value.startsWith('sk-or-')) return { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' };
  if (value.startsWith('sk-ant-')) return { provider: 'anthropic', model: 'claude-3-5-haiku-latest' };
  if (value.startsWith('ghp_') || value.startsWith('github_pat_')) return { provider: 'github', model: 'gpt-4o-mini' };
  if (value.startsWith('sk-')) return { provider: 'openai', model: 'gpt-4o-mini' };
  return null;
}

export function normalizeProvider(provider?: string): ProviderName {
  const value = provider?.trim().toLowerCase() || 'gemini';
  if (value === 'custom') return 'custom';
  if (Object.hasOwn(PROVIDERS, value)) return value as Exclude<ProviderName, 'custom'>;
  throw new Error(`Неизвестный provider: ${provider}. Используй custom, openai, anthropic, opencode, gemini, groq, github или openrouter.`);
}

export function resolveApiKey(provider: string, explicitKey?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (explicitKey?.trim()) return explicitKey.trim();
  const normalized = normalizeProvider(provider);
  if (normalized === 'custom') return env.CODESCOUT_API_KEY?.trim();
  return env[PROVIDERS[normalized].envKey]?.trim();
}

// Батч 17: строго secret > env. Чтение ключа из plaintext settings.json
// полностью удалено — единственный путь для расширения это
// context.secrets (SecretStorage), для CLI/action — env/Secrets.
export function resolveApiKeyPriority(secretKey: string | undefined, provider: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return secretKey?.trim() || resolveApiKey(provider, undefined, env) || undefined;
}

export function resolveBaseUrl(provider: string, customBaseUrl?: string): string {
  if (customBaseUrl?.trim()) {
    const url = customBaseUrl.trim().replace(/\/+$/, '');
    assertHttpBaseUrl(url);
    return url;
  }
  const normalized = normalizeProvider(provider);
  if (normalized === 'custom') throw new Error('Для provider custom укажи --base-url или CODESCOUT_BASE_URL.');
  return PROVIDERS[normalized].baseUrl;
}

export function defaultModel(provider?: string): string {
  const normalized = normalizeProvider(provider);
  return normalized === 'custom' ? '' : PROVIDERS[normalized].defaultModel;
}

export function keyUrl(provider: string): string | undefined {
  const normalized = normalizeProvider(provider);
  return normalized === 'custom' ? undefined : PROVIDERS[normalized].keyUrl;
}

export function completionUrl(baseUrl: string): string {
  // не полагаться на вызывающий код: file:// или мусор не должны
  // превращаться в endpoint провайдера
  const normalized = assertHttpBaseUrl(baseUrl);
  return `${normalized.replace(/\/+$/, '')}/chat/completions`;
}

export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 3) return '•••';
  const prefix = trimmed.length >= 7 ? trimmed.slice(0, 4) : '';
  return `${prefix}•••${trimmed.slice(-3)}`;
}
