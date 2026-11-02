import { ReviewIssue, ReviewResult, ReviewCategory, ReviewSeverity } from './types';

const categories = new Set<ReviewCategory>(['bug', 'security', 'performance', 'maintainability', 'docs', 'style']);
const severities = new Set<ReviewSeverity>(['low', 'medium', 'high', 'critical']);
// Батч 20b (ядро доверия): единая шкала уверенности для всего продукта —
// целые 0..100. Парсер клампит и лечит мусор, UI/экспортёры только читают.
export const CONFIDENCE_MIN = 0;
export const CONFIDENCE_MAX = 100;
// Мусор/отсутствие поля = 50: «ни да, ни нет», честный нейтральный дефолт.
export const CONFIDENCE_DEFAULT = 50;
// >= порога — «подтверждено кодом» (зелёный бейдж), ниже — «предположение модели».
export const CONFIDENCE_VERIFIED_THRESHOLD = 70;
// critical допускается только при уверенности не ниже этого значения.
export const CONFIDENCE_CRITICAL_MIN = 90;
// Санити-потолок длины доказательства: непроверяемый вывод модели не должен
// раздувать отчёт; это граница формата, а не продуктовый лимит.
const PROOF_MAX = 1000;

// Приведение любого значения confidence к шкале 0..100 (целое).
// Мусор (не число, NaN, Infinity) → fallback. Все отображения (% в панели,
// GitHub-комменты, CLI, Output) идут через эту функцию — дублей логики нет.
export function confidencePercent(value: unknown, fallback = CONFIDENCE_DEFAULT): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, value)));
}

// proof — строка (цитата из кода или причина). При отсутствии/мусоре = ''.
function parseProof(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, PROOF_MAX);
}

