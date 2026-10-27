// МИКРО-БАТЧ 28.5: квота участвует в ротации, редактирование в своей
// карточке, защита от entity-галлюцинаций.
// Контракты:
//  1) quota: скип файла с категорией quota доезжает до failover-хука
//     (усыпить ключ — retry-after/лестница 120/300/600 — и ротнуть; Output
//     «🔑 failover: … (quota; … спит Nс)»); после ротации счётчик breaker
//     сбрасывается и pointless-скипов нет. Failover выключен → мгновенный
//     скип БЕЗ локальной billing-лестницы. МИКРО-БАТЧ 28.6: в аудите вместо
//     серии скипов работают quota-паузы циклами (см. batch28-6), а
//     skipBreakerFeed снова НЕ трогает категорию quota (у неё свой механизм);
//  2) форма редактирования монтируется в слот КЛИКНУТОЙ карточки, заголовок
//     = «Редактирование: <label>» / «Новый профиль», иконка следует режиму;
//  3) анти-entity: правило HTML ENTITY GUARD в промпте (EN в базе, RU в
//     withReportLanguage), пост-фильтр парсера + счётчик в Output
//     «🧹 отброшено entity-артефактов: N».
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate, reviewFiles } from '../extension/src/extension';
import { buildSettingsHtml, type SettingsState } from '../extension/src/settingsHtml';
import { SYSTEM_PROMPT, withReportLanguage } from '../src/prompt-builder';
import { isEntityArtifactComplaint, parseReviewResponse } from '../src/response-parser';
import { categorizeError } from '../src/error-classifier';
import { skipBreakerFeed, readAuditProgress, type SkipBreakerState } from '../extension/src/projectAudit';
import { t } from '../src/i18n';
import { keySecretId, resetRuntime, runtime, keyRuntimeId, scanCurrent, type KeychainProfile } from '../extension/src/keychain';
import { clearModelsCache } from '../src/providers';

const REAL_FETCH = globalThis.fetch;
const KEY_A = 'ZZKEYAAA_1234567890';
const KEY_B = 'ZZKEYBBB_0987654321';

function key(pid: string, kid: string): KeychainProfile['keys'][number] {
  return { id: kid, label: kid, secretId: keySecretId(pid, kid), enabled: true };
}

function twoProfiles(): KeychainProfile[] {
  return [
    { id: 'a', label: 'Alpha', provider: 'groq', keys: [key('a', 'default')] },
    { id: 'b', label: 'Beta', provider: 'openai', keys: [key('b', 'default')] }
  ];
}

function fileSet(count: number): Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }> {
  return Array.from({ length: count }, (_, i) => ({ filename: `src/f${i + 1}.ts`, status: 'M', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n+const x = 1;' }));
}

function okContent(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"issues":[],"summary":"ok"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// Агрегатор отдаёт биллинг-квоту НЕ 402-статусом, а обычным Error с текстом
// (HTTP 500 + insufficient_quota) — ровно тот кейс, который в 28.4 не доезжал
// до failover-хука и превращался в pointless-серию скипов.
function quotaTextError(): Response {
  return new Response(JSON.stringify({ error: { message: 'insufficient_quota: please check your plan and billing details' } }), { status: 500, headers: { 'content-type': 'application/json' } });
}

function quota402(): Response {
  return new Response(JSON.stringify({ error: { message: 'insufficient_quota: top up your billing' } }), { status: 402, headers: { 'content-type': 'application/json' } });
}

interface CapturedView {
  webview: {
    html: string;
    options: unknown;
    cspSource: string;
    asWebviewUri: (uri: { toString(): string }) => { toString(): string };
    postMessage: (message: unknown) => Promise<boolean>;
    onDidReceiveMessage: (cb: (message: never) => void) => { dispose(): void };
  };
  onDidDispose: (cb: () => void) => { dispose(): void };
}

function boot(): () => string {
  activate(makeFakeContext() as never);
  const provider = state.providers.get('codescout.panel') as { resolveWebviewView: (view: CapturedView) => void };
  const view: CapturedView = {
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri) => uri,
      postMessage: async () => true,
      onDidReceiveMessage: () => ({ dispose: () => {} })
    },
    onDidDispose: () => ({ dispose: () => {} })
  };
  provider.resolveWebviewView(view);
  return () => view.webview.html;
}

function makeWorkspace(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'cs-b285-'));
  mkdirSync(join(root, 'src'));
  for (const name of names) writeFileSync(join(root, 'src', name), Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i}; // ${name}`).join('\n') + '\n', 'utf8');
  return root;
}

