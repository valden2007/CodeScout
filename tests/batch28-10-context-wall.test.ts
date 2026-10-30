// Микро-батч 28.10, задача 2: context-wall «request too large» ≠ тариф.
// 400/413 с текстами request too large / context length / maximum context →
// категория context-wall: бюджет чанка уменьшается вдвое, файл ретрится
// (до 3 делений), ключ НЕ блокируется; после пределов — скип с причиной
// context-wall и подсказкой «модель с узким окном, выбери шире».
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { categorizeError, formatError, ERROR_CATEGORIES } from '../src/error-classifier';
import { ProviderHttpError } from '../src/llm-client';
import { state, flush, makeFakeContext } from './vscode-stub';
import { reviewFiles } from '../extension/src/extension';
import { CONTEXT_WALL_MAX_SPLITS } from '../extension/src/projectAudit';
import { keySecretId, resetRuntime, runtime } from '../extension/src/keychain';
import { clearModelsCache } from '../src/providers';

const REAL_FETCH = globalThis.fetch;
const KEY_A = 'ZZKEYAAA_1234567890';

function okContent(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[],"summary":"ok"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// 400 «request too large» — как его отдают OpenAI-совместимые шлюзы.
function tooLarge(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } });
}

// Pure-addition аудит-чанк: заголовок +++ /dev/null, @@ -0,0 +1,N @@, N строк '+'.
function auditChunkFile(filename: string, lines: number): { filename: string; status: string; additions: number; deletions: number; patch: string } {
  const body = Array.from({ length: lines }, (_, i) => `+export const v${i} = ${i};`).join('\n');
  return { filename, status: 'audit', additions: lines, deletions: 0, patch: `--- /dev/null\n+++ b/${filename}\n@@ -0,0 +1,${lines} @@\n${body}` };
}

describe('28.10 unit: классификатор context-wall', () => {
  it('категория в списке ERROR_CATEGORIES + словарь (title/msg/hint оба языка)', () => {
    expect(ERROR_CATEGORIES).toContain('context-wall');
    for (const lang of ['ru', 'en'] as const) {
      const formatted = formatError(new ProviderHttpError(400, '400: request too large', 'request too large'), lang);
      expect(formatted.category).toBe('context-wall');
      expect(formatted.title).toBeTruthy();
      expect(formatted.actionHint).toBeTruthy();
      if (lang === 'en') expect(formatted.title + formatted.message + formatted.actionHint).not.toMatch(/[\u0400-\u04FF]/);
    }
  });

  it('400 request too large / context length / maximum context → context-wall', () => {
    const texts = [
      'request too large: 15234 tokens exceeds the limit',
      "This model's maximum context length is 8192 tokens, however you requested 12000",
      'context length exceeded — shorten the prompt',
      'prompt is too long: maximum context is 4096'
    ];
    for (const text of texts) {
      expect(categorizeError(new ProviderHttpError(400, `400: ${text}`, text))).toBe('context-wall');
      expect(categorizeError(new Error(`400: ${text}`))).toBe('context-wall');
    }
  });

  it('413 без текста — тоже context-wall; 400 без окна — unknown (регресс)', () => {
    expect(categorizeError(new ProviderHttpError(413, '413: payload', ''))).toBe('context-wall');
    expect(categorizeError(new ProviderHttpError(400, '400: bad request body', 'bad request body'))).toBe('unknown');
  });

  it('регресс 28.9: billing-402 и quota-429 НЕ перекрашиваются в context-wall', () => {
    expect(categorizeError(new ProviderHttpError(402, '402: insufficient_credits top up billing', 'insufficient_credits'))).toBe('billing');
    expect(categorizeError(new Error('402 upgrade to flash tier required'))).toBe('billing');
    expect(categorizeError(new Error('exceeded your current quota, this daily limit resets in 42s'))).toBe('quota');
    // текст окна + денег вместе: контекст проверяется первым (размер, не тариф)
    expect(categorizeError(new Error('400: request too large, reduce your prompt'))).toBe('context-wall');
  });
});

