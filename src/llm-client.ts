import { LLMProvider } from './types';

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
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

function finalRateLimitMessage(waitSeconds?: number, details = ''): string {
  const minutes = Math.max(1, Math.ceil((waitSeconds ?? 60) / 60));
  const suffix = /tokens?\s+per\s+day|tpd/i.test(details) ? 'tokens per day' : 'tokens per day';
  return `⚠️ Превышен дневной лимит Groq.\nПопробуйте через ${minutes} минут или используйте другой провайдер.\nТекущий лимит: ${suffix}`;
}

export class GroqProvider implements LLMProvider {
  private lastRequestAt = 0;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleeper: (ms: number) => Promise<void> = sleep,
    private readonly onRetry?: (event: RetryEvent) => void
  ) {}

  async review(systemPrompt: string, userPrompt: string): Promise<string> {
    const wait = 2000 - (Date.now() - this.lastRequestAt);
    if (wait > 0) await this.sleeper(wait);
    let retryCount = 0;
    let lastRateLimit: { waitSeconds?: number; details: string } | undefined;

    while (true) {
      this.lastRequestAt = Date.now();
      try {
        const response = await this.fetcher('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
        });
        const data = (await response.json()) as GroqResponse;
        if (!response.ok) {
          const details = data.error?.message ?? `Groq request failed with ${response.status}`;
          if (response.status === 429) {
            const waitSeconds = parseRetryAfterSeconds(response, details);
            throw new RateLimitError(JSON.stringify({ waitSeconds, details }));
          }
          throw new Error(details);
        }
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error('Groq returned an empty response');
        return content;
      } catch (error) {
        if (!(error instanceof RateLimitError)) throw error;
        let parsed: { waitSeconds?: number; details?: string } = {};
        try { parsed = JSON.parse(error.message) as typeof parsed; } catch { /* use defaults */ }
        lastRateLimit = { waitSeconds: parsed.waitSeconds, details: parsed.details ?? '' };
        if (retryCount >= RETRY_DELAYS_SECONDS.length) {
          throw new RateLimitError(finalRateLimitMessage(lastRateLimit.waitSeconds, lastRateLimit.details));
        }
        retryCount += 1;
        const waitSeconds = lastRateLimit.waitSeconds ?? RETRY_DELAYS_SECONDS[retryCount - 1];
        this.onRetry?.({ attempt: retryCount, maxRetries: RETRY_DELAYS_SECONDS.length, waitSeconds });
        await this.sleeper(waitSeconds * 1000);
      }
    }
  }
}

export function createProvider(provider: string, apiKey: string, model: string, onRetry?: (event: RetryEvent) => void): LLMProvider {
  if (provider.toLowerCase() !== 'groq') throw new Error(`Unsupported provider: ${provider}`);
  return new GroqProvider(apiKey, model, fetch, sleep, onRetry);
}
