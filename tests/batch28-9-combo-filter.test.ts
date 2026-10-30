// Микро-батч 28.9, задача 3: поиск в комбоксе фильтрует при ЛЮБОМ изменении
// значения (keystroke/paste/drop/программная установка — событие input);
// раскрытие всегда применяет текущий фильтр; ноль совпадений → «нет
// совпадений» + «впиши модель руками». Контракт: paste «nemotron» → только
// nemotron-строки. Регресс 28.4: стрелки/Enter/Escape/галочка/ручной ввод.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildSettingsHtml, type SettingsState } from '../extension/src/settingsHtml';

const base: SettingsState = {
  keyMask: '', keyConfigured: false, provider: 'gemini', model: '', baseUrl: '',
  reportLanguage: 'ru', showAuditBanner: true, docLinks: [], docMaxKb: 50, docMaxLinks: 5,
  maxLines: 0, maxFiles: 100, autoResume: false, autoResumeMaxAttempts: 0, autoResumeMaxMinutes: 0,
  auditScope: '', auditPasses: 1, version: '1.5.0', uiTheme: 'auto', accentColor: 'auto',
  uiDensity: 'compact', uiFontSize: 'm', showConfidence: true, findingsSort: 'severity',
  reportTheme: 'auto', customColors: '{}'
};

const MODELS = [
  'nvidia/nemotron-nano-9b-v2', 'nemotron-3-nano-30b-a3b', 'meta-llama/llama-3.1-8b-instruct',
  'openai/gpt-4o-mini', 'nvidia/nemotron-ultra-253b-128k', 'deepseek/deepseek-r1'
];

function scriptOf(html: string): string {
  const m = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
  return m ? m[1] : '';
}

function comboCore(): { comboFilter: (models: unknown, query: unknown) => string[]; comboIsCurrent: (model: unknown, current: unknown) => boolean } {
  const html = buildSettingsHtml({ ...base, keychainProfiles: [{ id: 'p1', label: 'Alpha', provider: 'groq', keys: [] } as never] }, '', 'ok', 'n289', '', undefined, 'en');
  const script = scriptOf(html);
  const m = script.match(/\/\* cs-combo-core:start \*\/([\s\S]*?)\/\* cs-combo-core:end \*\//);
  expect(m, 'маркеры cs-combo-core не найдены').toBeTruthy();
  const factory = new Function(`${m![1]}; return { comboFilter, comboIsCurrent };`);
  return factory() as { comboFilter: (models: unknown, query: unknown) => string[]; comboIsCurrent: (model: unknown, current: unknown) => boolean };
}

describe('28.9 комбобокс: фильтрация при любом изменении значения', () => {
  it('контракт paste «nemotron»: фильтр оставляет ТОЛЬКО nemotron-строки', () => {
    const core = comboCore();
    const pasted = core.comboFilter(MODELS, 'nvidia/nemotron');
    expect(pasted).toEqual(['nvidia/nemotron-nano-9b-v2', 'nvidia/nemotron-ultra-253b-128k']);
    expect(pasted.every((model) => model.toLowerCase().includes('nemotron'))).toBe(true);
    // регистр/пробелы не мешают (paste с мусором по краям)
    expect(core.comboFilter(MODELS, '  NEMOTRON  ')).toEqual(['nvidia/nemotron-nano-9b-v2', 'nemotron-3-nano-30b-a3b', 'nvidia/nemotron-ultra-253b-128k']);
    // программная установка = то же comboFilter: значение целиком → одна строка с галочкой
    const exact = 'nemotron-3-nano-30b-a3b';
    expect(core.comboFilter(MODELS, exact)).toEqual([exact]);
    expect(core.comboIsCurrent(exact, exact)).toBe(true);
    // ноль совпадений
    expect(core.comboFilter(MODELS, 'nemotron-999')).toEqual([]);
    // пустое значение (раскрытие без фильтра) — весь список
    expect(core.comboFilter(MODELS, '')).toHaveLength(6);
  });

  it('проводка: comboItems всегда через comboFilter; input без условия comboOpen; раскрытие рендерит фильтр', () => {
    const html = buildSettingsHtml({ ...base, keychainProfiles: [{ id: 'p1', label: 'Alpha', provider: 'groq', keys: [] } as never] }, '', 'ok', 'n289w', '', undefined, 'ru');
    const script = scriptOf(html);
    // Ядро без «полного» режима: comboOpenList удалён, фильтр единственный путь.
    expect(script).not.toContain('comboOpenList');
    expect(script).toContain('function comboItems() { return comboFilter(formModelsList, kcFormModelInput ? kcFormModelInput.value : \'\'); }');
    // ЛЮБОЕ изменение значения (keystroke, paste, программный dispatch input)
    // перерисовывает список и открывает его, если закрыт.
    expect(script).toContain("kcFormModelInput.addEventListener('input', () => { if (formVisible()) refreshComboTyped(); })");
    // Раскрытие (фокус/стрелка) тоже идёт через renderCombo → comboItems → фильтр.
    expect(script).toContain('function openCombo() {');
    expect(script.slice(script.indexOf('function openCombo()'), script.indexOf('function refreshComboTyped()'))).toContain('renderCombo();');
    // Ноль совпадений: «нет совпадений» + «впиши модель руками».
    expect(script).toContain("L('keychain.comboNoMatches') + ' — ' + L('keychain.comboManual')");
    // comboManual в UI-белом списке (иначе L() вернёт сырой ключ — баг 28.3a).
    expect(script).toContain("'keychain.comboManual'");
  });

  it('регресс 28.4: клавиатура (стрелки/Enter/Escape-список), галочка текущей, ручной ввод, счётчик', () => {
    const html = buildSettingsHtml({ ...base, keychainProfiles: [{ id: 'p1', label: 'Alpha', provider: 'groq', keys: [] } as never] }, '', 'ok', 'n289r', '', undefined, 'ru');
    const script = scriptOf(html);
    expect(script).toContain("event.key === 'ArrowDown' || event.key === 'ArrowUp'");
    expect(script).toContain("moveComboActive(event.key === 'ArrowDown' ? 1 : -1)");
    expect(script).toContain("if (comboOpen()) { closeCombo(); event.stopPropagation(); }");
    expect(script).toContain("if (event.key === 'Escape' && formVisible() && comboOpen()) { closeCombo(); return; }");
    expect(script).toContain('comboIsCurrent(model, current)');
    expect(script).toContain('if (data.model && kcFormModelInput && !kcFormModelInput.value) kcFormModelInput.value = String(data.model)');
    expect(script).toContain("L('keychain.formModelsCount')");
  });

  it('i18n: comboManual/comboNoMatches в обоих словарях, EN без кириллицы', () => {
    const ru = JSON.parse(readFileSync('src/i18n/ru.json', 'utf8')) as Record<string, string>;
    const en = JSON.parse(readFileSync('src/i18n/en.json', 'utf8')) as Record<string, string>;
    expect(ru['keychain.comboManual']).toBe('впиши модель руками');
    expect(ru['keychain.comboNoMatches']).toBe('нет совпадений');
    expect(en['keychain.comboManual']).not.toMatch(/[\u0400-\u04FF]/);
    expect(en['keychain.comboNoMatches']).not.toMatch(/[\u0400-\u04FF]/);
  });
});
