// Батч 20b: юнит-тесты хранилища подавленных находок (findingsStore).
// Memento мокируется через workspaceState из vscode-stub (тот же контракт get/update).
import { describe, expect, it, beforeEach } from 'vitest';
import { makeFakeContext, state } from './vscode-stub';
import {
  LINE_TOLERANCE,
  clearSuppressed,
  computeFingerprint,
  filterSuppressed,
  getSuppressed,
  isSuppressed,
  legacyBucketFingerprint,
  suppress,
  unsuppress
} from '../extension/src/findingsStore';
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
  return { file: 'src/a.ts', line: 10, category: 'bug', severity: 'medium', description: 'd', confidence: 70, ...overrides };
}

describe('батч 20b: findingsStore CRUD', () => {
  let store: FakeMemento;
  beforeEach(() => {
    state.reset();
    store = makeMemento();
  });

  it('suppress хранит запись с метаданными; повторный suppress не дублирует', () => {
    expect(getSuppressed(asMemento(store))).toEqual([]);
    const entry = suppress(asMemento(store), issue({ line: 10, description: 'SQLi' }));
    suppress(asMemento(store), issue({ line: 10, description: 'SQLi' }));
    const list = getSuppressed(asMemento(store));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: entry.id, file: 'src/a.ts', line: 10, severity: 'medium', category: 'bug', description: 'SQLi' });
  });

  it('пересекающиеся зоны (±3) схлопываются в одну запись — «Вернуть» одним кликом', () => {
    suppress(asMemento(store), issue({ line: 10 }));
    suppress(asMemento(store), issue({ line: 12 }));
    const list = getSuppressed(asMemento(store));
    expect(list).toHaveLength(1);
    expect(list[0].line).toBe(12);
  });

  it('unsuppress удаляет только указанный fingerprint; пустой id игнорируется', () => {
    const a = suppress(asMemento(store), issue({ line: 10 }));
    const b = suppress(asMemento(store), issue({ line: 50 }));
    unsuppress(asMemento(store), a.id);
    unsuppress(asMemento(store), '  ');
    unsuppress(asMemento(store), 'нет-такого');
    expect(getSuppressed(asMemento(store)).map((entry) => entry.id)).toEqual([b.id]);
  });

  it('clear чистит всё; битые данные в сторе не роняют get', async () => {
    suppress(asMemento(store), issue({ line: 10 }));
    clearSuppressed(asMemento(store));
    expect(getSuppressed(asMemento(store))).toEqual([]);
    await store.update('codescout.suppressedFindings', ['fp-legacy', 42, null, { nope: 1 }, { id: 'ok', file: 'a.ts', line: 3, severity: 'low', category: 'bug', description: 'd', hiddenAt: 7 }]);
    const list = getSuppressed(asMemento(store));
    expect(list.map((entry) => entry.id)).toEqual(['ok', 'fp-legacy']);
    await store.update('codescout.suppressedFindings', 'не-массив');
    expect(getSuppressed(asMemento(store))).toEqual([]);
  });

  it('хранение — workspaceState, а не globalState (project-local)', () => {
    const context = makeFakeContext() as unknown as { workspaceState: FakeMemento; globalState: { get(key: string): unknown } };
    suppress(asMemento(context.workspaceState), issue({ line: 10 }));
    expect(context.globalState.get('codescout.suppressedFindings')).toBeUndefined();
    expect(getSuppressed(asMemento(context.workspaceState))).toHaveLength(1);
  });
});

describe('батч 20b: fingerprint и допуск ±3 строки', () => {
  it('fingerprint — file+severity+category+строка; другие строки/поля дают другой id', () => {
    const base = computeFingerprint(issue({ line: 10 }));
    expect(computeFingerprint(issue({ line: 10 }))).toBe(base);
    expect(computeFingerprint(issue({ line: 11 }))).not.toBe(base);
    expect(computeFingerprint(issue({ line: 10, file: 'src/b.ts' }))).not.toBe(base);
    expect(computeFingerprint(issue({ line: 10, severity: 'high' }))).not.toBe(base);
    expect(computeFingerprint(issue({ line: 10, category: 'security' }))).not.toBe(base);
  });

  it('нормализация пути: backslash и регистр не создают дублей', () => {
    expect(computeFingerprint(issue({ file: 'src\\Sub\\A.TS' }))).toBe(computeFingerprint(issue({ file: 'src/sub/a.ts' })));
  });

  it('допуск ровно ±3: строки 7..13 подавлены записью на 10, а 6 и 14 — нет', () => {
    state.reset();
    const store = makeMemento();
    suppress(asMemento(store), issue({ line: 10 }));
    const entries = getSuppressed(asMemento(store));
    expect(LINE_TOLERANCE).toBe(3);
    for (const line of [7, 8, 9, 10, 11, 12, 13]) expect(isSuppressed(issue({ line }), entries), String(line)).toBe(true);
    expect(isSuppressed(issue({ line: 6 }), entries)).toBe(false);
    expect(isSuppressed(issue({ line: 14 }), entries)).toBe(false);
  });

  it('смена файла/severity/category в пределах ±3 — другая зона, не подавлена', () => {
    const entries = [suppress(asMemento(makeMemento()), issue({ line: 10 }))];
    expect(isSuppressed(issue({ line: 11, file: 'src/b.ts' }), entries)).toBe(false);
    expect(isSuppressed(issue({ line: 11, severity: 'high' }), entries)).toBe(false);
    expect(isSuppressed(issue({ line: 11, category: 'docs' }), entries)).toBe(false);
  });

  it('наследие батча 14: строка-бакет-хэш подавляет ровно свою старую зону', () => {
    state.reset();
    const store = makeMemento();
    void store.update('codescout.suppressedFindings', [legacyBucketFingerprint(issue({ line: 10 }))]);
    const entries = getSuppressed(asMemento(store));
    expect(isSuppressed(issue({ line: 10 }), entries)).toBe(true);
    expect(isSuppressed(issue({ line: 50 }), entries)).toBe(false);
  });
});

describe('батч 20b: filterSuppressed', () => {
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

  it('исключает подавленные, включая сдвиг строки моделью в пределах ±3', () => {
    const findings = [issue({ description: 'FP-CARD', line: 10 }), issue({ description: 'KEEP', line: 50 })];
    const visible = filterSuppressed(findings, asMemento(store));
    suppress(asMemento(store), visible[0]);
    const rescan = filterSuppressed([issue({ description: 'FP-CARD', line: 12 }), issue({ description: 'KEEP', line: 51 })], asMemento(store));
    expect(rescan.map((item) => item.description)).toEqual(['KEEP']);
  });

  it('unsuppress возвращает находку на панель', () => {
    const entry = suppress(asMemento(store), issue({ description: 'X', line: 10 }));
    expect(filterSuppressed([issue({ description: 'X', line: 10 })], asMemento(store))).toHaveLength(0);
    unsuppress(asMemento(store), entry.id);
    expect(filterSuppressed([issue({ description: 'X', line: 10 })], asMemento(store))).toHaveLength(1);
  });
});