describe('28.10 e2e: reviewFiles делит чанк, ключ не блокируется', () => {
  beforeEach(() => { state.reset(); resetRuntime(); clearModelsCache(); state.set('codescout.fileCooldownSeconds', 0); });
  afterEach(() => { globalThis.fetch = REAL_FETCH; });

  it('мок 400 request-too-large → деление вдвое и успех со второго раза', async () => {
    state.secrets.set('codescout.apiKey', KEY_A);
    state.secrets.set('codescout.provider', 'groq');
    const bodies: number[] = [];
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      calls += 1;
      bodies.push(String(init?.body ?? '').length);
      return calls === 1 ? tooLarge(400, 'request too large: input length exceeds the context window') : okContent();
    }) as unknown as typeof fetch;
    const splits: Array<{ from: number; to: number; n: number }> = [];
    const result = await reviewFiles(makeFakeContext() as never, [auditChunkFile('src/big.ts', 800)], undefined, () => {},
      undefined, undefined, undefined, undefined, true, undefined, undefined, undefined, 1, undefined, 0, undefined,
      async () => {}, 'ru', 0, undefined, undefined,
      { onContextWallSplit: (_f, from, to, n) => { splits.push({ from, to, n }); } });
    expect(result.skippedFiles).toBe(0);
    expect(result.filesAnalyzed).toBe(1);
    expect(splits).toEqual([{ from: 800, to: 400, n: 1 }]);
    // успех «со второго раза»: исходный чанк упал один раз, половинки прошли
    expect(calls).toBe(3);
    expect(bodies[0]).toBeGreaterThan(bodies[1]);
    expect(bodies[0]).toBeGreaterThan(bodies[2]);
    // ключ НЕ заблокирован: runtime пуст (ни сна, ни broken, ни billing)
    expect(runtime.size).toBe(0);
  });

  it('постоянный 400: не более 3 делений, затем скип с причиной context-wall', async () => {
    state.secrets.set('codescout.apiKey', KEY_A);
    state.secrets.set('codescout.provider', 'groq');
    globalThis.fetch = (async () => tooLarge(400, "This model's maximum context length is 4096 tokens")) as unknown as typeof fetch;
    const splits: number[] = [];
    const skipped: Array<{ file: string; category: string }> = [];
    const slept: number[] = [];
    const result = await reviewFiles(makeFakeContext() as never, [auditChunkFile('src/huge.ts', 1600)], undefined, () => {},
      undefined, undefined, undefined, undefined, true,
      (file, error) => { skipped.push({ file, category: categorizeError(error) }); }, undefined, undefined, 1, undefined, 3,
      undefined, async (ms) => { slept.push(ms); }, 'ru', 0, undefined, undefined,
      { quarantine: true, onContextWallSplit: (_f, _from, _to, n) => { splits.push(n); } });
    expect(result.skippedFiles).toBe(1);
    expect(skipped).toEqual([{ file: 'src/huge.ts', category: 'context-wall' }]);
    expect(splits).toEqual([1, 2, 3]);
    // rate-limit-лестница не привлекалась: ни одной паузы от reviewFiles
    expect(slept.filter((ms) => ms >= 120_000)).toEqual([]);
    expect(runtime.size).toBe(0);
  }, 30000);

  it('context-wall НЕ уходит в ladder/карантин даже с включённым rateLimitPauses', async () => {
    state.secrets.set('codescout.apiKey', KEY_A);
    state.secrets.set('codescout.provider', 'groq');
    globalThis.fetch = (async () => tooLarge(413, 'request entity too large')) as unknown as typeof fetch;
    const waited: number[] = [];
    let pauses = 0;
    const result = await reviewFiles(makeFakeContext() as never, [auditChunkFile('src/one.ts', 200)], undefined, () => {},
      undefined, undefined, undefined, undefined, true, undefined, undefined, undefined, 1, undefined, 3,
      () => { pauses += 1; }, async (ms) => { waited.push(ms); }, 'ru', 0, undefined, undefined, { quarantine: true });
    // 200-строчный чанк неделим (min 400) → мгновенный скип без пауз
    expect(result.skippedFiles).toBe(1);
    expect(pauses).toBe(0);
    expect(waited).toEqual([]);
  });
});