// ── задача 1: квота участвует в ротации ──────────────────────────────────────
describe('микробатч 28.5: quota доезжает до failover-хука', () => {
  beforeEach(() => {
    state.reset();
    resetRuntime();
    clearModelsCache();
    state.set('codescout.fileCooldownSeconds', 0);
  });
  afterEach(() => { globalThis.fetch = REAL_FETCH; });

  it('failover включён: квота-текст на A → хук усыпляет A, ротация на B, тот же файл повторён, ноль скипов', async () => {
    state.set('codescout.keychain', twoProfiles());
    state.set('codescout.keychain.active', 'a');
    state.set('codescout.failover.enabled', true);
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    state.secrets.set(keySecretId('b', 'default'), KEY_B);
    activate(makeFakeContext() as never); // hostOutput для keychainLog
    await flush();
    const seen: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? '');
      seen.push(auth);
      if (auth.includes(KEY_A)) return quotaTextError();
      return okContent();
    }) as unknown as typeof fetch;
    let rotations = 0;
    const skipped: string[] = [];
    const result = await reviewFiles(
      makeFakeContext() as never, fileSet(2), undefined, () => {}, undefined, undefined, undefined, undefined, true,
      (filename) => { skipped.push(filename); }, undefined, undefined, 1, undefined, 3, undefined,
      async () => {}, 'ru', 0, undefined, undefined, {}, () => { rotations += 1; }
    );
    // ротация вместо скипов: ни одного пропуска, счётчик сброса вызван один раз
    expect(result.skippedFiles).toBe(0);
    expect(skipped).toEqual([]);
    expect(result.filesAnalyzed).toBe(2);
    expect(rotations).toBe(1);
    expect(seen[0]).toContain(KEY_A);
    expect(seen[seen.length - 1]).toContain(KEY_B);
    // ключ A усыплен по лестнице решателя (120с), состояние скана — на B
    const sleepA = runtime.get(keyRuntimeId('a', 'default'))?.sleepUntil ?? 0;
    expect(sleepA).toBeGreaterThan(Date.now());
    expect(scanCurrent()).toEqual({ profileId: 'b', keyId: 'default' });
    // прозрачность: обычная строка failover с причиной quota
    const line = state.outputLines.find((l) => l.includes('🔑 failover:'));
    expect(line, `нет строки failover в Output: ${state.outputLines.join('\n')}`).toBeTruthy();
    expect(line).toContain('Alpha/default → Beta/default');
    expect(line).toContain('(quota;');
    expect(line).toContain('спит 120с');
  }, 60000);

  it('failover выключен, БЕЗ quota-конфига: мгновенный скип БЕЗ billing-лестницы; breaker quota не трогает (28.6)', async () => {
    state.set('codescout.keychain', twoProfiles());
    state.set('codescout.keychain.active', 'a');
    state.set('codescout.failover.enabled', false);
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    state.secrets.set(keySecretId('b', 'default'), KEY_B);
    globalThis.fetch = (async () => quotaTextError()) as unknown as typeof fetch;
    const slept: number[] = [];
    const skipped: Array<{ file: string; category: string }> = [];
    const breaker: SkipBreakerState = { count: 0 };
    const result = await reviewFiles(
      makeFakeContext() as never, fileSet(3), undefined, () => {}, undefined, undefined, undefined, undefined, true,
      (filename, error) => {
        const category = skipCategoryOf(error);
        skipped.push({ file: filename, category });
        if (skipBreakerFeed(breaker, category, 4)) throw Object.assign(new Error('breaker'), { tripped: true });
      }, undefined, undefined, 1, undefined, 3, undefined,
      async (ms: number) => { slept.push(ms); }, 'ru', 0
    );
    expect(result.skippedFiles).toBe(3);
    expect(skipped.map((s) => s.category)).toEqual(['quota', 'quota', 'quota']);
    // Микро-батч 28.6: квота вне предохранителя — у неё свои quota-паузы
    // (они живут в аудите; здесь reviewFiles вызван БЕЗ quota-конфига).
    expect(breaker.count).toBe(0);
    expect(breaker.category).toBeUndefined();
    // локальная лестница 120/300/600 НЕ крутилась: пауз >2с не было вовсе
    expect(slept.filter((ms) => ms > 2000)).toEqual([]);
    // failover-состояние не тронуто
    expect(runtime.get(keyRuntimeId('a', 'default'))?.sleepUntil ?? 0).toBe(0);
  }, 60000);

  it('e2e аудит: failover выключен, автономный выкл, «Стоп» на баннере санкции → очередь стоит, ни один следующий файл не начат', async () => {
    const root = makeWorkspace(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    state.workspaceRoot = root;
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    state.set('codescout.failover.enabled', false);
    state.set('codescout.autoResume', false);
    state.set('codescout.rateLimitPauses', 3);
    let chatCalls = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      chatCalls += 1;
      return quota402();
    }) as typeof fetch;
    const html = boot();
    // Ответ на баннер санкции — «Стоп»: quota-пауза не стартует, цикл не продолжается.
    state.warningAnswers.push(t('keychain.bannerStopBtn', 'ru'));
    await (state.commands.get('codescout.scanFull') as () => Promise<unknown>)();
    await flush();
    // Очередь НЕ прогоняется в пустую: только первый файл дёрнул провайдер.
    expect(chatCalls).toBe(1);
    expect(state.warningCalls.length).toBe(1);
    expect(String(state.warningCalls[0][0])).toContain('Квота исчерпана');
    // Output цикла: строка «⚠ quota» (скип) — без строки паузы (пользователь отказал).
    expect(state.outputLines.some((line) => line.includes('⚠ quota: ключ') && line.includes('файлов цикла не стартуют'))).toBe(true);
    expect(state.outputLines.some((line) => line.includes('💤 quota-пауза'))).toBe(false);
    // локальная billing-лестница не крутилась
    expect(state.outputLines.some((line) => line.includes('⏸ rate-limit:'))).toBe(false);
    const view = html();
    expect(view).toContain('resumeAudit');
    const cp = readAuditProgress(root)!;
    expect(cp.state).toBe('interrupted');
    // «Стоп» НЕ помечает текущий файл скипом — он остаётся в remaining
    // (ничего не теряется); остальные 4 файла цикла не стартовали вообще.
    expect(cp.remaining.length).toBe(5);
    expect(cp.checked.length).toBe(0);
    rmSync(root, { recursive: true, force: true });
  }, 120000);

  it('ротация = сброс счётчика breaker: после switch на B следующие файлы идут на B без скипов', async () => {
    // 402-статус (не текст) с включённым failover: ротация внутри retry-слоя,
    // breaker-серия не копится — скипов нет вообще.
    state.set('codescout.keychain', twoProfiles());
    state.set('codescout.keychain.active', 'a');
    state.set('codescout.failover.enabled', true);
    state.secrets.set(keySecretId('a', 'default'), KEY_A);
    state.secrets.set(keySecretId('b', 'default'), KEY_B);
    activate(makeFakeContext() as never);
    await flush();
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = String(init?.headers?.Authorization ?? '');
      if (auth.includes(KEY_A)) return quota402();
      return okContent();
    }) as unknown as typeof fetch;
    const result = await reviewFiles(makeFakeContext() as never, fileSet(2), undefined, () => {});
    expect(result.skippedFiles).toBe(0);
    expect(result.filesAnalyzed).toBe(2);
    expect(scanCurrent()).toEqual({ profileId: 'b', keyId: 'default' });
    expect(state.outputLines.some((line) => line.includes('🔑 failover:') && line.includes('(quota;'))).toBe(true);
  }, 60000);
});

