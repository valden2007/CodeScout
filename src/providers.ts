export type ProviderName = 'gemini' | 'groq' | 'openrouter' | 'github' | 'opencode' | 'openai' | 'anthropic' | 'deepseek' | 'together' | 'sambanova' | 'siliconflow' | 'nvidia' | 'hyperbolic' | 'cerebras' | 'custom';

export interface DetectedProvider {
  provider: ProviderName;
  model: string;
  /**
   * Батч 21: голой `sk-` префикс НЕ указывает на OpenAI — десятки платформ
   * (DeepSeek, Together, SambaNova, SiliconFlow, Hyperbolic, Cerebras)
   * выдают ключи ровно в таком формате. Помечаем догадку ambiguous=true —
   * UI обязан спросить пользователя через QuickPick, а не молча писать openai.
   */
  ambiguous?: boolean;
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

// Батч 22, п.2: ЕДИНСТВЕННАЯ точка санитизации API-ключа. Невидимые
// пробелы/переносы после вставки из чата или файл-в-файл — подтверждённая
// причина 401 (Groq), окружающие кавычки — частый артефакт копирования из
// JSON/ENV. Одинаково для /models и review-запросов (llm-client зовёт то же).
export function sanitizeApiKey(key: string): string {
  let value = key.trim();
  let changed = true;
  while (changed && value.length >= 2) {
    changed = false;
    for (const [open, close] of [['"', '"'], ["'", "'"], ['`', '`']] as const) {
      if (value.startsWith(open) && value.endsWith(close)) {
        value = value.slice(1, -1).trim();
        changed = true;
      }
    }
  }
  return value;
}

// Батч 20a, п.2: guard Gemini смягчён до УМНОГО МОКА — сначала живая попытка
// GET {base}/models с AbortController и таймаутом GEMINI_MODELS_TIMEOUT_MS,
// при любом провале (таймаут/404/сеть/битый URL/пустой список/редирект) —
// откат на GEMINI_STATIC_MODELS + предупреждение в лог/Output.
// Батч 22, п.1: потолок 3000 → 10000мс — OpenRouter/Groq отдают большие
// списки моделей дольше 3 секунд, и раньше это ложно считалось сбоем.
export const GEMINI_STATIC_MODELS = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash', 'gemini-2.5-flash'];
export const GEMINI_MODELS_TIMEOUT_MS = 10000;
// Батч 22, п.1: общий таймаут живого GET /models для всех платформ.
export const MODELS_FETCH_TIMEOUT_MS = 10000;
// Батч 22, п.1: кэш списка моделей на инстанс (Map<provider+baseUrl+key>).
// Повторное открытие Центра настроек не гоняет гигантский JSON повторно.
export const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;

export interface ModelsFetchLog {
  provider: string;
  ms: number;
  bytes: number;
  status: number;
  models: number;
  error?: string;
}

function logModelsFetch(onMetric: ((message: string) => void) | undefined, entry: ModelsFetchLog): void {
  // Диагностика (батч 22, п.1): длительность и размер ответа. КЛЮЧ НЕ ПИШЕМ.
  onMetric?.(`⏱ ${entry.provider} GET /models: ${entry.ms} мс, ${entry.bytes} байт, HTTP ${entry.status}, моделей ${entry.models}${entry.error ? ` (${entry.error})` : ''}`);
}

// Батч 22.1: pre-fetch диагностика в Output — что РЕАЛЬНО уходит в сеть:
// длина ключа ПОСЛЕ sanitizeApiKey (сразу видно, съели ли пробелы/кавычки)
// и 5-символьный префикс Authorization (формат gsk_…/sk-or…/AIza…). Полный
// ключ не логируется никогда — только префикс, как в maskApiKey (17.5).
// Батч 22.2, п.2: + host целевого URL. Хост — не секрет, но именно он делает
// ошибку вида «ключ groq, а fetch ушёл на чужой эндпоинт» видимой за 1 секунду.
export function keyAuthDiagnostic(provider: string | undefined, apiKey: string, targetUrl?: string): string {
  const key = sanitizeApiKey(apiKey);
  const auth = key ? `Bearer ${key.slice(0, 5)}` : '— (без ключа)';
  let host = '';
  if (targetUrl) {
    try {
      host = new URL(targetUrl).hostname;
    } catch {
      host = '?';
    }
  }
  const hostPart = host ? `, host=${host}` : '';
  return `🔑 ${provider ?? 'custom'}: key=${key.length} символов, auth=${auth}${hostPart}, fetch /models`;
}

async function fetchGeminiModels(baseUrl: string, apiKey: string, fetcher: typeof fetch, timeoutMs: number, onWarn: (message: string) => void, onMetric?: (message: string) => void): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, GEMINI_MODELS_TIMEOUT_MS));
  const started = Date.now();
  try {
    const safeBase = assertHttpBaseUrl(baseUrl.replace(/\/+$/, ''));
    onMetric?.(keyAuthDiagnostic('gemini', apiKey, safeBase));
    const response = await fetcher(`${safeBase}/models`, {
      method: 'GET',
      // Батч 22, п.2: ключ санитизирован в одной точке + честный Accept.
      headers: { Authorization: `Bearer ${sanitizeApiKey(apiKey)}`, Accept: 'application/json' },
      signal: controller.signal,
      // SSRF-контракт батча 17.5 действует и здесь: 3xx = ошибка, ключ не уезжает по редиректу.
      redirect: 'manual'
    });
    const text = await response.text();
    if (!response.ok) throw new Error(redirectError(response.status) ?? `HTTP ${response.status}`);
    const models = parseLiveModels(JSON.parse(text) as unknown);
    logModelsFetch(onMetric, { provider: 'gemini', ms: Date.now() - started, bytes: new TextEncoder().encode(text).length, status: response.status, models: models.length });
    if (!models.length) throw new Error('пустой список моделей в ответе');
    return models;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logModelsFetch(onMetric, { provider: 'gemini', ms: Date.now() - started, bytes: 0, status: 0, models: 0, error: detail });
    onWarn(`⚠️ Gemini /models недоступен (${detail}) — отдаю статический список моделей`);
    return [...GEMINI_STATIC_MODELS];
  } finally {
    clearTimeout(timer);
  }
}

