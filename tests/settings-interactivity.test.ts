// МИКРО-БАТЧ 28.1: регрессия интерактивности Центра настроек.
// ROOT CAUSE (ветка B): в webview-скрипте settingsHtml.ts встретилась
// TypeScript-аннотация `const payload: Record<string, unknown>` — содержимое
// шаблонного литерала НЕ компилируется esbuild, браузер ловил SyntaxError на
// ВСЁМ <script>, слушатели не навешивались — все кнопки мерли молча.
// Контракт-тесты ниже убивают этот класс регрессии навсегда:
// 1) матрица рендера: 6 состояний keychain — рендер не бросает, HTML всегда
//    содержит корневой id блока, закрывающий </script> и маркер data-cs-ready,
//    а извлечённый скрипт парсится как ЧИСТЫЙ JS (new Function);
// 2) матрица команд: каждая KNOWN_SETTINGS_COMMANDS через stub-вебвью не
//    даёт необработанного исключения (эффект или вежливый ответ);
// 3) i18n-контракт: все t('-ключи settingsHtml есть в ОБОИХ словарях.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { state, flush, makeFakeContext } from './vscode-stub';
import { activate, KNOWN_SETTINGS_COMMANDS } from '../extension/src/extension';
import { buildSettingsHtml, type SettingsState } from '../extension/src/settingsHtml';
import type { KeychainProfile, KeyRuntimeView } from '../extension/src/keychain';
import { keysOf } from '../src/i18n';

const base: SettingsState = {
  keyMask: 'CS_•••E7', keyConfigured: true, provider: 'openai', model: 'gpt-4o-mini', baseUrl: '',
  reportLanguage: 'ru', showAuditBanner: true, docLinks: [], docMaxKb: 50, docMaxLinks: 5,
  maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0,
  auditScope: '', auditPasses: 1, rateLimitPauses: 3, requestTimeoutSeconds: 60, version: '1.5.0',
  uiTheme: 'auto', accentColor: 'auto', uiDensity: 'standard', uiFontSize: 'm', showConfidence: true,
  findingsSort: 'severity', reportTheme: 'auto', customColors: '{}',
  keychainActiveId: '', failoverEnabled: false, failoverMaxCycles: 0
};

function key(id: string, label: string, enabled: boolean): KeychainProfile['keys'][number] {
  return { id, label, secretId: `keychain.p1.${id}`, enabled };
}

// ── 1. матрица рендера ───────────────────────────────────────────────────────
const matrix: { name: string; patch: Partial<SettingsState> }[] = [
  { name: 'пустой keychain', patch: { keychainProfiles: [], keychainActiveId: '' } },
  { name: 'профиль без ключей', patch: { keychainProfiles: [{ id: 'p1', label: 'groq-main', provider: 'groq', keys: [] }], keychainActiveId: 'p1' } },
  { name: 'ключи enabled+disabled', patch: { keychainProfiles: [{ id: 'p1', label: 'groq-main', provider: 'groq', keys: [key('k1', 'primary', true), key('k2', 'backup', false)] }], keychainActiveId: 'p1' } },
  { name: 'метки broken+asleep', patch: { keychainProfiles: [{ id: 'p1', label: 'groq-main', provider: 'groq', keys: [key('k1', 'primary', true), key('k2', 'backup', true)] }], keychainActiveId: 'p1', keychainRuntime: { 'p1/k1': { broken: true, sleepSeconds: 0 }, 'p1/k2': { broken: false, sleepSeconds: 296 } } as Record<string, KeyRuntimeView> } },
  { name: 'legacy-профиль до миграции (без поля keys)', patch: { keychainProfiles: [{ id: 'legacy', label: 'legacy', provider: 'openai', model: 'gpt-4o-mini' } as unknown as KeychainProfile], keychainActiveId: 'legacy' } },
  { name: 'много профилей', patch: { keychainProfiles: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id) => ({ id, label: id, provider: 'groq' as const, keys: [{ id: 'default', label: 'default', secretId: `keychain.${id}.default`, enabled: true }] })), keychainActiveId: 'p3' } }
];

function scriptOf(html: string): string {
  const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

describe('микробатч 28.1: матрица рендера центра настроек', () => {
  for (const lang of ['ru', 'en'] as const) {
    for (const item of matrix) {
      it(`${item.name} (${lang}): не бросает, HTML полон, скрипт парсится как JS`, () => {
        let html = '';
        expect(() => {
          html = buildSettingsHtml({ ...base, ...item.patch } as SettingsState, '', 'ok', 'nonce-28-1', '', undefined, lang);
        }).not.toThrow();
        expect(html).toContain('id="kcBlock"');
        expect(html).toContain('</script>');
        expect(html.trimEnd().endsWith('</html>')).toBe(true);
        expect(html).toContain('data-cs-ready');
        // КЛЮЧЕВОЙ регресс-тест: webview-скрипт обязан быть валидным ЧИСТЫМ JS
        // (никаких TS-аннотаций в шаблонных литералах — они убивают весь <script>).
        const parseError = (() => {
          try {
            new Function(scriptOf(html));
            return '';
          } catch (e) {
            return String(e);
          }
        })();
        expect(parseError).toBe('');
        if (lang === 'en') expect(html).not.toMatch(/[\u0400-\u04FF]/);
      });
    }
  }

  it('деградация: битый profile.keys не обрывает HTML/script, причина — в onRenderIssue', () => {
    const issues: string[] = [];
    const broken = [{ id: 'p1', label: 'x', provider: 'groq', keys: {} as unknown as KeychainProfile['keys'] }];
    let html = '';
    expect(() => {
      html = buildSettingsHtml({ ...base, keychainProfiles: broken, keychainActiveId: 'p1' } as SettingsState, '', 'ok', 'n', '', undefined, 'en', (m) => issues.push(m));
    }).not.toThrow();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('keychain');
    expect(html).toContain('id="kcBlock"');
    expect(html).toContain('temporarily hidden');
    expect(html).toContain('</script>');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).toContain('data-cs-ready');
    expect(() => new Function(scriptOf(html))).not.toThrow();
  });
});

