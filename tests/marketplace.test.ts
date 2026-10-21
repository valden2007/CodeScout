// Батч 16: упаковка под Marketplace — метаданные манифеста, zero-config
// OpenCode Go (oc_sk_ → qwen3.8-flash), лицензии в сборке, README.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { detectProvider, normalizeProvider, resolveBaseUrl, defaultModel, keyUrl, resolveApiKey, completionUrl, PROVIDER_ORDER } from '../src/providers';

function extManifest(): Record<string, any> {
  return JSON.parse(readFileSync('extension/package.json', 'utf8'));
}

describe('батч 16: манифест расширения для Marketplace', () => {
  it('version 1.5.0, publisher, categories, keywords, repository, bugs, homepage, icon', () => {
    const m = extManifest();
    expect(m.version).toBe('1.5.0');
    expect(m.publisher).toBe('valden2007');
    expect(m.categories).toEqual(['Machine Learning', 'Linters', 'Education']);
    expect(m.keywords).toEqual(['ai', 'code review', 'audit', 'qwen', 'ollama']);
    expect(m.repository).toEqual({ type: 'git', url: 'https://github.com/valden2007/CodeScout' });
    expect(m.bugs.url).toContain('/issues');
    expect(m.homepage).toContain('valden2007/CodeScout');
    expect(m.icon).toBe('media/icon.png');
    expect(existsSync('extension/media/icon.png')).toBe(true);
  });

  it('enum провайдера в манифесте и в CLI знает opencode; версия npm-пакета синхронна', () => {
    const properties = extManifest().contributes.configuration.properties['codescout.provider'];
    expect(properties.enum).toContain('opencode');
    const root = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(root.version).toBe('1.5.0');
    expect(root.license).toBe('MIT');
    const args = readFileSync('src/cli/args.ts', 'utf8');
    expect(args).toContain("'opencode'");
  });
});