// ── Микро-батч 28.5 + 28.11 (задача 1): анти-entity пост-фильтр v2 ────────────
// Транспорт иногда экранирует угловые скобки, и модель начинает «находить»
// HTML-entities (&lt; &gt; &amp; =&gt; и т.п.) вместо реальных дефектов.
// В 28.5 резали по «преимущественно» — доле entity-токенов среди остальных
// слов. Краткие формулировки сильных моделей («Использование HTML-сущностей
// (&lt; и &gt;) вместо символов < и > может привести к ошибкам компиляции»)
// при этом пропускались: содержательных слов много, доля не считается.
// v2: критерий — ПАТТЕРН жалобы, а не доля. Жалоба — entity-артефакт, если
// в description есть один из паттернов:
//  1) «replace/замен… <entity-токен> … with/на … <символ>» («=&gt; вместо =>»
//     ловится паттерном 2);
//  2) «<entity-токен> … вместо|instead of … символ/знак/<|>|=>»;
//  3) фраза «HTML-сущности / HTML entities» … «вместо|instead of» … символ.
// Направление важно: «replace < with &lt;» (реальный совет экранировать) не
// матчится — артефакт требует заменить entity НА символ. Доля — только
// дополнительный сигнал (семейство A из 28.5): если после вычеркивания
// токенов почти ничего не осталось (слов ≤ токенов+2) и есть жалобная
// лексика. Настоящая находка, где entity реально лежат в строке/шаблоне и
// вокруг них живой текст, живёт.
export const ENTITY_TOKEN_RE = /&(?:[a-zA-Z][a-zA-Z0-9]{1,10}|#\d{1,8});/g;
const ENTITY_COMPLAIN_RE = /html[\s-]?entit|сущност|encod|decod|escap|экранир|замен|replace|convert|артефакт|\bentities?\b/i;
// Паттерн 1: «replace/замен… <entity> … with/на … символ» (и пассив:
// «&gt; should be replaced with >»).
const ENTITY_REPLACE_TO_SYMBOL_RE = /(?:replace|замен|\buse\b|использ)[\s\S]{0,60}?&(?:lt|gt|amp|quot|apos|#\d{1,8});[\s\S]{0,30}?(?:with|на|→)[\s\S]{0,8}?(?:<(?![a-zA-Z/!])|(?<![\w&;])>|=>|&(?![a-zA-Z#]))|&(?:lt|gt|amp|quot|apos|#\d{1,8});[\s\S]{0,50}?(?:replace|замен)[a-zA-Zа-яёА-ЯЁ\-]{0,8}[\s\S]{0,16}?(?:with|на)[\s\S]{0,8}?(?:<(?![a-zA-Z/!])|(?<![\w&;])>|=>)/i;
// Паттерн 2: «<entity> … вместо|instead of … (символ/знак) … </>/=>».
const ENTITY_VS_SYMBOL_RE = /&(?:lt|gt|amp|quot|apos|#\d{1,8});[\s\S]{0,60}?(?:instead of|вместо)[\s\S]{0,30}?(?:symbols?|символ|знак)[\s\S]{0,8}?(?:<(?![a-zA-Z/!])|(?<![\w&;])>|=>)/i;
// Паттерн 3: фраза про HTML-сущности/HTML entities … вместо … символ.
const HTML_ENTITIES_VS_SYMBOL_RE = /html[\s-]?(?:entities?\b|entit|сущност)[\s\S]{0,90}?(?:instead of|вместо)[\s\S]{0,30}?(?:symbols?|символ|знак)[\s\S]{0,8}?(?:<(?![a-zA-Z/!])|(?<![\w&;])>|=>)/i;
// «Сущности вместо < / >» — «вместо» сразу за токеном, без существительного.
const ENTITY_INSTEAD_BARE_RE = /(?:&lt;|&gt;|=&gt;|&amp;|&quot;|&apos;)[\s\S]{0,40}?(?:instead of|вместо)[\s\S]{0,6}?(?:<(?![a-zA-Z/!])|(?<![\w&;])>|=>)/i;

export function isEntityArtifactComplaint(description: string, proof = ''): boolean {
  const text = `${description}\n${proof}`;
  const tokens = text.match(ENTITY_TOKEN_RE);
  if (!tokens || tokens.length === 0) return false;
  // Паттерны сильны сами по себе — доля не порога, не смотрим.
  if (ENTITY_REPLACE_TO_SYMBOL_RE.test(description)) return true;
  if (ENTITY_VS_SYMBOL_RE.test(description)) return true;
  if (HTML_ENTITIES_VS_SYMBOL_RE.test(description)) return true;
  if (ENTITY_INSTEAD_BARE_RE.test(description)) return true;
  // Дополнительный сигнал (семейство A): жалобная лексика + почти ничего,
  // кроме токенов, не осталось.
  if (!ENTITY_COMPLAIN_RE.test(text)) return false;
  const words = text.replace(ENTITY_TOKEN_RE, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}_\-]{2,}/gu);
  return (words ? words.length : 0) <= tokens.length + 2;
}

// ── Микро-батч 28.11 (задача 2): security-театр (семья B) ──────────────────────
// Модели любят страшилки без угрозы: «импортируемый тип X может содержать
// уязвимости», «провайдеры определены в коде — уязвимость», «логирование
// ошибок может раскрыть» (не сказано ЧТО). Объект — импорт/тип/лог/список-
// констант, ни CWE-класса, ни вектора, ни строки-доказательства.
// Реальные security (зашитый ключ, execFileSync с пользовательским вводом,
// prompt-injection через имя файла) несут конкретику в description/proof и
// остаются живы: правило срабатывает ТОЛЬКО когда есть смутная формулировка
// («может … уязвимость» / «X — уязвимость») и нет конкретики вообще.
const SEC_THREAT_RE = /уязвим|vulnerab|эксплойт|exploit|раскрыт|раскрыва|expos|утечк|leak|компромет|compromis|атак|attack|threat|breach/i;
const SEC_ABSTRACT_OBJECT_RE = /(?:импорт|импортир|import|тип\b|интерфейс|interface|класс\b|лог\b|логирова|logging|\blog\b|констант|список|\blist\b|набор\b|перечислен|enumeration|\benum\b|провайдер|provider|определ\w*\s+в\s+(?:исходном\s+)?коде|defined\s+in\s+(?:the\s+)?code|hardcoded\s+(?:list|provider|enum))/i;
// Смутная модальная связка («может … уязвимости») или копулятивная
// декларация («X — уязвимость»). Без неё жалоба обычно техническая.
const SEC_VAGUE_CLAIM_RE = /(?:может|могут|возможен|вероятн\w*|потенциальн\w*|may|could|might|likely|potentially)[^\n]{0,40}?(?:уязвим|vulnerab|раскрыт|раскрыва|expos|утечк|leak|компромет|compromis|атак|attack|threat)|—\s*(?:это\s+)?(?:a\s+|an\s+)?(?:уязвим|vulnerab|threat|атак)|-\s*(?:a\s+)?(?:vulnerab|threat)/i;
const SEC_CONCRETE_RE = /cwe[- ]?\d+|injection|инъекц|\bxss\b|\bcsrf\b|\bssrf\b|\bsqli?\b|traversal|deserial|\beval\b|\bexec\w*\b|\bspawn\b|child_process|process\.\w+|prompt[- ]?injection|hardcod|зашит|в\s+открытом\s+виде|plaintext|unencrypted|без\s+шифрования|innerHTML|document\.write|user[- ]input|user\s+(?:data|info|input)|данные\s+пользователя|пользовательск\w+\s+(?:ввод|данные|файл|имя|путь)|личн\w+\s+данн|\bpii\b|secret|api[ _-]?key|ключ|парол|password|credential|токен|\btoken\b|access[ _-]?token|privilege|эскалаци|переполн|overflow|race[ _-]?condition|exfiltrat|memory[ _-]?leak|resource[ _-]?leak|prototype\s+pollution|pollution|отписк|unsubscrib|не\s+вызыв|not\s+called|cleanup|dispos|\bpush\(|раст[её]т|grow\w*|утечк\w*\s+(?:памяти|memory|данных|ключей|секретов|паролей|токенов|пароль|data|secrets?|keys?)\w*/i;

export function isSecurityTheaterComplaint(category: string, description: string, proof = ''): boolean {
  if (category !== 'security' && category !== 'bug') return false;
  if (!SEC_THREAT_RE.test(description)) return false;
  if (!SEC_ABSTRACT_OBJECT_RE.test(description)) return false;
  if (!SEC_VAGUE_CLAIM_RE.test(description)) return false;
  // Конкретика (CWE/вектор/секрет/доказательная строка) в описании ИЛИ proof —
  // это уже реальная находка, театр тут не уместен.
  return !SEC_CONCRETE_RE.test(`${description}\n${proof}`);
}

function findBalancedJson(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

// Батч 18.8: greedy-эвристика для «болтливых» бесплатных моделей — если
// сбалансированный сканер не сработал (обрезанный/вложенный мусор),
// вырезаем от ПЕРВОГО [ или { до ПОСЛЕДНЕГО ] или } включительно.
function findGreedyJsonSpan(text: string): string | undefined {
  const firstOpen = text.search(/[[{]/);
  if (firstOpen < 0) return undefined;
  const lastBracket = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (lastBracket <= firstOpen) return undefined;
  return text.slice(firstOpen, lastBracket + 1);
}

function stripMarkdownFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced ? fenced[1] : text).trim();
}

// Батч 20a: удаляем висячие запятые только вне JSON-строк. Regex портил
// содержимое строки, если после запятой в ней встречалась закрывающая скобка.
export function stripTrailingCommas(text: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ',') {
      let next = index + 1;
      while (/\s/.test(text[next] ?? '') && next < text.length) next += 1;
      if (text[next] === ']' || text[next] === '}') continue;
    }
    output += char;
  }
  return output;
}

const RAW_TAIL_LIMIT = 200;

export type JsonParseOutcome = { ok: true; value: unknown } | { ok: false; reason: string; rawTail: string };

// Батч 20a (контракт каскада): кандидаты СТРОГО в порядке
// 1) чистый текст → 2) снятие markdown-фенсов → 3) balanced-brace сканер →
// 4) greedy slice (первый [/{ … последний ]/}) — последним, он самый ryzy.
// Перед parse каждого кандидата — попытка санитайза висячих запятых.
// Если всё упало → { ok:false, reason, rawTail } для вывода в Output, без
// падения: старые форматы ответов (без новых полей) парсятся по-прежнему.
export function tryParseJson(raw: string): JsonParseOutcome {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    if (value && !seen.has(value)) { seen.add(value); candidates.push(value); }
  };
  const trimmed = raw.trim();
  push(trimmed);
  const stripped = stripMarkdownFences(trimmed);
  push(stripped);
  push(findBalancedJson(stripped) ?? '');
  push(findGreedyJsonSpan(stripped) ?? '');
  let lastReason = 'в ответе не найдено JSON-подобного текста';
  for (const candidate of candidates) {
    for (const variant of [candidate, stripTrailingCommas(candidate)]) {
      try { return { ok: true, value: JSON.parse(variant) as unknown }; }
      catch (error) { lastReason = error instanceof Error ? error.message : String(error); }
    }
  }
  return { ok: false, reason: lastReason, rawTail: raw.trim().slice(0, RAW_TAIL_LIMIT) };
}

