import { LLMProvider } from './types';
import { completionUrl, normalizeProvider, resolveBaseUrl } from './providers';

interface GroqResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export interface RetryEvent {
  attempt: number;
  maxRetries: number;
  waitSeconds: number;
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException('The operation was aborted', 'AbortError')); return; }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('The operation was aborted', 'AbortError')); }, { once: true });
});
const RETRY_DELAYS_SECONDS = [15, 30, 60];

function parseRetryAfterSeconds(response: Response, message: string): number | undefined {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  }
  const match = message.match(/try\s+again\s+in\s+(\d+(?:\.\d+)?)\s*s?/i);
  if (match) return Math.ceil(Number.parseFloat(match[1]));
  return undefined;
}

function notFoundMessage(model: string): string {
  return `⚠️ 404: эндпоинт или модель ${model} не найдены. Проверь provider/model.`;
}

function finalRateLimitMessage(model: string, waitSeconds?: number): string {
  const minutes = Math.max(1, Math.ceil((waitSeconds ?? 60) / 60));
  return `⚠️ Превышен лимит модели ${model}.\nПопробуйте через ${minutes} минут или используйте другую модель.\nТекущий лимит: tokens per day`;
}

export class OpenAICompatibleProvider implements LLMProvider {
  private lastRequestAt = 0;
  private readonly endpoint: string;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleeper: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
    private readonly onRetry?: (event: RetryEvent) => void,
    baseUrl = 'https://api.groq.com/openai/v1',
    private readonly signal?: AbortSignal
  ) {
    this.endpoint = completionUrl(baseUrl);
  }

  async review(systemPrompt: string, userPrompt: string): Promise<string> {
    const wait = 2000 - (Date.now() - this.lastRequestAt);
    if (wait > 0) await this.sleeper(wait, this.signal);
    let retryCount = 0;
    let lastRateLimit: { waitSeconds?: number; details: string } | undefined;

    while (true) {
      if (this.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      this.lastRequestAt = Date.now();
      try {
        const response = await this.fetcher(this.endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }),
          signal: this.signal
        });
        const data = (await response.json()) as GroqResponse;
        if (!response.ok) {
          const details = data.error?.message ?? `LLM request failed with ${response.status}`;
          if (response.status === 429) {
            const waitSeconds = parseRetryAfterSeconds(response, details);
            throw new RateLimitError(JSON.stringify({ waitSeconds, details }));
          }
          if (response.status === 404) throw new Error(notFoundMessage(this.model));
          throw new Error(details);
        }
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error('LLM returned an empty response');
        return content;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (!(error instanceof RateLimitError)) throw error;
        let parsed: { waitSeconds?: number; details?: string } = {};
        try { parsed = JSON.parse(error.message) as typeof parsed; } catch { /* final public error */ }
        lastRateLimit = { waitSeconds: parsed.waitSeconds, details: parsed.details ?? '' };
        if (retryCount >= RETRY_DELAYS_SECONDS.length) {
          throw new RateLimitError(finalRateLimitMessage(this.model, lastRateLimit.waitSeconds));
        }
        retryCount += 1;
        const waitSeconds = lastRateLimit.waitSeconds ?? RETRY_DELAYS_SECONDS[retryCount - 1];
        this.onRetry?.({ attempt: retryCount, maxRetries: RETRY_DELAYS_SECONDS.length, waitSeconds });
        await this.sleeper(waitSeconds * 1000, this.signal);
      }
    }
  }
}

export { OpenAICompatibleProvider as GroqProvider };

export function createProvider(provider: string, apiKey: string, model: string, onRetry?: (event: RetryEvent) => void, baseUrl?: string, signal?: AbortSignal): LLMProvider {
  const normalized = normalizeProvider(provider);
  const resolvedBaseUrl = resolveBaseUrl(normalized, baseUrl);
  return new OpenAICompatibleProvider(apiKey, model, fetch, sleep, onRetry, resolvedBaseUrl, signal);
}