// Батч 22, п.3: редирект при redirect:'manual' — НЕ «просто HTTP 3xx»,
// а категоризированная ошибка «провайдер ответил редиректом». Политика
// manual сохранена для ВСЕХ платформ, включая custom (SSRF-замок 17.5).
function redirectError(status: number): string | undefined {
  if (status < 300 || status >= 400) return undefined;
  return `Провайдер ответил редиректом (HTTP ${status}) — разыгрывать Location при redirect:'manual' запрещено (SSRF-замок)`;
}

export async function fetchLiveModels(baseUrl: string, apiKey: string, fetcher: typeof fetch = fetch, timeoutMs = MODELS_FETCH_TIMEOUT_MS, provider?: string, onWarn: (message: string) => void = (message): void => console.warn(message), tolerateErrors = false, onMetric?: (message: string) => void): Promise<string[]> {
  if (provider === 'gemini') return fetchGeminiModels(baseUrl, apiKey, fetcher, timeoutMs, onWarn, onMetric);
  const safeBase = assertHttpBaseUrl(baseUrl.replace(/\/+$/, ''));
  const started = Date.now();
  onMetric?.(keyAuthDiagnostic(provider, apiKey, safeBase));
  try {
    const response = await fetcher(`${safeBase}/models`, {
      method: 'GET',
      // Батч 22, п.2: sanitizeApiKey в одной точке (401 из-за пробелов/переносов)
      // + Accept: application/json (п.2). Батч 17.5 (SSRF): Authorization не
      // уезжает по 3xx-редиректу — переходы запрещены, 3xx = ошибка.
      headers: { Authorization: `Bearer ${sanitizeApiKey(apiKey)}`, Accept: 'application/json' },
      // Зависший сервер не должен делать настройку бесконечной (батч 13, п.3);
      // потолок — 10000мс (батч 22, п.1: большие списки OpenRouter/Groq).
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual'
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(redirectError(response.status) ?? `Не удалось получить список моделей: HTTP ${response.status}`);
    }
    const models = parseLiveModels(JSON.parse(text) as unknown);
    logModelsFetch(onMetric, { provider: provider ?? 'custom', ms: Date.now() - started, bytes: new TextEncoder().encode(text).length, status: response.status, models: models.length });
    return models;
  } catch (error) {
    // Батч 21, п.3 + батч 22, п.3: все top-12 платформ OpenAI-совместимы.
    // Интерфейс выбора модели не имеет права падать на 401/404/таймаут/
    // редирект/битый JSON — при tolerateErrors тихо отдаём пустой список
    // (UI предложит ввести модель вручную + подсказка). Тест подключения и
    // CLI/Action зовут без флага: там ошибка — полезный сигнал, она летит
    // наружу. Битый baseUrl валидируется строго всегда (см. выше).
    const detail = error instanceof Error ? error.message : String(error);
    logModelsFetch(onMetric, { provider: provider ?? 'custom', ms: Date.now() - started, bytes: 0, status: 0, models: 0, error: detail });
    if (!tolerateErrors) throw error;
    onWarn(`⚠️ ${provider ?? 'провайдер'} /models недоступен (${detail}) — отдаю пустой список, выбор модели не блокируется`);
    return [];
  }
}

// Батч 22, п.1: кэш живых списков моделей. Ключ — provider+baseUrl+ключ
// (только в памяти процесса, в логи не попадает). Кэшируются ТОЛЬКО
// успешные непустые ответы пути выбора моделей (tolerateErrors=true):
// «тест подключения» обязан каждый раз ходить в сеть, чтобы честный 401
// не прятался за свежим кэшем. TTL — 10 минут.
const liveModelsCache = new Map<string, { models: string[]; ts: number }>();

export function clearModelsCache(): void {
  liveModelsCache.clear();
}

export async function fetchLiveModelsCached(baseUrl: string, apiKey: string, fetcher: typeof fetch = fetch, timeoutMs = MODELS_FETCH_TIMEOUT_MS, provider?: string, onWarn: (message: string) => void = (message): void => console.warn(message), tolerateErrors = true, onMetric?: (message: string) => void): Promise<string[]> {
  const cacheKey = `${provider ?? 'custom'}|${baseUrl.trim().replace(/\/+$/, '')}|${sanitizeApiKey(apiKey)}`;
  if (tolerateErrors) {
    const hit = liveModelsCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < MODELS_CACHE_TTL_MS) {
      onMetric?.(`🗂 ${provider ?? 'custom'}: ${hit.models.length} моделей из кэша (TTL ${Math.round(MODELS_CACHE_TTL_MS / 60000)} мин), сеть не дёргалась`);
      return [...hit.models];
    }
  }
  const models = await fetchLiveModels(baseUrl, apiKey, fetcher, timeoutMs, provider, onWarn, tolerateErrors, onMetric);
  if (tolerateErrors && models.length) liveModelsCache.set(cacheKey, { models: [...models], ts: Date.now() });
  return models;
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
// Батч 21: к витрине добавлены семь zero-config OpenAI-совместимых платформ
// (top-12 из коробки) — меньше ручной настройки custom-эндпоинтов.
export const PROVIDER_ORDER: ProviderName[] = ['custom', 'openai', 'anthropic', 'opencode', 'gemini', 'groq', 'github', 'deepseek', 'together', 'sambanova', 'siliconflow', 'nvidia', 'hyperbolic', 'cerebras'];

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
  },
  // Батч 21: топ-12 zero-config. Все ниже — OpenAI-совместимые /v1-эндпоинты
  // (GET /models + /chat/completions, Authorization: Bearer), отдельной
  // логики в клиенте не требуют.
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  together: {
    baseUrl: 'https://api.together.xyz/v1',
    envKey: 'TOGETHER_API_KEY',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
    keyUrl: 'https://api.together.xyz/settings/api-keys'
  },
  sambanova: {
    baseUrl: 'https://api.sambanova.ai/v1',
    envKey: 'SAMBANOVA_API_KEY',
    defaultModel: 'Meta-Llama-3.1-8B-Instruct',
    keyUrl: 'https://cloud.sambanova.ai/apis'
  },
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    envKey: 'SILICONFLOW_API_KEY',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak'
  },
  nvidia: {
    // NVIDIA NIM: ключи имеют строгий префикс nvapi- — автодетект однозначен.
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envKey: 'NVIDIA_API_KEY',
    defaultModel: 'meta-llama/llama-3.1-70b-instruct',
    keyUrl: 'https://build.nvidia.com'
  },
  hyperbolic: {
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    envKey: 'HYPERBOLIC_API_KEY',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    keyUrl: 'https://app.hyperbolic.xyz/settings'
  },
  cerebras: {
    baseUrl: 'https://api.cerebras.ai/v1',
    envKey: 'CEREBRAS_API_KEY',
    defaultModel: 'llama3.1-8b',
    keyUrl: 'https://cloud.cerebras.ai'
  }
};

