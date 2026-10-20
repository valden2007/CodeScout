// Батч 15: классификация ошибок провайдеров → категории + локализованные
// title/message/hint без утечек сырых сообщений и секретов.
import { describe, expect, it } from 'vitest';
import { BadResponseError, ProviderHttpError, RateLimitError, RequestTimeoutError } from '../src/llm-client';
import { categorizeError, formatError, ERROR_CATEGORIES } from '../src/error-classifier';
import { parseReviewResponse } from '../src/response-parser';

describe('батч 15: categorizeError', () => {
  it('HTTP 401 → auth_invalid_key с подсказкой про ключ', () => {
    const error = new ProviderHttpError(401, '401: API key not valid', 'body');
    expect(categorizeError(error)).toBe('auth_invalid_key');
    const formatted = formatError(error, 'ru');
    expect(formatted.title).toContain('401');
    expect(formatted.actionHint).toContain('ключ');
    expect(formatted.category).toBe('auth_invalid_key');
  });

  it('HTTP 403 → auth_forbidden (отдельно от 401)', () => {
    expect(categorizeError(new ProviderHttpError(403, '403: forbidden', ''))).toBe('auth_forbidden');
    expect(formatError(new ProviderHttpError(403, '403: forbidden', ''), 'en').title).toContain('403');
  });

  it('HTTP 429 и RateLimitError → rate_limit_exceeded', () => {
    expect(categorizeError(new ProviderHttpError(429, '429', ''))).toBe('rate_limit_exceeded');
    expect(categorizeError(new RateLimitError('Rate limited by model: too many requests', 60))).toBe('rate_limit_exceeded');
    // агрегаторы отдают перелимит обычным Error с текстом
    expect(categorizeError(new Error('upstream said: Too Many Requests, quota exceeded'))).toBe('rate_limit_exceeded');
  });

  it('HTTP 404 → model_not_found', () => {
    expect(categorizeError(new ProviderHttpError(404, '⚠️ 404: эндпоинт или модель x не найдены', ''))).toBe('model_not_found');
    expect(categorizeError(new Error('The model `gpt-99` does not exist'))).toBe('model_not_found');
  });

  it('TimeoutError/RequestTimeoutError/ETIMEDOUT → timeout, интерполяция секунд', () => {
    expect(categorizeError(new RequestTimeoutError(60000))).toBe('timeout');
    expect(categorizeError(Object.assign(new Error('boom'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(categorizeError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe('timeout');
    const ru = formatError(new RequestTimeoutError(60000), 'ru');
    expect(ru.message).toContain('60 с');
    const domLike = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    expect(formatError(domLike, 'ru').message).toContain('5 с');
    expect(formatError(domLike, 'en').message).toContain('5s');
  });

  it('ECONNREFUSED → connection_refused с подсказкой про локальный сервис', () => {
    const error = new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
    expect(categorizeError(error)).toBe('connection_refused');
    expect(formatError(error, 'ru').actionHint).toMatch(/Ollama|LM Studio/);
    expect(formatError(new Error('getaddrinfo ENOTFOUND api.example.com'), 'en').category ?? categorizeError(new Error('getaddrinfo ENOTFOUND api.example.com'))).toBe('connection_refused');
  });

  it('битый JSON парсера и BadResponseError → invalid_json', () => {
    expect(() => parseReviewResponse('not json', 'a.ts')).toThrow('malformed JSON');
    try {
      parseReviewResponse('not json', 'a.ts');
    } catch (error) {
      expect(categorizeError(error)).toBe('invalid_json');
    }
    expect(categorizeError(new BadResponseError('Модель вернула некорректный формат: пустой ответ', ''))).toBe('invalid_json');
  });

  it('текстовые HTTP-статусы из fetchLiveModels-подобных ошибок', () => {
    expect(categorizeError(new Error('Не удалось получить список моделей: HTTP 401'))).toBe('auth_invalid_key');
    expect(categorizeError(new Error('Не удалось получить список моделей: HTTP 429'))).toBe('rate_limit_exceeded');
  });

  it('неизвестное → unknown', () => {
    expect(categorizeError(new Error('всё сломалось'))).toBe('unknown');
  });
});

describe('батч 15: formatError — безопасность и локализация', () => {
  it('каждая категория даёт непустой локализованный набор для ru и en', () => {
    for (const category of ERROR_CATEGORIES) {
      const error = new Error(`HTTP ${(category === 'auth_invalid_key' && '401') || (category === 'auth_forbidden' && '403') || (category === 'model_not_found' && '404') || (category === 'rate_limit_exceeded' && '429') || '500'} ${category}`);
      const formatted = formatError(error, 'en');
      expect(formatted.title.length, category).toBeGreaterThan(0);
      expect(formatted.message.length, category).toBeGreaterThan(0);
      expect(formatted.actionHint?.length ?? 0, category).toBeGreaterThan(0);
      expect(formatted.title).not.toMatch(/[\u0400-\u04FF]/);
      expect(formatError(error, 'ru').message).not.toMatch(/err\./);
    }
  });

  it('секреты не утекают в UI-текст unknown-сообщений', () => {
    const error = new Error('upstream echoed: key gsk_liveABC123456789 and Bearer AIzaSyDUMMYKEY123456 were sent');
    const formatted = formatError(error, 'en');
    expect(formatted.category).toBe('unknown');
    expect(formatted.message).not.toContain('gsk_liveABC123456789');
    expect(formatted.message).not.toContain('AIzaSyDUMMYKEY123456');
    expect(formatted.message).toContain('•••');
    // сырое сообщение остаётся только в rawMessage (для Output после redactSecrets)
    expect(formatted.rawMessage).toContain('gsk_liveABC123456789');
  });

  it('многострочные стеки и HTML в UI не показываются — только generic-текст', () => {
    const stack = formatError(new Error('boom\n    at Object.foo (module)'), 'en');
    expect(stack.message).toBe('An unexpected error occurred. See the CodeScout output channel for details.');
    expect(stack.message).not.toContain('at Object.foo');
    const html = formatError(new Error('<!DOCTYPE html>\n<html><body>502 gateway</body></html>'), 'en');
    expect(html.message).not.toContain('<html>');
  });

  it('локализованные однострочные сообщения CodeScout проходят как есть (trust-ошибки)', () => {
    const trust = new Error('Base URL задан в настройках рабочей области, но рабочая область не доверенная. Подтвердите доверие или задайте baseUrl в user-настройках.');
    const formatted = formatError(trust, 'ru');
    expect(formatted.category).toBe('unknown');
    expect(formatted.message).toContain('не доверенная');
  });
});