// ── задача 2: редактирование ВНУТРИ своей карточки + заголовок режима ───────
const base: SettingsState = {
  keyMask: '', keyConfigured: false, provider: 'gemini', model: '', baseUrl: '',
  reportLanguage: 'ru', showAuditBanner: true, docLinks: [], docMaxKb: 50, docMaxLinks: 5,
  maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0,
  auditScope: '', auditPasses: 1, rateLimitPauses: 3, requestTimeoutSeconds: 60, version: 'test',
  uiTheme: 'auto', accentColor: 'auto', uiDensity: 'standard', uiFontSize: 'm', showConfidence: true,
  findingsSort: 'severity', reportTheme: 'auto', customColors: '{}',
  keychainProfiles: [], keychainActiveId: '', failoverEnabled: false, failoverMaxCycles: 0
};

function settingsProfile(id: string, label: string): KeychainProfile {
  return { id, label, provider: 'groq', keys: [{ id: 'default', label: 'default', secretId: `keychain.${id}.default`, enabled: true }] };
}

function scriptOf(html: string): string {
  const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

function divAncestorsAt(html: string, marker: string): string[] {
  const idx = html.indexOf(marker);
  expect(idx, `маркер не найден: ${marker}`).toBeGreaterThan(-1);
  const stack: string[] = [];
  const re = /<div\b[^>]*>|<\/div\s*>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && match.index < idx) {
    if (match[0].startsWith('</')) stack.pop();
    else stack.push(match[0]);
  }
  return stack;
}

