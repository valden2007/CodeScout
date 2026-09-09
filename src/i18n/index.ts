import ru from './ru.json';
import en from './en.json';

export type Lang = 'ru' | 'en';

const DICTS: Record<Lang, Record<string, string>> = {
  ru: ru as Record<string, string>,
  en: en as Record<string, string>
};

export function normalizeLang(value: unknown): Lang {
  return value === 'en' ? 'en' : 'ru';
}

export function t(key: string, lang: Lang, vars?: Record<string, string | number>): string {
  const table = DICTS[lang] ?? DICTS.ru;
  const raw = table[key] ?? DICTS.ru[key] ?? key;
  if (!vars) return raw;
  return Object.keys(vars).reduce((acc, name) => acc.replaceAll(`{${name}}`, String(vars[name])), raw);
}

export function keysOf(lang: Lang): string[] {
  return Object.keys(DICTS[lang] ?? {});
}
