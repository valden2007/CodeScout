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

export async function fetchLiveModels(baseUrl: string, apiKey: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const safeBase = assertHttpBaseUrl(baseUrl.replace(/\/+$/, ''));
  const response = await fetcher(`${safeBase}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) throw new Error(`Не удалось получить список моделей: HTTP ${response.status}`);
  return parseLiveModels(await response.json());
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

export function keyUrl(provider: string): string {
  const normalized = normalizeProvider(provider);
  return normalized === 'custom' ? 'https://docs.ollama.com' : PROVIDERS[normalized].keyUrl;
}

export function completionUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 3) return '•••';
  const prefix = trimmed.length >= 7 ? trimmed.slice(0, 4) : '';
  return `${prefix}•••${trimmed.slice(-3)}`;
}