// Батч 21, п.2: список для QuickPick-развилки неоднозначного `sk-`.
// Метка — провайдер не переводится (тех-термины/i18n-вайтлист).
export const SK_AMBIGUOUS_OPTIONS: { label: string; provider: ProviderName }[] = [
  { label: 'OpenAI', provider: 'openai' },
  { label: 'DeepSeek', provider: 'deepseek' },
  { label: 'Together AI', provider: 'together' },
  { label: 'SambaNova', provider: 'sambanova' },
  { label: 'SiliconFlow', provider: 'siliconflow' },
  { label: 'Hyperbolic', provider: 'hyperbolic' },
  { label: 'Cerebras', provider: 'cerebras' },
  { label: 'Custom', provider: 'custom' }
];

export function detectProvider(key: string): DetectedProvider | null {
  const value = key.trim();
  // Батч 17.5: oc_sk_ проверяется первым и строго — ключ OpenCode Go обязан
  // давать opencode, никаких соскальзываний на дефолты списка.
  if (value.startsWith('oc_sk_')) return { provider: 'opencode', model: 'qwen3.8-flash' };
  if (value.startsWith('gsk_')) return { provider: 'groq', model: 'llama-3.3-70b-versatile' };
  if (value.startsWith('AIza') || value.startsWith('AQ.')) return { provider: 'gemini', model: 'gemini-1.5-flash' };
  if (value.startsWith('nvapi-')) return { provider: 'nvidia', model: 'meta-llama/llama-3.1-70b-instruct' };
  // Батч 18: длинные sk-префиксы раньше голого sk- (иначе openrouter/anthropic
  // схлопнулись бы в openai).
  if (value.startsWith('sk-or-')) return { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' };
  if (value.startsWith('sk-ant-')) return { provider: 'anthropic', model: 'claude-3-5-haiku-latest' };
  if (value.startsWith('ghp_') || value.startsWith('github_pat_')) return { provider: 'github', model: 'gpt-4o-mini' };
  // sk-proj- — явный формат OpenAI project-ключей, здесь гадать не нужно.
  if (value.startsWith('sk-proj-')) return { provider: 'openai', model: 'gpt-4o-mini' };
  // Батч 21, п.2: голое `sk-` НЕ пишем молча в OpenAI — DeepSeek, Together,
  // SambaNova, SiliconFlow, Cerebras выдают ключи ровно так же. Возвращаем
  // догадку openai с ambiguous=true: UI обязан показать список выбора.
  if (value.startsWith('sk-')) return { provider: 'openai', model: 'gpt-4o-mini', ambiguous: true };
  return null;
}

export function normalizeProvider(provider?: string): ProviderName {
  const value = provider?.trim().toLowerCase() || 'gemini';
  if (value === 'custom') return 'custom';
  if (Object.hasOwn(PROVIDERS, value)) return value as Exclude<ProviderName, 'custom'>;
  throw new Error(`Неизвестный provider: ${provider}. Доступны: custom, ${Object.keys(PROVIDERS).join(', ')}.`);
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

// Батч 22.2, п.1: codescout.baseUrl / --base-url / CODESCOUT_BASE_URL — средство
// provider custom и локального режима (Ollama/LM Studio на localhost). Для всех
// остальных витринных провайдеров эндпоинт берётся СТРОГО из
// PROVIDERS[provider].baseUrl: оверрайд игнорируется и даже не читается
// (опечатка в глобальном поле не должна уводить groq-ключ на чужой хост).
// Батч 27.1, п.1: приоритет резолва эндпоинта — profile.baseUrl (явная
// per-profile галка, валидируется строго) → codescout.baseUrl (только
// custom/local) → PROVIDERS[provider].baseUrl.
export function resolveBaseUrl(provider: string, customBaseUrl?: string, profileBaseUrl?: string): string {
  const normalized = normalizeProvider(provider);
  const profileOverride = profileBaseUrl?.trim();
  if (profileOverride) {
    const url = profileOverride.replace(/\/+$/, '');
    assertHttpBaseUrl(url);
    return url;
  }
  const override = customBaseUrl?.trim();
  if (override && (normalized === 'custom' || isLocalBaseUrl(override))) {
    const url = override.replace(/\/+$/, '');
    assertHttpBaseUrl(url);
    return url;
  }
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