describe('микробатч 28.5: форма редактирования — своя карточка и свой заголовок', () => {
  it('контракт рендера: открытая форма правки — предок-карточка p2, заголовок «Редактирование: Beta» (ru) / «Editing: Beta» (en)', () => {
    for (const lang of ['ru', 'en'] as const) {
      const html = buildSettingsHtml({
        ...base,
        keychainProfiles: [settingsProfile('p1', 'Alpha'), settingsProfile('p2', 'Beta')],
        keychainActiveId: 'p1',
        keychainFormDraft: { profileId: 'p2', provider: 'groq', label: 'Beta', model: 'llama-3.3-70b-versatile', baseUrl: '' }
      }, '', 'ok', 'n285', '', undefined, lang);
      const ancestors = divAncestorsAt(html, '<div id="kcForm"');
      expect(ancestors.some((a) => a.includes('data-profile-id="p2"')), `${lang}: форма внутри карточки p2`).toBe(true);
      expect(ancestors.some((a) => a.includes('data-profile-id="p1"'))).toBe(false);
      expect(ancestors.some((a) => a.includes('data-add-card'))).toBe(false);
      const titleMatch = html.match(/<span id="kcFormTitle">([^<]*)<\/span>/);
      expect(titleMatch, `${lang}: span заголовка`).toBeTruthy();
      expect(titleMatch![1]).toBe(lang === 'ru' ? 'Редактирование: Beta' : 'Editing: Beta');
      expect(html).toContain('id="kcFormTitleIcon" class="codicon codicon-edit"');
      expect(() => new Function(scriptOf(html))).not.toThrow();
    }
  });

  it('draft правки без label → метка берётся из списка профилей', () => {
    const html = buildSettingsHtml({
      ...base,
      keychainProfiles: [settingsProfile('p2', 'Beta')],
      keychainFormDraft: { profileId: 'p2', provider: 'groq', label: '', model: '', baseUrl: '' }
    }, '', 'ok', 'n285', '', undefined, 'ru');
    expect(html).toContain('Редактирование: Beta');
  });

  it('режим создания: «Новый профиль» + codicon-plus (форма в add-card)', () => {
    const html = buildSettingsHtml({
      ...base,
      keychainProfiles: [settingsProfile('p1', 'Alpha')],
      keychainFormDraft: { provider: 'openrouter', label: '', model: '', baseUrl: '' }
    }, '', 'ok', 'n285', '', undefined, 'ru');
    const ancestors = divAncestorsAt(html, '<div id="kcForm"');
    expect(ancestors.some((a) => a.includes('data-add-card'))).toBe(true);
    const titleMatch = html.match(/<span id="kcFormTitle">([^<]*)<\/span>/);
    expect(titleMatch![1]).toBe('Новый профиль');
    expect(html).toContain('id="kcFormTitleIcon" class="codicon codicon-plus"');
  });

  it('контракт скрипта: setFormTitle переключает заголовок/иконку по режиму; вызовы в showForm/hideForm; ключи в UI-словаре', () => {
    const source = scriptOf(buildSettingsHtml({ ...base, keychainProfiles: [settingsProfile('p1', 'Alpha')] }, '', 'ok', 'n285s', '', undefined, 'en'));
    expect(source).toContain('function setFormTitle(editing, label)');
    expect(source).toContain("ic.className = 'codicon codicon-' + (editing ? 'edit' : 'plus')");
    expect(source).toContain("L('keychain.formTitleEdit').replace('{label}'");
    expect(source).toContain("L('keychain.formTitleAdd')");
    //showForm монит форму в слот кликнутой карточки и ставит заголовок режима
    expect(source).toContain('mountFormFor(formEditing);');
    expect(source).toContain("setFormTitle(formEditing, d.label || '');");
    expect(source).toContain("setFormTitle('', '');");
    // whitelist UI-словаря вебвью покрывает новые L()-ключи (контракт 28.3)
    const dictMatch = source.match(/const UI = (\{[\s\S]*?\});\n/);
    expect(dictMatch, 'UI-словарь не найден').toBeTruthy();
    const dict = JSON.parse(dictMatch![1]) as Record<string, string>;
    expect(dict['keychain.formTitleEdit'], 'formTitleEdit в UI-словаре').toBeTruthy();
    expect(dict['keychain.formTitleAdd'], 'formTitleAdd в UI-словаре').toBeTruthy();
    expect(() => new Function(source)).not.toThrow();
  });

  it('регресс 28.4: аккордеон/одна форма/комбобокс — зелёные (p1 скрытая, add-card одна)', () => {
    const html = buildSettingsHtml({ ...base, keychainProfiles: [settingsProfile('p1', 'Alpha'), settingsProfile('p2', 'Beta')], keychainActiveId: 'p2' }, '', 'ok', 'n285r', '', undefined, 'ru');
    expect((html.match(/class="kc-form hidden"/g) ?? []).length).toBe(1);
    expect((html.match(/class="kc-form"/g) ?? []).length).toBe(0);
    expect(html).toContain('class="kc-row kc-add-card hidden"');
    expect(html).toContain('id="kcFormModelDropdown"');
    expect(html).not.toContain('<datalist');
  });
});