describe('батч 16: zero-config OpenCode Go', () => {
  it('ключ oc_sk_ автоопределяется в opencode + qwen3.8-flash', () => {
    expect(detectProvider('oc_sk_ABC123')).toEqual({ provider: 'opencode', model: 'qwen3.8-flash' });
    expect(detectProvider('gsk_keep')).toEqual({ provider: 'groq', model: 'llama-3.3-70b-versatile' });
    expect(detectProvider('oc_sUPERSECRET7')).toBeNull(); // не oc_sk_ — не гадаем
  });

  it('провайдер полностью подключен: base URL, chat/completions, дефолт, ключ env, keyUrl', () => {
    expect(normalizeProvider('opencode')).toBe('opencode');
    expect(resolveBaseUrl('opencode')).toBe('https://opencode.ai/zen/go/v1');
    expect(completionUrl(resolveBaseUrl('opencode'))).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(defaultModel('opencode')).toBe('qwen3.8-flash');
    expect(resolveApiKey('opencode', undefined, { OPENCODE_GO_API_KEY: 'oc_sk_env' })).toBe('oc_sk_env');
    expect(keyUrl('opencode')).toBe('https://opencode.ai/auth');
  });

  it('центр настроек, wizard и ручной выбор предлагают opencode', () => {
    const center = readFileSync('extension/src/settingsHtml.ts', 'utf8');
    expect(center).toContain('PROVIDER_ORDER'); // список провайдеров центра теперь из providers.ts (custom → openai → anthropic → …)
    const extension = readFileSync('extension/src/extension.ts', 'utf8');
    expect(extension).toContain('[...PROVIDER_ORDER]');
    expect(extension).toContain('OpenCode Go');
    expect(extension).toContain("'OpenAI'");
    expect(extension).toContain("'Anthropic'");
  });

  it('батч 18: порядок провайдеров custom → openai → anthropic → opencode → …, auto скрыт из UI', () => {
    expect(PROVIDER_ORDER).toEqual(['custom', 'openai', 'anthropic', 'opencode', 'gemini', 'groq', 'github']);
    expect(PROVIDER_ORDER).not.toContain('auto');
    const providers = readFileSync('src/providers.ts', 'utf8');
    expect(providers).toContain("['custom', 'openai', 'anthropic', 'opencode', 'gemini', 'groq', 'github']");
    const center = readFileSync('extension/src/settingsHtml.ts', 'utf8');
    expect(center).toContain('[...PROVIDER_ORDER]');
    expect(center).not.toContain("['auto',");
    // ключ oc_sk_ строго ведёт в opencode — никогда в gemini-дефолт селекта
    expect(detectProvider('oc_sk_STRICT')?.provider).toBe('opencode');
  });

  it('батч 18: устаревший UI-текст про auto/префиксы вырезан из словарей и разметки', () => {
    for (const dict of ['ru', 'en']) {
      const i18n = JSON.parse(readFileSync(`src/i18n/${dict}.json`, 'utf8')) as Record<string, string>;
      expect(i18n['center.prefixHint']).toBeUndefined();
      expect(i18n['center.providerAuto']).toBeUndefined();
    }
    const center = readFileSync('extension/src/settingsHtml.ts', 'utf8');
    expect(center).not.toContain('center.prefixHint');
    expect(center).not.toContain('center.providerAuto');
    // noteProviderAuto (короткий статус «определён автоматически: p») остаётся
    const ru = JSON.parse(readFileSync('src/i18n/ru.json', 'utf8')) as Record<string, string>;
    expect(ru['center.noteProviderAuto']).toBeTruthy();
  });

  it('батч 18: иконка Activity Bar — svg (не белый квадрат из png), корневая иконка остаётся png', () => {
    const m = extManifest();
    expect(m.contributes.viewsContainers.activitybar[0].icon).toBe('media/icon.svg');
    expect(m.icon).toBe('media/icon.png');
    expect(existsSync('extension/media/icon.svg')).toBe(true);
  });

  it('батч 18: дефолтная модель Gemini — gemini-1.5-flash (free-tier), не 2.5', () => {
    expect(defaultModel('gemini')).toBe('gemini-1.5-flash');
    expect(resolveBaseUrl('gemini')).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(extManifest().contributes.configuration.properties['codescout.model'].default).toBe('gemini-1.5-flash');
    expect(extManifest().contributes.configuration.properties['codescout.provider'].enum).toEqual(['custom', 'openai', 'anthropic', 'opencode', 'gemini', 'groq', 'github', 'openrouter']);
  });

  it('батч 18: openai и anthropic — полноценные провайдеры (URL, env, model, keyUrl)', () => {
    expect(resolveBaseUrl('openai')).toBe('https://api.openai.com/v1');
    expect(resolveBaseUrl('anthropic')).toBe('https://api.anthropic.com/v1');
    expect(defaultModel('openai')).toBe('gpt-4o-mini');
    expect(defaultModel('anthropic')).toBe('claude-3-5-haiku-latest');
    expect(resolveApiKey('openai', undefined, { OPENAI_API_KEY: 'sk-env' })).toBe('sk-env');
    expect(resolveApiKey('anthropic', undefined, { ANTHROPIC_API_KEY: 'sk-ant-env' })).toBe('sk-ant-env');
    expect(completionUrl(resolveBaseUrl('openai'))).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('батч 17.5: Workspace Trust — в untrusted workspace расширение не активируется', () => {
    const m = extManifest();
    expect(m.capabilities.untrustedWorkspaces.supported).toBe(false);
    expect(m.capabilities.untrustedWorkspaces.description).toBe('CodeScout requires full workspace access to analyze code and read Git history.');
  });
});

describe('батч 16: безопасность сборки vsix (лицензии и файлы)', () => {
  it('LICENSE лежит в корне и в extension/, оба манифеста MIT, vscodeignore их не режет', () => {
    expect(readFileSync('LICENSE', 'utf8')).toContain('MIT License');
    expect(readFileSync('extension/LICENSE', 'utf8')).toContain('MIT License');
    expect(extManifest().license).toBe('MIT');
    const ignore = readFileSync('extension/.vscodeignore', 'utf8');
    const lines = ignore.split(/\r?\n/);
    const excludes = (pattern: string): boolean => lines.some((line) => line.trim() !== '' && !line.startsWith('#') && pattern.startsWith(line.trim()));
    expect(excludes('LICENSE')).toBe(false);
    expect(excludes('README.md')).toBe(false);
    expect(excludes('media/icon.png')).toBe(false);
    // README и LICENSE vsce подхватывает сам, но они не должны быть исключены
    expect(ignore).not.toContain('LICENSE');
  });

  it('description манифеста — продающая строка с zero-config-обещанием (<=256 символов)', () => {
    const description = String(extManifest().description);
    expect(description.length).toBeLessThanOrEqual(256);
    expect(description).toMatch(/oc_sk_/i);
  });
});

describe('батч 16: README — витрина v1.5.0', () => {
  it('root README: zero-config блок, фичи, и старые контрактные секции живы', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain('oc_sk_');
    expect(readme).toContain('OpenCode Go');
    expect(readme).toContain('Qwen3.8 Flash');
    expect(readme).toContain('RAG Full Project Audit');
    expect(readme).toContain('Smart Chunking');
    expect(readme).toContain('Dedupe');
    expect(readme).toContain('Ollama');
    expect(readme).toContain('LM Studio');
    // устаревшая ручная настройка Gemini как основной путь — убрана из примера Action
    expect(readme).toContain('provider: opencode');
    // контракты предыдущих батчей
    expect(readme).toContain('## Privacy & local models');
    expect(readme).toContain('http://localhost:11434/v1');
    expect(readme).toContain('code never leaves the machine');
    expect(readme).toContain('## How to report a bug');
    expect(readme).toContain('.github/ISSUE_TEMPLATE/bug_report.md');
  });

  it('extension README (страница галереи): те же обещания + release notes 1.5.0', () => {
    const readme = readFileSync('extension/README.md', 'utf8');
    expect(readme).toContain('oc_sk_');
    expect(readme).toContain('Qwen3.8 Flash');
    expect(readme).toContain('False positive');
    expect(readme).toContain('Release notes — 1.5.0');
    expect(readme).not.toContain('media/icon.png'); // gallery не рендерит локальные пути
  });
});
