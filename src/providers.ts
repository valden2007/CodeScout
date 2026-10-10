export type ProviderName = 'gemini' | 'groq' | 'openrouter' | 'github' | 'custom';

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

export async function fetchLiveModels(baseUrl: string, apiKey: string, fetcher: typeof fetch = fetch, timeoutMs = 5000): Promise<string[]> {
  const safeBase = assertHttpBaseUrl(baseUrl.replace(/\/+$/, ''));
  const response = await fetcher(`${safeBase}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    // Зависший сервер не должен делать настройку бесконечной (батч 13, п.3)
    signal: AbortSignal.timeout(timeoutMs)
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
  const probe = async (url: string): Promise<Response> => fetcher(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
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

export const PROVIDERS: Record<Exclude<ProviderName, 'custom'>, ProviderDefinition> = {
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-flash',
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
  if (value.startsWith('gsk_')) return { provider: 'groq', model: 'llama-3.3-70b-versatile' };
  if (value.startsWith('AIza') || value.startsWith('AQ.')) return { provider: 'gemini', model: 'gemini-2.5-flash' };
  if (value.startsWith('sk-or-')) return { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' };
  if (value.startsWith('ghp_') || value.startsWith('github_pat_')) return { provider: 'github', model: 'gpt-4o-mini' };
  return null;
}

export function normalizeProvider(provider?: string): ProviderName {
  const value = provider?.trim().toLowerCase() || 'gemini';
  if (value === 'custom') return 'custom';
  if (Object.hasOwn(PROVIDERS, value)) return value as Exclude<ProviderName, 'custom'>;
  throw new Error(`Неизвестный provider: ${provider}. Используй gemini, groq, openrouter, github или custom.`);
}

export function resolveApiKey(provider: string, explicitKey?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (explicitKey?.trim()) return explicitKey.trim();
  const normalized = normalizeProvider(provider);
  if (normalized === 'custom') return env.CODESCOUT_API_KEY?.trim();
  return env[PROVIDERS[normalized].envKey]?.trim();
}

export function resolveApiKeyPriority(secretKey: string | undefined, provider: string, legacySetting: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return secretKey?.trim() || resolveApiKey(provider, undefined, env) || legacySetting?.trim() || undefined;
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
