// Батч 27: Keychain — профили ключей и циклический failover.
// Unit: CRUD + миграция одиночного ключа в «default», решатель цепочки
// (retry-after, лестница 120/300/600, broken по 401, пауза min(sleepUntil),
// циклы, maxCycles, автономный выкл). e2e: ручное переключение через
// codescout.switchKeyProfile (модалка + кэш моделей изолирован), поведение
// retry-слоя при failover выключен/включён (в т.ч. fake timers для
// «цикл 2 возвращается к A»), баннер «все профили спят» с двумя кнопками,
// пикер догона показывает профили и НЕ меняет активный, i18n-контракт.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate, reviewFiles } from '../extension/src/extension';
import {
  addProfile,
  beginScan,
  decideFailover,
  FAILOVER_SLEEP_LADDER_SECONDS,
  isAsleep,
  isBroken,
  markBroken,
  markRateLimited,
  migrateLegacyKeyToDefault,
  normalizeProfiles,
  readActiveId,
  readProfiles,
  removeProfile,
  renameProfile,
  resetRuntime,
  runFailover,
  runtime,
  scanCurrentId,
  scanCycle,
  writeActiveId,
  writeProfiles,
  type KeychainProfile
} from '../extension/src/keychain';
import { pickResumeProfile } from '../extension/src/auditResume';
import { OpenAICompatibleProvider, AllProfilesAsleepError, type FailoverHooks } from '../src/llm-client';
import { clearModelsCache, fetchLiveModelsCached, resolveBaseUrl } from '../src/providers';
import { buildReportHtml } from '../extension/src/reportHtml';
import { t } from '../src/i18n';

const REAL_FETCH = globalThis.fetch;
const KEY_A = 'ZZKEYAAA_1234567890';
const KEY_B = 'ZZKEYBBB_0987654321';

function profilesFixture(): KeychainProfile[] {
  return [
    { id: 'a', label: 'Alpha', provider: 'groq' },
    { id: 'b', label: 'Beta', provider: 'openai' }
  ];
}

function okContent(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[],"summary":"ok"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function rateLimited(retryAfter?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (retryAfter) headers['retry-after'] = retryAfter;
  return new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429, headers });
}