// ── 2. матрица команд через stub-вебвью ─────────────────────────────────────
async function openCenter(): Promise<{ html: () => string; send: (message: unknown) => void }> {
  activate(makeFakeContext() as never);
  await (state.commands.get('codescout.openSettingsPage') as () => Promise<unknown>)();
  await flush();
  const panel = state.panels[state.panels.length - 1];
  expect(panel).toBeDefined();
  return {
    html: () => panel!.webview.html,
    send: (message) => panel!.webview.onMessageHandlers[0](message as never)
  };
}

const commandPayload = {
  id: 'ghost', keyId: 'ghost', dir: 1,
  baseUrl: '', url: 'https://github.com/valden2007/CodeScout',
  linksText: '', docMaxKb: 50, docMaxLinks: 5, maxLines: 0, maxFiles: 100,
  autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0,
  auditScope: '', auditPasses: 1, rateLimitPauses: 3, requestTimeoutSeconds: 60,
  uiTheme: 'auto', accentColor: 'auto', uiDensity: 'standard', uiFontSize: 'm',
  findingsSort: 'severity', reportTheme: 'auto', showConfidence: true,
  customColors: '{}', reportLanguage: 'ru', showAuditBanner: true
};

describe('микробатч 28.1: матрица KNOWN_SETTINGS_COMMANDS', () => {
  const realFetch = globalThis.fetch;
  let root = '';
  beforeEach(() => {
    state.reset();
    root = mkdtempSync(join(tmpdir(), 'cs-28-1-'));
    state.workspaceRoot = root;
    delete process.env.CODESCOUT_BASE_URL;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'offline in tests' } }), { status: 401 })) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  });

  it('каждая команда: доходит до хоста, не бросает, центр остаётся целым', async () => {
    const center = await openCenter();
    expect(center.html()).toContain('id="kcBlock"');
    // ДИАГНОСТИКА п.1: сообщение вебвью реально доходит до обработчика —
    // saveAppearance без saveAll-поля перерисовывает центр со статусом.
    center.send({ command: 'saveAppearance', reportLanguage: 'ru', showAuditBanner: true });
    await flush();
    expect(center.html()).toContain('Сохранено');
    const commands = [...KNOWN_SETTINGS_COMMANDS];
    expect(commands.length).toBeGreaterThan(15);
    for (const command of commands) {
      center.send({ command, ...commandPayload });
      for (let i = 0; i < 6; i += 1) await flush();
      const html = center.html();
      // .catch в хосте переводит любую внутреннюю ошибку в статус-фолбэк —
      // его появление = необработанное исключение = красный тест.
      expect(html, `команда ${command}: необработанное исключение`).not.toContain('❌ Ошибка:');
      expect(html).toContain('</script>');
      expect(html.trimEnd().endsWith('</html>')).toBe(true);
    }
  }, 30000);
});

// ── 3. i18n-контракт: все t('-ключи settingsHtml — в ru И en ───────────────
describe('микробатч 28.1: i18n-контракт ключей центра', () => {
  const source = readFileSync('extension/src/settingsHtml.ts', 'utf8');
  const ru = new Set(keysOf('ru'));
  const en = new Set(keysOf('en'));

  it("литеральные T(...) и T(условие ? «a» : «b») — ключи есть в обоих словарях", () => {
    const keys = new Set<string>();
    for (const m of source.matchAll(/T\('([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9-]+)+)'/g)) keys.add(m[1]);
    for (const m of source.matchAll(/\?\s*'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9-]+)+)'\s*:\s*'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9-]+)+)'/g)) {
      keys.add(m[1]);
      keys.add(m[2]);
    }
    const uiLine = source.split('\n').find((line) => line.includes('const UI =')) ?? '';
    for (const m of uiLine.matchAll(/'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9-]+)+)'/g)) keys.add(m[1]);
    expect(keys.size).toBeGreaterThan(60);
    const missing = [...keys].filter((k) => !ru.has(k) || !en.has(k));
    expect(missing, `отсутствуют в словарях: ${missing.join(', ')}`).toEqual([]);
  });

  it('динамические cc.*/geom.* из colorFields/geometryFields — в обоих словарях', () => {
    const colors = source.slice(source.indexOf('const colorFields'), source.indexOf('const geometryFields'));
    const geom = source.slice(source.indexOf('const geometryFields'), source.indexOf('function escapeHtml'));
    for (const m of colors.matchAll(/key: '(\w+)'/g)) {
      expect(ru.has(`cc.${m[1]}`), `ru cc.${m[1]}`).toBe(true);
      expect(en.has(`cc.${m[1]}`), `en cc.${m[1]}`).toBe(true);
    }
    for (const m of geom.matchAll(/key: '(\w+)'/g)) {
      expect(ru.has(`geom.${m[1]}`), `ru geom.${m[1]}`).toBe(true);
      expect(en.has(`geom.${m[1]}`), `en geom.${m[1]}`).toBe(true);
    }
  });
});
