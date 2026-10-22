import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { OpenAICompatibleProvider, RateLimitError, RETRY_DELAYS_SECONDS, sleep, type RetryEvent } from '../src/llm-client';
import { t } from '../src/i18n';

// Батч 17: «Ночной аудит» — экспоненциальный backoff на 429 Rate Limit.
// Бесплатные модели (minimax-free, beam-free) должны медленно, но верно
// дочёсывать проект за ночь: 30с → 60с → 120с, максимум 3 ретрая =
// 4 попытки на чанк/файл, файл НЕ скипается после короткого кулдауна.

const success = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[]}' } }] }), { status: 200 });
const rateLimited = () => new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 });

describe('батч 17: exponential backoff 30/60/120 на 429', () => {
  it('лестница выдержана: три паузы 30/60/120 секунд и успех на 4-й попытке', async () => {
    expect(RETRY_DELAYS_SECONDS).toEqual([30, 60, 120]);
    const responses = [rateLimited(), rateLimited(), rateLimited(), success()];
    const waits: number[] = [];
    const events: RetryEvent[] = [];
    let calls = 0;
    const provider = new OpenAICompatibleProvider('key', 'minimax-free', async () => { calls += 1; return responses.shift()!; }, async (ms) => { waits.push(ms); }, (event) => events.push(event));
    await expect(provider.review('system', 'user')).resolves.toContain('issues');
    expect(calls).toBe(4);
    expect(waits).toEqual([30000, 60000, 120000]);
    expect(events).toEqual([
      { attempt: 1, maxRetries: 3, waitSeconds: 30 },
      { attempt: 2, maxRetries: 3, waitSeconds: 60 },
      { attempt: 3, maxRetries: 3, waitSeconds: 120 }
    ]);
  });

  it('четвёртый 429 подряд — умиротворяющая ошибка, но НЕ молчаливый скип чанка', async () => {
    const responses = [rateLimited(), rateLimited(), rateLimited(), rateLimited()];
    let calls = 0;
    const provider = new OpenAICompatibleProvider('key', 'beam-free', async () => { calls += 1; return responses.shift()!; }, async () => undefined);
    await expect(provider.review('system', 'user')).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toBe(4);
  });

  it('retry-after от сервера удлиняет паузу, но короче ступени лестницы не бывает', async () => {
    const responses = [
      new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429, headers: { 'retry-after': '200' } }),
      new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429, headers: { 'retry-after': '1' } }),
      success()
    ];
    const waits: number[] = [];
    const provider = new OpenAICompatibleProvider('key', 'model', async () => responses.shift()!, async (ms) => { waits.push(ms); });
    await expect(provider.review('system', 'user')).resolves.toContain('issues');
    expect(waits).toEqual([200000, 60000]);
  });

  it('отмена (AbortSignal) прекращает ночные паузы немедленно', async () => {
    const controller = new AbortController();
    // 30с пауза на реальном sleep(): отмена должна оборвать её сразу,
    // а не ждать окончания «Ночного режима».
    const provider = new OpenAICompatibleProvider('key', 'model', async () => rateLimited(), sleep, undefined, 'https://api.groq.com/openai/v1', controller.signal);
    const pending = provider.review('system', 'user');
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('UI-статус: текст авто-ожидания в RU и EN без кириллицы', () => {
    const vars = { model: 'minimax-free', s: 30, a: 1, m: 3 };
    const ru = t('status.retry', 'ru', vars);
    expect(ru).toContain('⏳ Лимит запросов. Ожидание 30с перед повтором');
    expect(ru).toContain('Авто-ожидание');
    expect(ru).not.toContain('Ночной режим');
    expect(ru).toContain('minimax-free');
    const en = t('status.retry', 'en', vars);
    expect(en).toContain('⏳ Request limit. Waiting 30s before retry');
    expect(en).toContain('auto-wait');
    expect(en).not.toContain('night mode');
    expect(en).not.toMatch(/[\u0400-\u04FF]/);
  });

  it('хост не бросает файл на первой 429: ретраи того же файла через паузы + ladder-карантин', () => {
    const extension = readFileSync('extension/src/extension.ts', 'utf8');
    expect(extension).toContain('error instanceof RateLimitError || isNetworkError(error) || isRateLimitText(error)');
    expect(extension).toContain('pauses < rateLimitPauses');
    expect(extension).toContain('await sleeper(waitSeconds * 1000, signal)');
    expect(extension).toContain('RATE_LIMIT_PAUSE_LADDER = [120, 300, 600]');
  });
});
