import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, makeFakeContext } from './vscode-stub';
import { reviewFiles } from '../extension/src/extension';
import { makeDocsResolver } from '../extension/src/projectAudit';

const realFetch = globalThis.fetch;

describe('v1.4b-16 секционный RAG e2e', () => {
  let root = '';
  beforeEach(() => {
    state.reset();
    root = mkdtempSync(join(tmpdir(), 'cs-rag-e2e-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'w.ts'), 'export const x = 1;\n', 'utf8');
    state.workspaceRoot = root;
    state.secrets.set('codescout.apiKey', 'AIzaTESTKEY55555');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  });

  it('в промпте файла есть близкая секция доков и НЕТ далёкой', async () => {
    const captured: string[] = [];
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      captured.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[],"summary":"ok"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const sections = [
      { heading: 'Widget flux', body: '## Widget flux\nflux capacitor widget protocol handler docs for setup' },
      { heading: 'Quantum', body: '## Quantum\nquantum chroniton unrelated prose nothing similar here' }
    ];
    const logs: string[] = [];
    const resolver = makeDocsResolver(sections, 24 * 1024, (message) => logs.push(message));
    const result = await reviewFiles(
      makeFakeContext() as never,
      [{ filename: 'src/w.ts', status: 'M', additions: 3, deletions: 0, patch: '@@ -1 +1,3 @@\n+flux capacitor widget protocol handler\n+const widget = flux;\n+export default handler;' }],
      undefined, () => {}, undefined, undefined, undefined, 'BASE SYSTEM PROMPT', false, undefined, undefined, undefined, 1, undefined, 0, undefined, async () => {}, 'ru', 0, undefined, resolver
    );
    expect(result.filesAnalyzed).toBe(1);
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain('flux capacitor widget protocol handler docs');
    expect(captured[0]).toContain('CODESCOUT_DOCS_BEGIN');
    expect(captured[0]).not.toContain('quantum chroniton');
    expect(logs[0]).toMatch(/^📄 доки: 1 секций, \d+KB для файла src\/w\.ts$/);
  }, 30000);
});
