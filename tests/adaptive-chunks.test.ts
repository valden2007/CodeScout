import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { state, makeFakeContext } from './vscode-stub';
import { reviewFiles, type AdaptiveChunkOptions } from '../extension/src/extension';

const realFetch = globalThis.fetch;

function makeAuditChunk(filename: string, start: number, count: number): string {
  const body = Array.from({ length: count }, (_, i) => `+const l${start + i} = ${start + i};`).join('\n');
  return `--- /dev/null\n+++ b/${filename}\n@@ -0,0 +${start},${count} @@\n${body}`;
}

function issuesResponse(issues: unknown[]): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ issues, summary: 'ok' }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const issue = (line: number, description: string) => ({ file: 'big.ts', line, code: 'const x', category: 'bug', severity: 'medium', description, suggestion: 'fix', confidence: 0.7 });

type ChunkFile = { filename: string; status: string; additions: number; deletions: number; patch: string };

const heavyFile: ChunkFile = { filename: 'big.ts', status: 'audit', additions: 800, deletions: 0, patch: makeAuditChunk('big.ts', 1, 800) };

async function run(files: ChunkFile[], options: { fails?: (n: number) => boolean; adaptive?: AdaptiveChunkOptions; rateLimitPauses?: number } = {}) {
  const captured: string[] = [];
  let n = 0;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    n += 1;
    captured.push(String(init?.body ?? ''));
    if (options.fails?.(n)) throw new Error('provider: 429 Too Many Requests');
    return issuesResponse([]);
  }) as typeof fetch;
  const sleeps: number[] = [];
  const result = await reviewFiles(
    makeFakeContext() as never, files, undefined, () => {}, undefined, undefined, undefined,
    'BASE', true, undefined, undefined, undefined, 1, undefined, options.rateLimitPauses ?? 3,
    undefined, async (ms: number) => { sleeps.push(ms); }, 'ru', 0, undefined, undefined,
    options.adaptive ?? {}
  );
  return { result, captured, sleeps, attempts: () => n };
}

describe('v1.4b-17 адаптивные чанки e2e', () => {
  beforeEach(() => {
    state.reset();
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('429 на чанке 800 → два запроса пополам, находки сливаются с дедупом, номера абсолютные', async () => {
    let req = 0;
    const captured: string[] = [];
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      req += 1;
      const body = String(init?.body ?? '');
      captured.push(body);
      if (req === 1) throw new Error('provider: 429 Too Many Requests');
      if (req === 2) return issuesResponse([issue(10, 'dup-halves')]);
      return issuesResponse([issue(10, 'dup-halves'), issue(600, 'only-second-half')]);
    }) as typeof fetch;
    const splits: Array<[string, number, number]> = [];
    const result = await reviewFiles(
      makeFakeContext() as never, [heavyFile], undefined, () => {}, undefined, undefined, undefined,
      'BASE', true, undefined, undefined, undefined, 1, undefined, 3, undefined, async () => {}, 'ru', 0, undefined, undefined,
      { onAdaptiveSplit: (filename, from, to) => splits.push([filename, from, to]) }
    );
    expect(splits).toEqual([['big.ts', 800, 400]]);
    expect(captured.length).toBe(3);
    // первый запрос — весь чанк; следующие — левая [1..400] и правая [351..800] половины
    expect(captured[1]).toContain('const l400 = 400;');
    expect(captured[1]).not.toContain('const l401 = 401;');
    expect(captured[2]).toContain('const l351 = 351;');
    expect(captured[2]).toContain('const l800 = 800;');
    // overlap 50 строк сохранён (351..400 есть в обеих половинках)
    expect(captured[1]).toContain('const l360 = 360;');
    expect(captured[2]).toContain('const l360 = 360;');
    // дедуп половинки с половинкой
    expect(result.issues.map((found) => found.description).sort()).toEqual(['dup-halves', 'only-second-half']);
    expect(result.skippedFiles).toBe(0);
    expect(result.filesAnalyzed).toBe(1);
  }, 30000);

  it('пред-оценка: тяжёлый чанк делится ДО первой отправки, ошибок нет', async () => {
    const preSplits: Array<[string, number, number]> = [];
    const { captured } = await run([heavyFile], {
      adaptive: { preSplitTokens: 4000, onPreSplit: (filename, from, to) => preSplits.push([filename, from, to]) }
    });
    expect(preSplits).toEqual([['big.ts', 800, 400]]);
    expect(captured.length).toBe(2);
    // полный чанк 800 не уходил в сеть вообще
    expect(captured[0]).not.toContain('const l800 = 800;');
    expect(captured[0]).toContain('const l400 = 400;');
    expect(captured[1]).toContain('const l800 = 800;');
  }, 30000);

  it('карантин: 9 циклов лестницы → перекладывание в конец очереди, 10-й — скип с подсказкой; лёгкий файл не заблокирован', async () => {
    const lightFile = { filename: 'light.ts', status: 'audit', additions: 3, deletions: 0, patch: makeAuditChunk('light.ts', 1, 3) };
    const heavy300 = { filename: 'big.ts', status: 'audit', additions: 300, deletions: 0, patch: makeAuditChunk('big.ts', 1, 300) };
    let order: string[] = [];
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const body = String(init?.body ?? '');
      order.push(body.includes('File: light.ts') ? 'light' : 'heavy');
      if (body.includes('File: light.ts')) return issuesResponse([]);
      throw new Error('provider: 429 Too Many Requests');
    }) as typeof fetch;
    const quarantined: string[] = [];
    const skippedFiles: string[] = [];
    const sleeps: number[] = [];
    const result = await reviewFiles(
      makeFakeContext() as never, [heavy300, lightFile], undefined, () => {}, undefined, undefined, undefined,
      'BASE', true, (filename) => skippedFiles.push(filename), undefined, undefined, 1, undefined, 1, undefined,
      async (ms: number) => { sleeps.push(ms); }, 'ru', 0, undefined, undefined,
      { quarantine: true, onQuarantineSkip: (filename) => quarantined.push(filename) }
    );
    // лёгкий файл пробился вперёд: light обработан до того, как heavy отработал все круги
    expect(order.indexOf('light')).toBeLessThan(order.lastIndexOf('heavy'));
    expect(sleeps.every((ms) => ms === 120000)).toBe(true);
    // 10 циклов по 1 паузе = 10 пауз (9 кругов карантина не было — 3 круга по 3 цикла), затем скип
    expect(sleeps.length).toBe(10);
    expect(quarantined).toEqual(['big.ts']);
    expect(skippedFiles).toEqual(['big.ts']);
    expect(result.skippedFiles).toBe(1);
    expect(result.filesAnalyzed).toBe(1);
  }, 60000);
});