// ── задача 3: анти-entity страховка ──────────────────────────────────────────
describe('микробатч 28.5: защита от entity-галлюцинаций', () => {
  it('HTML ENTITY GUARD в базовом (EN) промпте; RU-версия — в withReportLanguage(ru)', () => {
    expect(SYSTEM_PROMPT).toContain('HTML ENTITY GUARD');
    expect(SYSTEM_PROMPT).toContain('transport artifact');
    expect(SYSTEM_PROMPT).toContain('&lt; &gt; &amp; =&gt;');
    const ru = withReportLanguage(SYSTEM_PROMPT, 'ru');
    expect(ru).toContain('Код передаётся КАК ЕСТЬ');
    expect(ru).toContain('артефакт передачи, а не баг файла');
    const en = withReportLanguage(SYSTEM_PROMPT, 'en');
    expect(en).toContain('HTML ENTITY GUARD');
    expect(en).not.toMatch(/[\u0400-\u04FF]/);
  });

  it('isEntityArtifactComplaint: «замените =&gt; на =>» — да; настоящая находка про <= — нет', () => {
    expect(isEntityArtifactComplaint('Замените =&gt; на => в стрелочной функции', 'const f = (x) =&gt; x;')).toBe(true);
    expect(isEntityArtifactComplaint('Ошибка в цикле: условие i <= n допускает выход за границу массива', 'for (let i = 0; i <= n; i++) arr[i] = 0;')).toBe(false);
    // entities лишь мелькают в настоящей находке — живёт
    expect(isEntityArtifactComplaint('XSS: пользовательский ввод подставляется в innerHTML без экранирования, &lt;script&gt; выполнится в браузере жертвы', 'el.innerHTML = userInput')).toBe(false);
    // «&» без точки с запятой — не entity (URL-запросы не режем)
    expect(isEntityArtifactComplaint('В query добавлен &b=2 без кодирования — замен на escape тут не требуется', 'fetch(url + "?a=1&b=2")')).toBe(false);
  });

  it('parseReviewResponse: entity-жалоба отброшена с счётчиком, настоящая находка — цела', () => {
    const raw = JSON.stringify({
      issues: [
        { line: 5, category: 'style', severity: 'low', description: 'Замените =&gt; на =>' },
        { line: 12, category: 'bug', severity: 'high', description: 'Ошибка в цикле: условие i <= n допускает выход за границу массива', proof: 'for (let i = 0; i <= n; i++) arr[i] = 0;', confidence: 90 }
      ],
      summary: 'ok'
    });
    const result = parseReviewResponse(raw, 'src/a.ts');
    expect(result.issues.map((i) => i.line)).toEqual([12]);
    expect(result.droppedEntityArtifacts).toBe(1);
    const clean = parseReviewResponse('{"issues":[{"line":1,"category":"bug","severity":"low","description":"обычная находка","confidence":60}],"summary":""}', 'b.ts');
    expect(clean.droppedEntityArtifacts).toBe(0);
  });

  it('reviewFiles тащит счётчик в ScanResult; Output-строка «🧹 отброшено entity-артефактов»', async () => {
    state.reset();
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ issues: [
        { line: 5, category: 'style', severity: 'low', description: 'Replace =&gt; with =>' },
        { line: 7, category: 'bug', severity: 'medium', description: 'Деление на ноль при empty list', confidence: 80 }
      ], summary: 'ok' }) } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    try {
      const result = await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
      expect(result.issues.length).toBe(1);
      expect(result.droppedEntityArtifacts).toBe(1);
    } finally {
      globalThis.fetch = REAL_FETCH;
    }
    // хост печатает счётчик в Output
    const source = readFileSync('extension/src/extension.ts', 'utf8');
    expect(source).toContain('🧹 отброшено entity-артефактов:');
    expect(source).toContain('logEntityDrops(output, result)');
  }, 60000);
});

// ── вспомогательное: категория ошибки как это делает хост ────────────────────
function skipCategoryOf(error: unknown): string {
  // тот же решатель, что использует onFileSkipped в рантайме
  return categorizeError(error);
}
