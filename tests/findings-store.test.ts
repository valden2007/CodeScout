// Батч 14: юнит-тесты хранилища скрытых находок (findingsStore).
// Memento мокируется через workspaceState из vscode-stub (тот же контракт get/update).
import { describe, expect, it, beforeEach } from 'vitest';
import { makeFakeContext, state } from './vscode-stub';
import { clearSuppressedFindings, computeFingerprint, filterSuppressed, getSuppressedFindings, suppressFinding, unsuppressFinding } from '../extension/src/findingsStore';
import { ReviewIssue } from '../src/types';

interface FakeMemento {
  get(key: string): unknown;
  update(key: string, value: unknown): Promise<void>;
}

function makeMemento(): FakeMemento {
  const context = makeFakeContext();
  return (context as unknown as { workspaceState: FakeMemento }).workspaceState;
}

const asMemento = (fake: FakeMemento) => fake as never;

function issue(overrides: Partial<ReviewIssue>): ReviewIssue {
  return { file: 'src/a.ts', line: 10, category: 'bug', severity: 'medium', description: 'd', confidence: 0.7, ...overrides };
}

describe('батч 14: findingsStore CRUD', () => {
  let store: FakeMemento;
  beforeEach(() => {
    state.reset();
    store = makeMemento();
  });

  it('suppress → get возвращает fingerprint; повторное подавление не дублирует; пустой ключ игнорируется', () => {
    expect(getSuppressedFindings(asMemento(store))).toEqual([]);
    suppressFinding(asMemento(store), 'fp-one');
    suppressFinding(asMemento(store), 'fp-one');
    suppressFinding(asMemento(store), '  ');
    expect(getSuppressedFindings(asMemento(store))).toEqual(['fp-one']);
  });

  it('unsuppress удаляет только указанный fingerprint', () => {
    suppressFinding(asMemento(store), 'fp-a');
    suppressFinding(asMemento(store), 'fp-b');
    unsuppressFinding(asMemento(store), 'fp-a');
    unsuppressFinding(asMemento(store), 'нет-такого');
    expect(getSuppressedFindings(asMemento(store))).toEqual(['fp-b']);
  });

  it('clear чистит всё; битые данные в сторе не роняют get', async () => {
    suppressFinding(asMemento(store), 'fp-x');
    clearSuppressedFindings(asMemento(store));
    expect(getSuppressedFindings(asMemento(store))).toEqual([]);
    await store.update('codescout.suppressedFindings', ['ok', 42, null, '', '  ', ' also ']);
    expect(getSuppressedFindings(asMemento(store))).toEqual(['ok', ' also ']);
    await store.update('codescout.suppressedFindings', 'не-массив');
    expect(getSuppressedFindings(asMemento(store))).toEqual([]);
  });

  it('хранение — workspaceState, а не globalState (project-local)', () => {
    const context = makeFakeContext() as unknown as { workspaceState: FakeMemento; globalState: { get(key: string): unknown } };
    suppressFinding(asMemento(context.workspaceState), 'fp-ws');
    expect(context.globalState.get('codescout.suppressedFindings')).toBeUndefined();
    expect(getSuppressedFindings(asMemento(context.workspaceState))).toEqual(['fp-ws']);
  });
});

describe('батч 14: fingerprint с радиусом ±3 строки', () => {
  it('строки 10 и 12 при том же file/severity/category — один fingerprint', () => {
    expect(computeFingerprint(issue({ line: 10 }))).toBe(computeFingerprint(issue({ line: 12 })));
    expect(computeFingerprint(issue({ line: 10 }))).toBe(computeFingerprint(issue({ line: 8 })));
    expect(computeFingerprint(issue({ line: 10 }))).toBe(computeFingerprint(issue({ line: 13 })));
  });

  it('смена file/severity/category/далёкой строки меняет fingerprint', () => {
    const base = computeFingerprint(issue({ line: 10 }));
    expect(computeFingerprint(issue({ line: 10, file: 'src/b.ts' }))).not.toBe(base);
    expect(computeFingerprint(issue({ line: 10, severity: 'high' }))).not.toBe(base);
    expect(computeFingerprint(issue({ line: 10, category: 'security' }))).not.toBe(base);
    expect(computeFingerprint(issue({ line: 30 }))).not.toBe(base);
  });

  it('нормализация пути: backslash и регистр не создают дублей', () => {
    expect(computeFingerprint(issue({ file: 'src\\Sub\\A.TS' }))).toBe(computeFingerprint(issue({ file: 'src/sub/a.ts' })));
  });
});

describe('батч 14: filterSuppressed', () => {
  let store: FakeMemento;
  beforeEach(() => {
    state.reset();
    store = makeMemento();
  });

  it('навешивает fingerprint на возвращаемые находки и не мутирует вход', () => {
    const input = [issue({ line: 10 })];
    const out = filterSuppressed(input, asMemento(store));
    expect(out[0].fingerprint).toBe(computeFingerprint(issue({ line: 10 })));
    expect(input[0].fingerprint).toBeUndefined();
  });

  it('исключает подавленные по fingerprint, включая ±3 строки (сдвиг нумерации моделью)', () => {
    const findings = [issue({ description: 'FP-CARD', line: 10 }), issue({ description: 'KEEP', line: 50 })];
    const visible = filterSuppressed(findings, asMemento(store));
    suppressFinding(asMemento(store), visible[0].fingerprint as string);
    const rescan = filterSuppressed([issue({ description: 'FP-CARD', line: 12 }), issue({ description: 'KEEP', line: 51 })], asMemento(store));
    expect(rescan.map((item) => item.description)).toEqual(['KEEP']);
  });

  it('unsuppress возвращает находку на панель', () => {
    const fp = computeFingerprint(issue({ description: 'X', line: 10 }));
    suppressFinding(asMemento(store), fp);
    expect(filterSuppressed([issue({ description: 'X', line: 10 })], asMemento(store))).toHaveLength(0);
    unsuppressFinding(asMemento(store), fp);
    expect(filterSuppressed([issue({ description: 'X', line: 10 })], asMemento(store))).toHaveLength(1);
  });
});