export function parseReviewResponse(raw: string, filename: string): ReviewResult {
  const outcome = tryParseJson(raw);
  if (!outcome.ok) {
    throw new Error(`LLM returned malformed JSON for ${filename} · ${outcome.reason} · хвост ответа: ${outcome.rawTail}`);
  }
  const parsed: unknown = outcome.value;
  if (parsed === null) throw new Error(`Ответ модели для ${filename} — JSON null вместо объекта ревью`);
  if (Array.isArray(parsed)) throw new Error(`Ответ модели для ${filename} — JSON-массив, ожидается объект с полем "issues"`);
  if (typeof parsed !== 'object') throw new Error(`Ответ модели для ${filename} — не JSON-объект (получен ${typeof parsed})`);
  const object = parsed as { issues?: unknown; summary?: unknown };
  const rawIssues = Array.isArray(object.issues) ? object.issues : [];
  let droppedEntityArtifacts = 0;
  let droppedSecurityTheater = 0;
  const issues: ReviewIssue[] = rawIssues.flatMap((item): ReviewIssue[] => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const category = categories.has(value.category as ReviewCategory) ? value.category as ReviewCategory : 'bug';
    const rawSeverity = severities.has(value.severity as ReviewSeverity) ? value.severity as ReviewSeverity : 'medium';
    const description = typeof value.description === 'string' ? value.description.trim() : '';
    if (!description) return [];
    const line = typeof value.line === 'number' && Number.isFinite(value.line) ? Math.max(1, Math.floor(value.line)) : 1;
    const confidence = confidencePercent(value.confidence);
    const code = typeof value.code === 'string' ? value.code.trim() : undefined;
    const suggestion = typeof value.suggestion === 'string' ? value.suggestion.trim() : undefined;
    const severity: ReviewSeverity = rawSeverity === 'critical' && confidence < CONFIDENCE_CRITICAL_MIN ? 'medium' : rawSeverity;
    const proof = parseProof(value.proof);
    // Микро-батч 28.5/28.11: жалоба по entity-паттерну — артефакт передачи,
    // не находка; режем здесь и считаем для Output.
    if (isEntityArtifactComplaint(description, proof)) {
      droppedEntityArtifacts += 1;
      return [];
    }
    // Микро-батч 28.11 (задача 2): security-театр — страшилка про импорт/тип/
    // лог/список без CWE, вектора и доказательства. Тоже режем со счётчиком.
    if (isSecurityTheaterComplaint(category, description, proof)) {
      droppedSecurityTheater += 1;
      return [];
    }
    return [{ file: filename, line, category, severity, description, code, suggestion, confidence, proof }];
  });
  return { issues, summary: typeof object.summary === 'string' ? object.summary.trim() : '', filesAnalyzed: 1, droppedEntityArtifacts, droppedSecurityTheater };
}
