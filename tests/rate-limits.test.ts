import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { state, makeFakeContext } from './vscode-stub';
import {
  reviewFiles,
  RATE_LIMIT_PAUSE_LADDER,
  PASS_BETWEEN_SECONDS,
  FILE_COOLDOWN_DEFAULT_SECONDS,
  FILE_COOLDOWN_MULTIPASS_DEFAULT_SECONDS,
  fileCooldownSecondsFromSetting,
  recordRateLimitHit,
  rateLimitHitsLast5min,
  resetRateLimitHits
} from '../extension/src/extension';

const realFetch = globalThis.fetch;

function fileSet(count: number): Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }> {
  return Array.from({ length: count }, (_, i) => ({ filename: `src/f${i + 1}.ts`, status: 'M', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n+const x = 1;' }));
}

const okBody = JSON.stringify({ choices: [{ message: { content: '{"issues":[],"summary":"ok"}' } }] });

interface RunOptions { passes?: number; rateLimitPauses?: number; fileCooldown?: number; failFirst?: boolean; onPass?: (filename: string, pass: number, totalPasses: number) => void }

async function runReview(count: number, over: RunOptions = {}) {
  const sleeps: number[] = [];
  const cooldowns: number[] = [];
  const pauses: Array<{ file: string; wait: number; pause: number }> = [];
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (over.failFirst && calls === 1) throw new Error('B.AI: 429 Too Many Requests — slow down');
    return new Response(okBody, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const result = await reviewFiles(
    makeFakeContext() as never, fileSet(count), undefined, () => {}, undefined, undefined, undefined,
    undefined, false, undefined, undefined, undefined,
    over.passes ?? 1, over.onPass, over.rateLimitPauses ?? 3,
    (file, wait, pause) => pauses.push({ file, wait, pause }),
    async (ms: number) => { sleeps.push(ms); },
    'ru', over.fileCooldown ?? 0, (seconds: number) => cooldowns.push(seconds)
  );
  return { result, sleeps, cooldowns, pauses, calls };
}

describe('v1.4b-14 агрессивные паузы + cooldown', () => {
  beforeEach(() => {
    state.reset();
    resetRateLimitHits();
    state.secrets.set('codescout.apiKey', 'AIzaTESTKEY123456');
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('лестница удлинена до 120/300/600', () => {
    expect(RATE_LIMIT_PAUSE_LADDER).toEqual([120, 300, 600]);
    expect(PASS_BETWEEN_SECONDS).toBe(15);
    expect(FILE_COOLDOWN_DEFAULT_SECONDS).toBe(5);
    expect(FILE_COOLDOWN_MULTIPASS_DEFAULT_SECONDS).toBe(10);
  });

  it('файл НЕ скипается на rate-limit текстом в обычном Error — ретри с паузой 120с', async () => {
    const { result, sleeps, pauses } = await runReview(1, { failFirst: true });
    expect(pauses).toEqual([{ file: 'src/f1.ts', wait: 120, pause: 1 }]);
    expect(sleeps).toEqual([120000]);
    expect(result.skippedFiles).toBe(0);
    expect(result.filesAnalyzed).toBe(1);
    expect(result.issues).toEqual([]);
  }, 30000);

  it('cooldown между файлами без rate-limit: 5с между файлами, перед первым — нет; 0 = выкл', async () => {
    const { result, sleeps, cooldowns, pauses } = await runReview(2, { fileCooldown: 5 });
    expect(result.filesAnalyzed).toBe(2);
    expect(sleeps).toEqual([5000]);
    expect(cooldowns).toEqual([5]);
    expect(pauses).toEqual([]);
    const off = await runReview(1, { fileCooldown: 0 });
    expect(off.sleeps).toEqual([]);
  }, 30000);

  it('мульти-пасс: 15с между кругами одного файла, порядок sleep = pass→cooldown', async () => {
    const passes: Array<[string, number, number]> = [];
    const { sleeps } = await runReview(2, { passes: 2, fileCooldown: 10, onPass: (f, p, tp) => passes.push([f, p, tp]) });
    expect(passes).toEqual([['src/f1.ts', 2, 2], ['src/f2.ts', 2, 2]]);
    expect(sleeps).toEqual([PASS_BETWEEN_SECONDS * 1000, 10000, PASS_BETWEEN_SECONDS * 1000]);
  }, 30000);

  it('настройка fileCooldownSeconds: default 5/10, явные значения клампятся 0-30, 0 = выкл', () => {
    expect(fileCooldownSecondsFromSetting(undefined, 1)).toBe(5);
    expect(fileCooldownSecondsFromSetting(undefined, 2)).toBe(10);
    expect(fileCooldownSecondsFromSetting(undefined, 3)).toBe(10);
    expect(fileCooldownSecondsFromSetting(0, 2)).toBe(0);
    expect(fileCooldownSecondsFromSetting('7', 1)).toBe(7);
    expect(fileCooldownSecondsFromSetting(999, 1)).toBe(30);
    expect(fileCooldownSecondsFromSetting(-4, 1)).toBe(0);
    expect(fileCooldownSecondsFromSetting('', 2)).toBe(10);
  });

  it('429-логгер: счётчик попаданий за 5 минут чистится по окну', () => {
    recordRateLimitHit(1000);
    recordRateLimitHit(2000);
    expect(rateLimitHitsLast5min(3000)).toBe(2);
    expect(rateLimitHitsLast5min(400000)).toBe(0);
  });

  it('Output: cooldown-строка и частота 429 встроены в аудит/кастом; настройка в манифесте', () => {
    const extension = readFileSync('extension/src/extension.ts', 'utf8');
    expect(extension).toContain('⏸ cooldown ${seconds}с перед следующим файлом');
    expect((extension.match(/⏸ cooldown/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(extension).toContain('429 за 5 мин: ${hits}');
    expect(extension).toContain('hits > 10');
    expect(extension).toContain('нужен часовой отдых');
    const manifest = readFileSync('extension/package.json', 'utf8');
    expect(manifest).toContain('"codescout.fileCooldownSeconds"');
    expect(manifest).toContain('%fileCooldown.description%');
    const props = JSON.parse(manifest).contributes.configuration.properties['codescout.fileCooldownSeconds'];
    expect(props).toMatchObject({ type: 'number', default: 5, minimum: 0, maximum: 30 });
    const nlsEn = JSON.parse(readFileSync('extension/package.nls.json', 'utf8'));
    const nlsRu = JSON.parse(readFileSync('extension/package.nls.ru.json', 'utf8'));
    expect(nlsEn['fileCooldown.description']).toContain('Ollama');
    expect(nlsRu['fileCooldown.description']).toMatch(/локальн/);
  });
});
