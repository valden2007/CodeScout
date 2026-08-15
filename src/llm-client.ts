import { LLMProvider } from './types';

interface GroqResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class GroqProvider implements LLMProvider {
  private lastRequestAt = 0;

  constructor(private readonly apiKey: string, private readonly model: string, private readonly fetcher: typeof fetch = fetch) {}

  async review(systemPrompt: string, userPrompt: string): Promise<string> {
    const wait = 2000 - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.lastRequestAt = Date.now();
      try {
        const response = await this.fetcher('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
        });
        const data = (await response.json()) as GroqResponse;
        if (!response.ok) throw new Error(data.error?.message ?? `Groq request failed with ${response.status}`);
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error('Groq returned an empty response');
        return content;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await sleep(2 ** attempt * 1000);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('LLM request failed');
  }
}

export function createProvider(provider: string, apiKey: string, model: string): LLMProvider {
  if (provider.toLowerCase() !== 'groq') throw new Error(`Unsupported provider: ${provider}`);
  return new GroqProvider(apiKey, model);
}
