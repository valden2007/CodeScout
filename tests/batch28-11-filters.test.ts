// МИКРО-БАТЧ 28.11: два precision-фильтра парсера.
// Контракты:
//  1) entity-фильтр v2: жалоба режется по ПАТТЕРНУ («замените <entity> на
//     <символ>», «HTML-сущности/&lt;/&gt; вместо < / >», «=&gt; вместо =>»),
//     а не по доле токенов — краткие формулировки сильных моделей ловятся.
//     Доля — дополнительный сигнал. Настоящая находка, где entity реально
//     лежат в строке/шаблоне, живёт. Регресс 28.5 сохранён.
//  2) security-театр (семья B): страшилки про импорт/тип/лог/список-констант
//     без CWE-класса, вектора и строки-доказательства отбрасываются со
//     счётчиком droppedSecurityTheater; реальные security (зашитый ключ,
//     execFileSync с пользовательским вводом, prompt-injection через имя
//     файла) остаются живы.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { state, makeFakeContext } from './vscode-stub';
import { reviewFiles } from '../extension/src/extension';
import { isEntityArtifactComplaint, isSecurityTheaterComplaint, parseReviewResponse } from '../src/response-parser';

const REAL_FETCH = globalThis.fetch;

function fileSet(count: number): Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }> {
  return Array.from({ length: count }, (_, i) => ({ filename: `src/f${i + 1}.ts`, status: 'M', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n+const x = 1;' }));
}

// ── задача 1: entity-фильтр v2 ───────────────────────────────────────────────
describe('микробатч 28.11 задача 1: entity-фильтр v2 — паттерн, а не доля', () => {
  it('краткая лунная формулировка сильной модели — отброшена', () => {
    expect(isEntityArtifactComplaint(
      'Использование HTML-сущностей (&lt; и &gt;) вместо символов < и > может привести к ошибкам компиляции',
      'const f = (x) =&gt; x;'
    )).toBe(true);
    // «=&gt; вместо =>» — тот же паттерн, доля токенов почти нулевая
    expect(isEntityArtifactComplaint('В стрелочных функциях =&gt; вместо => — код не соберётся', '')).toBe(true);
    // пассивная английская форма
    expect(isEntityArtifactComplaint('The &gt; should be replaced with > in the arrow function', '')).toBe(true);
    expect(isEntityArtifactComplaint('Use &lt; instead of < in this template', '')).toBe(true);
  });

  it('реальная находка про <= в цикле и про &lt; В СТРОКЕ/шаблоне — жива', () => {
    expect(isEntityArtifactComplaint(
      'Ошибка в цикле: условие i <= n допускает выход за границу массива',
      'for (let i = 0; i <= n; i++) arr[i] = 0;'
    )).toBe(false);
    // entity реально лежат в коде (двойное экранирование) — жалоба на строку,
    // а не на транспорт: «вместо» здесь не требует замены на символ
    expect(isEntityArtifactComplaint(
      'В шаблоне email строка "&lt;b&gt;" печатается получателю буквально вместо жирного шрифта — двойное экранирование в генераторе',
      'const row = "&lt;b&gt;" + name;'
    )).toBe(false);
    // реальный совет экранировать: направление «< → &lt;» не матчится
    expect(isEntityArtifactComplaint(
      'В tooltip подставляется <raw> без экранирования — замените на &lt; и &gt;',
      'el.title = userInput;'
    )).toBe(false);
  });

  it('регресс 28.5: «замените =&gt; на =>» — да; XSS, query &b=2, цикл — нет', () => {
    expect(isEntityArtifactComplaint('Замените =&gt; на => в стрелочной функции', 'const f = (x) =&gt; x;')).toBe(true);
    expect(isEntityArtifactComplaint('Ошибка в цикле: условие i <= n допускает выход за границу массива', 'for (let i = 0; i <= n; i++) arr[i] = 0;')).toBe(false);
    expect(isEntityArtifactComplaint('XSS: пользовательский ввод подставляется в innerHTML без экранирования, &lt;script&gt; выполнится в браузере жертвы', 'el.innerHTML = userInput')).toBe(false);
    expect(isEntityArtifactComplaint('В query добавлен &b=2 без кодирования — замен на escape тут не требуется', 'fetch(url + "?a=1&b=2")')).toBe(false);
  });

  it('parseReviewResponse: лунная формулировка режется со счётчиком, реальная — цела', () => {
    const result = parseReviewResponse(JSON.stringify({
      issues: [
        { line: 3, category: 'bug', severity: 'medium', description: 'Использование HTML-сущностей (&lt; и &gt;) вместо символов < и > может привести к ошибкам компиляции' },
        { line: 9, category: 'bug', severity: 'high', description: 'Ошибка в цикле: условие i <= n допускает выход за границу массива', proof: 'for (let i = 0; i <= n; i++) arr[i] = 0;', confidence: 90 }
      ],
      summary: 'ok'
    }), 'src/a.ts');
    expect(result.issues.map((i) => i.line)).toEqual([9]);
    expect(result.droppedEntityArtifacts).toBe(1);
  });
});

// ── задача 2: security-театр ─────────────────────────────────────────────────
describe('микробатч 28.11 задача 2: security-театр (семья B)', () => {
  it('семья B — импорт/тип/лог/список-констант без конкретики: отброшена', () => {
    expect(isSecurityTheaterComplaint('security', 'Импортируемый тип ProviderConfig может содержать уязвимости', '')).toBe(true);
    expect(isSecurityTheaterComplaint('security', 'Провайдеры определены в коде — это уязвимость', 'export const PROVIDERS = [groq, openai];')).toBe(true);
    expect(isSecurityTheaterComplaint('security', 'Логирование ошибок может раскрыть внутреннюю информацию', '')).toBe(true);
    expect(isSecurityTheaterComplaint('bug', 'Список констант хендлеров может содержать уязвимость при отсутствии проверки', '')).toBe(true);
  });

  it('реальные security из аудита — живы (есть конкретика/вектор/доказательство)', () => {
    expect(isSecurityTheaterComplaint('security', 'В коде зашит API-ключ AIzaSyD… — любой, кто видит репозиторий, получает доступ', 'const API_KEY = "AIzaSyD…";')).toBe(false);
    expect(isSecurityTheaterComplaint('security', 'execFileSync вызывается с пользовательским вводом — возможна инъекция команд', 'execFileSync(bin, [req.query.file]);')).toBe(false);
    expect(isSecurityTheaterComplaint('security', 'Prompt-injection через имя файла: пользователь kontrol-имя попадает в промпт', '')).toBe(false);
    expect(isSecurityTheaterComplaint('security', 'XSS: пользовательский ввод подставляется в innerHTML без экранирования, &lt;script&gt; выполнится в браузере жертвы', 'el.innerHTML = userInput')).toBe(false);
    // bug-находка с реальным leak памяти — не security-театр
    expect(isSecurityTheaterComplaint('bug', 'Утечка: список подписчиков растёт, отписка не вызывается', 'listeners.push(cb);')).toBe(false);
  });

  it('чужие категории и описания без угрозы — фильтр не трогает', () => {
    expect(isSecurityTheaterComplaint('docs', 'Экспортный тип может содержать уязвимости', '')).toBe(false);
    expect(isSecurityTheaterComplaint('performance', 'Список констант собирается медленно', '')).toBe(false);
    expect(isSecurityTheaterComplaint('security', 'Порт 80 открыт в фаерволе', '')).toBe(false);
  });

  it('parseReviewResponse: театр режется со счётчиком, реальная находка цела', () => {
    const result = parseReviewResponse(JSON.stringify({
      issues: [
        { line: 2, category: 'security', severity: 'high', description: 'Импортируемый тип ProviderConfig может содержать уязвимости', confidence: 75 },
        { line: 8, category: 'security', severity: 'high', description: 'execFileSync вызывается с пользовательским вводом — инъекция команд', proof: 'execFileSync(bin, [req.query.file]);', confidence: 90 }
      ],
      summary: 'ok'
    }), 'src/a.ts');
    expect(result.issues.map((i) => i.line)).toEqual([8]);
    expect(result.droppedSecurityTheater).toBe(1);
    const clean = parseReviewResponse('{"issues":[{"line":1,"category":"bug","severity":"low","description":"обычная находка","confidence":60}],"summary":""}', 'b.ts');
    expect(clean.droppedSecurityTheater).toBe(0);
  });

  it('reviewFiles тащит оба счётчика в ScanResult; Output-строки хоста на месте', async () => {
    state.reset();
    state.secrets.set('codescout.apiKey', 'CS_MOCK_KEY_FOR_TESTS');
    state.set('codescout.fileCooldownSeconds', 0);
    state.set('codescout.rateLimitPauses', 0);
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ issues: [
        { line: 5, category: 'style', severity: 'low', description: 'Использование HTML-сущностей (&lt; и &gt;) вместо символов < и > может привести к ошибкам компиляции' },
        { line: 6, category: 'security', severity: 'medium', description: 'Логирование ошибок может раскрыть внутреннюю информацию' },
        { line: 7, category: 'bug', severity: 'medium', description: 'Деление на ноль при empty list', confidence: 80 }
      ], summary: 'ok' }) } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    try {
      const result = await reviewFiles(makeFakeContext() as never, fileSet(1), undefined, () => {});
      expect(result.issues.length).toBe(1);
      expect(result.droppedEntityArtifacts).toBe(1);
      expect(result.droppedSecurityTheater).toBe(1);
    } finally {
      globalThis.fetch = REAL_FETCH;
    }
    const source = readFileSync('extension/src/extension.ts', 'utf8');
    expect(source).toContain('🧹 отброшено entity-артефактов:');
    expect(source).toContain('🧹 отброшено security-театра:');
    expect(source).toContain('logEntityDrops(output, result)');
    expect(source).toContain('logSecurityTheaterDrops(output, result)');
  }, 60000);
});