function fileSet(count: number): Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }> {
  return Array.from({ length: count }, (_, i) => ({ filename: `src/f${i + 1}.ts`, status: 'M', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n+const x = 1;' }));
}

// Секрет-мок из vscode-stub (Map-backed) под интерфейс keychain.
function fakeSecrets(): import('../extension/src/keychain').SecretsLike {
  return (makeFakeContext() as { secrets: import('../extension/src/keychain').SecretsLike }).secrets;
}

async function waitFor(check: () => boolean, timeoutMs = 10000, stepMs = 20): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timeout; errors: ${state.errorMessages.slice(-3).join(' | ')}`);
    await flush();
  }
}

function seedTwoProfiles(): void {
  state.set('codescout.keychain', profilesFixture());
  state.set('codescout.keychain.active', 'a');
  state.secrets.set('keychain.a', KEY_A);
  state.secrets.set('keychain.b', KEY_B);
}

describe('батч 27 unit: CRUD профилей и миграция', () => {
  beforeEach(() => { state.reset(); resetRuntime(); });

  it('normalizeProfiles выбрасывает мусор, дубли id и неизвестных провайдеров', () => {
    const clean = normalizeProfiles([
      { id: 'a', label: 'Alpha', provider: 'groq', model: 'llama' },
      { id: 'a', label: 'dup', provider: 'groq' },
      { id: '', label: 'no-id', provider: 'groq' },
      { id: 'c', label: 'C', provider: 'not-a-provider' },
      { id: 'd', provider: 'openai' },
      null,
      'x'
    ]);
    expect(clean.map((p) => p.id)).toEqual(['a', 'd']);
    expect(clean[0]).toEqual({ id: 'a', label: 'Alpha', provider: 'groq', model: 'llama' });
    expect(clean[1].label).toBe('d'); // label по умолчанию = id
    expect(normalizeProfiles(undefined)).toEqual([]);
  });

  it('addProfile кладёт секрет keychain.<id> и делает первый профиль активным; rename/delete работают', async () => {
    const secrets = fakeSecrets();
    const added = await addProfile(secrets, { label: 'Main Groq', provider: 'groq', key: KEY_A, model: 'llama-x' });
    expect(readProfiles().map((p) => p.id)).toEqual([added.id]);
    expect(state.secrets.get(`keychain.${added.id}`)).toBe(KEY_A);
    expect(readActiveId()).toBe(added.id);
    const second = await addProfile(secrets, { label: 'Main Groq', provider: 'openai', key: KEY_B });
    expect(second.id).not.toBe(added.id); // дубль label → новый уникальный id
    expect(readActiveId()).toBe(added.id); // второй НЕ перетягивает актив
    await renameProfile(added.id, 'Renamed');
    expect(readProfiles().find((p) => p.id === added.id)?.label).toBe('Renamed');
    await removeProfile(secrets, second.id);
    expect(readProfiles().map((p) => p.id)).toEqual([added.id]);
    expect(state.secrets.get(`keychain.${second.id}`)).toBeUndefined();
  });

  it('удаление активного профиля без выбора нового — refused (без молчаливого фолбэка)', async () => {
    const secrets = fakeSecrets();
    await writeProfiles(profilesFixture());
    await writeActiveId('a');
    state.secrets.set('keychain.a', KEY_A);
    state.secrets.set('keychain.b', KEY_B);
    const refused = await removeProfile(secrets, 'a');
    expect(refused.ok).toBe(false);
    expect(readProfiles()).toHaveLength(2);
    expect(state.secrets.get('keychain.a')).toBe(KEY_A);
    const done = await removeProfile(secrets, 'a', 'b');
    expect(done.ok).toBe(true);
    expect(readActiveId()).toBe('b');
    expect(state.secrets.get('keychain.a')).toBeUndefined();
    // удаление НЕактивного — newActive не нужен
    const inactive = await removeProfile(secrets, 'b', 'b');
    expect(inactive.ok).toBe(false); // b теперь активен, newActive==id → отказ
  });

  it('миграция одиночного ключа → профиль default без потери: старый ключ продолжает работать', async () => {
    const context = makeFakeContext() as never;
    state.secrets.set('codescout.apiKey', KEY_A);
    state.secrets.set('codescout.provider', 'groq');
    state.secrets.set('codescout.model', 'llama-old');
    const migrated = await migrateLegacyKeyToDefault(context);
    expect(migrated).toBe(true);
    expect(readProfiles()).toEqual([{ id: 'default', label: 'default', provider: 'groq', model: 'llama-old' }]);
    expect(readActiveId()).toBe('default');
    expect(state.secrets.get('keychain.default')).toBe(KEY_A);
    // старый секрет НЕ удалён — откат и legacy-путь целы
    expect(state.secrets.get('codescout.apiKey')).toBe(KEY_A);
    // повторный activate — однократно
    expect(await migrateLegacyKeyToDefault(context)).toBe(false);
    expect(readProfiles()).toHaveLength(1);
  });

  it('миграция не трогает, если профили уже заведены (ручной CRUD важнее)', async () => {
    const context = makeFakeContext() as never;
    state.secrets.set('codescout.apiKey', KEY_A);
    await writeProfiles([{ id: 'work', label: 'Work', provider: 'openai' }]);
    expect(await migrateLegacyKeyToDefault(context)).toBe(false);
    expect(readProfiles().map((p) => p.id)).toEqual(['work']);
    expect(state.secrets.get('keychain.work')).toBeUndefined();
  });
});

describe('батч 27 unit: решатель цепочки (failover)', () => {
  const NOW = 1_000_000;
  const chainProfiles = profilesFixture();
  const ctx = (overrides = {}) => ({ profiles: chainProfiles, currentId: 'a', allowWaitOnce: false, cycle: 0, ...overrides });
  const AUTO = { autonomous: true, maxCycles: 0 };

  beforeEach(() => { resetRuntime(); });

  it('429 с retry-after → A засыпает на точное время, следующий awake = B', () => {
    const res = decideFailover(ctx(), AUTO, 300, NOW);
    expect(res.decision.kind).toBe('switch');
    if (res.decision.kind === 'switch') {
      expect(res.decision.profile.id).toBe('b');
      expect(res.decision.fromLabel).toBe('Alpha');
      expect(res.decision.sleepSeconds).toBe(300);
    }
    expect(runtime.get('a')!.sleepUntil).toBe(NOW + 300_000);
    expect(isAsleep('a', NOW + 299_999)).toBe(true);
    expect(isAsleep('a', NOW + 300_000)).toBe(false);
  });

  it('429 без retry-after — лестница 120/300/600 на профиль', () => {
    expect(markRateLimited('a', NOW, undefined)).toBe(FAILOVER_SLEEP_LADDER_SECONDS[0]);
    expect(markRateLimited('a', NOW, undefined)).toBe(FAILOVER_SLEEP_LADDER_SECONDS[1]);
    expect(markRateLimited('a', NOW, undefined)).toBe(FAILOVER_SLEEP_LADDER_SECONDS[2]);
    expect(markRateLimited('a', NOW, undefined)).toBe(600); // плато
  });

  it('401 → broken, НЕ asleep; broken не участвует в цепочке и циклы по нему не ходят', () => {
    markBroken('b');
    expect(isBroken('b')).toBe(true);
    expect(isAsleep('b', NOW)).toBe(false);
    expect(runtime.get('b')!.sleepUntil).toBe(0);
    const res = decideFailover(ctx(), AUTO, 30, NOW);
    // единственная кандидатура b отброшена → switch запрещён;
    // все awake-не-b отсутствуют → путь wait/stop, НЕ переключение
    expect(res.decision.kind === 'switch' && res.decision.profile.id === 'b').toBe(false);
    // после 429 на a он спит, b broken → нет живых соседей
    if (res.decision.kind === 'wait') {
      expect(res.decision.wakeLabel).toBe('Alpha');
    }
  });

  it('все спят → пауза = min(sleepUntil) − now; цикл инкрементируется только на паузе', () => {
    runtime.set('a', { sleepUntil: NOW + 5000, ladderStep: 0, broken: false });
    runtime.set('b', { sleepUntil: NOW + 2000, ladderStep: 0, broken: false });
    const res = decideFailover(ctx(), AUTO, 9000, NOW);
    expect(res.decision.kind).toBe('wait');
    if (res.decision.kind === 'wait') {
      expect(res.decision.waitMs).toBeLessThanOrEqual(2000);
      expect(res.decision.wakeLabel).toBe('Beta');
      expect(res.decision.cycle).toBe(1);
    }
    expect(res.cycle).toBe(1);
    // второй вызов при том же времени — тоже wait, cycle 2
    const second = decideFailover({ ...ctx(), cycle: 1 }, AUTO, 9000, NOW);
    expect(second.decision.kind).toBe('wait');
    expect(second.cycle).toBe(2);
  });

  it('цикличность: после конца списка возврат к A, чья квота освежилась', () => {
    runtime.set('a', { sleepUntil: NOW + 1000, ladderStep: 0, broken: false });
    // B активен и получил 429; A ещё спит → b→a нет, a→нет, стоп/вейт
    const whileAsleep = decideFailover({ profiles: [...chainProfiles].reverse(), currentId: 'b', allowWaitOnce: false, cycle: 0 }, AUTO, 300, NOW);
    expect(whileAsleep.decision.kind === 'switch' && (whileAsleep.decision as { profile: KeychainProfile }).profile.id).toBe(false);
    // время прошло — A проснулся
    const later = decideFailover({ profiles: [...chainProfiles].reverse(), currentId: 'b', allowWaitOnce: false, cycle: 1 }, AUTO, 300, NOW + 2000);
    expect(later.decision.kind).toBe('switch');
    if (later.decision.kind === 'switch') expect(later.decision.profile.id).toBe('a');
  });

  it('автономный ВЫКЛ: один полный круг спящих → stop (баннер); «подождать» даёт ровно одну паузу', () => {
    runtime.set('a', { sleepUntil: NOW + 5000, ladderStep: 0, broken: false });
    runtime.set('b', { sleepUntil: NOW + 4000, ladderStep: 0, broken: false });
    const off = { autonomous: false, maxCycles: 0 };
    const res = decideFailover(ctx(), off, 9000, NOW);
    expect(res.decision).toMatchObject({ kind: 'stop', reason: 'allSleep' });
    // пользователь нажал «Подождать и продолжить» — разовое разрешение
    const granted = decideFailover({ ...ctx(), allowWaitOnce: true }, off, 9000, NOW);
    expect(granted.decision.kind).toBe('wait');
    expect(granted.allowWaitOnce).toBe(false);
    // следующий круг — снова stop (баннер), пока человек не подтвердит
    const again = decideFailover({ ...ctx(), allowWaitOnce: false }, off, 9000, NOW);
    expect(again.decision.kind).toBe('stop');
  });

  it('maxCycles=2: стоп после второго круга с баннером-причиной', () => {
    runtime.set('a', { sleepUntil: NOW + 5000, ladderStep: 0, broken: false });
    runtime.set('b', { sleepUntil: NOW + 4000, ladderStep: 0, broken: false });
    const maxed = { autonomous: true, maxCycles: 2 };
    expect(decideFailover(ctx(), maxed, 9000, NOW).decision.kind).toBe('wait');
    const second = decideFailover({ ...ctx(), cycle: 1 }, maxed, 9000, NOW);
    expect(second.decision.kind).toBe('wait');
    expect(second.cycle).toBe(2);
    const third = decideFailover({ ...ctx(), cycle: 2 }, maxed, 9000, NOW);
    expect(third.decision).toMatchObject({ kind: 'stop', reason: 'maxCycles' });
  });

  it('runFailover — состояние скана: switch двигает currentId, wait двигает cycle', () => {
    state.reset();
    seedTwoProfiles();
    beginScan('a');
    const first = runFailover(300, { autonomous: true, maxCycles: 0 }, NOW);
    expect(first.kind).toBe('switch');
    expect(scanCycle()).toBe(0);
    runtime.set('b', { sleepUntil: NOW + 300_000, ladderStep: 1, broken: false });
    const second = runFailover(300, { autonomous: true, maxCycles: 0 }, NOW);
    expect(second.kind).toBe('wait');
    expect(scanCycle()).toBe(1);
  });
});

describe('батч 27 e2e: ручное переключение профилей', () => {
  beforeEach(() => {
    state.reset();
    resetRuntime();
    clearModelsCache();
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = REAL_FETCH; });

  it('switchKeyProfile: QuickPick → модалка подтверждения → persist активного; legacy-секреты не тронуты', async () => {
    seedTwoProfiles();
    activate(makeFakeContext() as never);
    await flush();
    state.quickPickAnswers.push({ profileId: 'b' });
    state.warningAnswers.push(t('keychain.switchConfirmBtn', 'ru'));
    await (state.commands.get('codescout.switchKeyProfile') as () => Promise<unknown>)();
    await waitFor(() => readActiveId() === 'b');
    expect(state.secrets.get('codescout.apiKey')).toBeUndefined();
    expect(state.secrets.get('keychain.a')).toBe(KEY_A);
    expect(state.quickPickCalls.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('switchKeyProfile: отмена модалки — актив НЕ меняется', async () => {
    seedTwoProfiles();
    activate(makeFakeContext() as never);
    await flush();
    state.quickPickAnswers.push({ profileId: 'b' });
    await (state.commands.get('codescout.switchKeyProfile') as () => Promise<unknown>)();
    await flush();
    expect(readActiveId()).toBe('a');
  }, 30000);

  it('кэш моделей изолирован между профилями: список профиля B не берётся из кэша A', async () => {
    seedTwoProfiles();
    activate(makeFakeContext() as never);
    await flush();
    let modelCalls = 0;
    const hosts: string[] = [];
    globalThis.fetch = (async (url: string | URL | undefined, init?: { headers?: Record<string, string> }) => {
      modelCalls += 1;
      hosts.push(String((init?.headers ?? {}).Authorization ?? ''));
      const auth = String((init?.headers ?? {}).Authorization ?? '');
      const id = auth.includes(KEY_A) ? 'model-of-a' : 'model-of-b';
      return new Response(JSON.stringify({ data: [{ id }] }), { status: 200 });
    }) as typeof fetch;
    // профиль A: два запроса → второй из кэша (network 1)
    const listA = await fetchLiveModelsCached(resolveBaseUrl('groq'), KEY_A, fetch, 1000, 'groq', () => {}, true);
    const listA2 = await fetchLiveModelsCached(resolveBaseUrl('groq'), KEY_A, fetch, 1000, 'groq', () => {}, true);
    expect(listA).toEqual(['model-of-a']);
    expect(listA2).toEqual(['model-of-a']);
    expect(modelCalls).toBe(1);
    // переключение на B → обязано сходить в СВОЮ сеть, список другой
    state.quickPickAnswers.push({ profileId: 'b' });
    state.warningAnswers.push(t('keychain.switchConfirmBtn', 'ru'));
    await (state.commands.get('codescout.switchKeyProfile') as () => Promise<unknown>)();
    await waitFor(() => readActiveId() === 'b');
    const listB = await fetchLiveModelsCached(resolveBaseUrl('openai'), KEY_B, fetch, 1000, 'openai', () => {}, true);
    expect(listB).toEqual(['model-of-b']);
    expect(modelCalls).toBeGreaterThanOrEqual(2);
    expect(hosts.some((h) => h.includes(KEY_B))).toBe(true);
  }, 30000);
});

describe('батч 27 retry-слой: failover выключен / включён', () => {
  beforeEach(() => {
    state.reset();
    resetRuntime();
    clearModelsCache();
  });
  afterEach(() => { globalThis.fetch = REAL_FETCH; vi.useRealTimers(); });

  it('failover.enabled=false: 429 → старое поведение лестницы, ноль переключений', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    seedTwoProfiles();
    const seen: string[] = [];
    const sleeps: number[] = [];
    const fetcher = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(String(init?.headers?.Authorization ?? ''));
      return rateLimited();
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider(KEY_A, 'm1', fetcher, async (ms: number) => {
      sleeps.push(ms);
      await vi.advanceTimersByTimeAsync(ms);
    }, undefined, 'https://api.groq.com/openai/v1', undefined, undefined, undefined);
    await expect(provider.review('s', 'u')).rejects.toBeTruthy();
    expect(seen.every((auth) => auth.includes(KEY_A))).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(4); // первая попытка + 3 ступени лестницы
    expect(sleeps).toEqual([30000, 60000, 120000]);
    // failover-состояние не двигалось: ни сна, ни switch по keychain
    expect(runtime.get('a')?.sleepUntil ?? 0).toBe(0);
    expect(runtime.get('b')?.sleepUntil ?? 0).toBe(0);
  }, 60000);

  it('failover.enabled=true (e2e через reviewFiles): 429 на A → переход на B; A.sleepUntil из retry-after', async () => {
    const startedAt = Date.now();
    seedTwoProfiles();
    state.set('codescout.failover.enabled', true);
    const seen: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? '');
      seen.push(auth);
      if (auth.includes(KEY_A)) return rateLimited('1');
      return okContent();
    }) as unknown as typeof fetch;
    const result = await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
    expect(result.filesAnalyzed).toBe(1);
    expect(result.skippedFiles).toBe(0);
    expect(seen[0]).toContain(KEY_A);
    expect(seen[seen.length - 1]).toContain(KEY_B);
    expect(runtime.get('a')!.sleepUntil).toBeGreaterThanOrEqual(startedAt + 1000);
  }, 60000);

  it('failover включен: B тоже 429 → пауза min(sleepUntil) → цикл 2 возвращается к A (fake timers)', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    state.reset();
    seedTwoProfiles();
    beginScan('a');
    const seen: Array<{ auth: string; at: number }> = [];
    const fetcher = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? '');
      const now = Date.now();
      seen.push({ auth, at: now });
      // A отдаёт 429 с ra=300 до истечения сна; после 300с квота освежилась
      if (auth.includes(KEY_A)) return now >= 1_000_000 + 300_000 ? okContent() : rateLimited('300');
      return rateLimited('100');
    }) as unknown as typeof fetch;
    const hooks: FailoverHooks = {
      async onRateLimit(waitSeconds) {
        const decision = runFailover(waitSeconds, { autonomous: true, maxCycles: 0 });
        if (decision.kind === 'switch') {
          const key = decision.profile.id === 'a' ? KEY_A : KEY_B;
          return { action: 'switch', apiKey: key, baseUrl: resolveBaseUrl(decision.profile.provider), model: 'm' } as const;
        }
        if (decision.kind === 'wait') return { action: 'wait', waitMs: decision.waitMs } as const;
        if (decision.kind === 'stop') return { action: 'stop', waitMs: decision.waitMs, wakeLabel: decision.wakeLabel } as const;
        return undefined;
      },
      async onAuthError() { /* нет auth-сценария здесь */ }
    };
    const provider = new OpenAICompatibleProvider(
      KEY_A, 'm1', fetcher,
      async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); },
      undefined, 'https://api.groq.com/openai/v1', undefined, undefined, hooks
    );
    const content = await provider.review('s', 'u');
    expect(JSON.parse(content).issues).toEqual([]);
    expect(seen[0].auth).toContain(KEY_A);
    expect(seen.some((entry) => entry.auth.includes(KEY_B))).toBe(true);
    // после конца цепочки — возврат к A, чья квота освежилась: финальный запрос на A
    expect(seen[seen.length - 1].auth).toContain(KEY_A);
    expect(scanCycle()).toBeGreaterThanOrEqual(1);
    expect(runtime.get('a')!.sleepUntil).toBe(1_000_000 + 300_000); // из retry-after
  }, 60000);

  it('401 на профиле → broken, не asleep; follow-up 429 не возвращается на broken', async () => {
    vi.useFakeTimers({ now: 2_000_000 });
    state.reset();
    seedTwoProfiles();
    beginScan('a');
    const calls: string[] = [];
    const fetcher = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? '');
      calls.push(auth);
      if (auth.includes(KEY_A)) return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 });
      return okContent();
    }) as unknown as typeof fetch;
    const hooks: FailoverHooks = {
      async onRateLimit(waitSeconds) {
        const decision = runFailover(waitSeconds, { autonomous: true, maxCycles: 0 });
        if (decision.kind === 'switch') return { action: 'switch', apiKey: KEY_B, baseUrl: 'https://api.openai.com/v1', model: 'm' } as const;
        return undefined;
      },
      async onAuthError() { markBroken(scanCurrentId()); }
    };
    const provider = new OpenAICompatibleProvider(KEY_A, 'm', fetcher, async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); }, undefined, 'https://api.groq.com/openai/v1', undefined, undefined, hooks);
    await expect(provider.review('s', 'u')).rejects.toBeTruthy();
    expect(isBroken('a')).toBe(true);
    expect(isAsleep('a', Date.now())).toBe(false);
    // автопереход по 401 запрещён: ни одного запроса с ключом B
    expect(calls.every((auth) => auth.includes(KEY_A))).toBe(true);
  }, 60000);

  it('AllProfilesAsleepError при stop-решении (автономный выкл, все спят)', async () => {
    vi.useFakeTimers({ now: 3_000_000 });
    state.reset();
    seedTwoProfiles();
    beginScan('a');
    // B уже спит глубже: единственный круг спящих → stop без ожидания
    runtime.set('b', { sleepUntil: 3_000_000 + 1_200_000, ladderStep: 0, broken: false });
    const fetcher = (async () => rateLimited('600')) as unknown as typeof fetch;
    const hooks: FailoverHooks = {
      async onRateLimit(waitSeconds) {
        const decision = runFailover(waitSeconds, { autonomous: false, maxCycles: 0 });
        if (decision.kind === 'wait') return { action: 'wait', waitMs: decision.waitMs } as const;
        if (decision.kind === 'stop') return { action: 'stop', waitMs: decision.waitMs, wakeLabel: decision.wakeLabel } as const;
        return undefined;
      },
      async onAuthError() {}
    };
    const provider = new OpenAICompatibleProvider(KEY_A, 'm', fetcher, async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); }, undefined, 'https://api.groq.com/openai/v1', undefined, undefined, hooks);
    await expect(provider.review('s', 'u')).rejects.toBeInstanceOf(AllProfilesAsleepError);
  }, 60000);
});

describe('батч 27 e2e: баннер «Все профили спят»', () => {
  const stats = { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 };

  it('RU и EN: две кнопки «Подождать и продолжить» / «Стоп», EN без кириллицы', () => {
    const sleep = { wakeSeconds: 42, wakeLabel: 'Beta' };
    const base = [stats, false, true, '', 'retry', 'k', true, 'g', 'm', false, '', false, 'new', undefined, '', undefined, undefined, false, 0, 0, undefined, 'n', undefined] as const;
    const ru = buildReportHtml([], ...base, 'ru', {}, '', undefined, undefined, sleep);
    expect(ru).toContain('Все профили ключей спят');
    expect(ru).toContain('Beta через 42с');
    expect(ru).toContain('data-command="failoverWaitResume"');
    expect(ru).toContain('Подождать и продолжить');
    expect(ru).toContain('data-command="failoverDismiss"');
    expect(ru).toContain('Стоп');
    const en = buildReportHtml([], ...base, 'en', {}, '', undefined, undefined, sleep);
    expect(en).toContain('All key profiles are asleep');
    expect(en).toContain('data-command="failoverWaitResume"');
    expect(en).toContain('Wait and continue');
    expect(en).toContain('data-command="failoverDismiss"');
    expect(en).not.toMatch(/[\u0400-\u04FF]/);
  });

  it('баннер скрыт во время скана (приоритет у живого скана)', () => {
    const base = [stats, true, false, '', 'retry', 'k', true, 'g', 'm', false, '', false, 'new', undefined, '', undefined, undefined, false, 0, 0, undefined, 'n', undefined] as const;
    const html = buildReportHtml([], ...base, 'ru', {}, '', undefined, undefined, { wakeSeconds: 10, wakeLabel: 'B' });
    expect(html).not.toContain('failoverWaitResume');
  });
});

describe('батч 27 e2e: пикер догона показывает профили и не меняет активный', () => {
  beforeEach(() => {
    state.reset();
    resetRuntime();
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = REAL_FETCH; });

  it('pickResumeProfile: список provider · label · model; выбор НЕ пишет keychain.active', async () => {
    seedTwoProfiles();
    state.quickPickAnswers.push({ profileId: 'b', label: 'openai · Beta', description: 'gpt-x' });
    const target = await pickResumeProfile({
      lang: 'ru',
      profiles: readProfiles(),
      resolveKeyForProfile: async (profile) => (profile.id === 'b' ? KEY_B : KEY_A),
      resolveBaseUrlFor: async (provider) => resolveBaseUrl(provider),
      log: () => {}
    });
    expect(target).toBeDefined();
    expect(target!.label).toBe('Beta');
    expect(target!.key).toBe(KEY_B);
    // разовый маршрут: активный профиль настроек не тронут
    expect(readActiveId()).toBe('a');
    expect(state.secrets.get('codescout.provider')).toBeUndefined();
    // QuickPick получал именно профили (2 строки), а не PROVIDER_ORDER
    const items = state.quickPickCalls[0][0] as Array<{ label: string }>;
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.label)).toEqual(['groq · Alpha', 'openai · Beta']);
  });

  it('pickResumeProfile: отмена = undefined, без изменений', async () => {
    seedTwoProfiles();
    const target = await pickResumeProfile({
      lang: 'ru',
      profiles: readProfiles(),
      resolveKeyForProfile: async () => KEY_A,
      resolveBaseUrlFor: async (provider) => resolveBaseUrl(provider),
      log: () => {}
    });
    expect(target).toBeUndefined();
    expect(readActiveId()).toBe('a');
  });
});

describe('батч 27 i18n-контракт', () => {
  it('все keychain.*-ключи есть в обоих словарях; EN без кириллицы', () => {
    const ru = JSON.parse(readFileSync('src/i18n/ru.json', 'utf8')) as Record<string, string>;
    const en = JSON.parse(readFileSync('src/i18n/en.json', 'utf8')) as Record<string, string>;
    const keychainKeys = Object.keys(ru).filter((key) => key.startsWith('keychain.'));
    expect(keychainKeys.length).toBeGreaterThanOrEqual(30);
    for (const key of keychainKeys) {
      expect(typeof en[key]).toBe('string');
      expect(en[key]).not.toMatch(/[\u0400-\u04FF]/);
      expect(ru[key].length).toBeGreaterThan(0);
    }
    // множества ключей 1:1 по-прежнему (контракт v1.4b-5 закрывает total,
    // здесь — проверка, что батч 27 не разъехался)
    expect(Object.keys(ru).filter((k) => k.startsWith('keychain.')).sort()).toEqual(Object.keys(en).filter((k) => k.startsWith('keychain.')).sort());
  });

  it('настройки батча 27 в манифесте + nls (EN без кириллицы, RU с русским)', () => {
    const manifest = readFileSync('extension/package.json', 'utf8');
    const props = JSON.parse(manifest).contributes.configuration.properties;
    expect(props['codescout.keychain']).toMatchObject({ type: 'array' });
    expect(props['codescout.keychain.active']).toMatchObject({ type: 'string', default: '' });
    expect(props['codescout.failover.enabled']).toMatchObject({ type: 'boolean', default: false });
    expect(props['codescout.failover.maxCycles']).toMatchObject({ type: 'number', default: 0, minimum: 0, maximum: 100 });
    const nlsEn = JSON.parse(readFileSync('extension/package.nls.json', 'utf8')) as Record<string, string>;
    const nlsRu = JSON.parse(readFileSync('extension/package.nls.ru.json', 'utf8')) as Record<string, string>;
    for (const key of ['keychain.description', 'keychainActive.description', 'failoverEnabled.description', 'failoverMaxCycles.description']) {
      expect(nlsEn[key]).toBeDefined();
      expect(nlsEn[key]).not.toMatch(/[\u0400-\u04FF]/);
      expect(nlsRu[key]).toMatch(/[\u0400-\u04FF]/);
    }
    expect(manifest).toContain('codescout.switchKeyProfile');
  });
});
