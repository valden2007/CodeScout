import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { defaultModel, ProviderName } from '../providers';

export interface CliArgs {
  command: string;
  path: string;
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  dryRun: boolean;
  apiKey?: string;
  lastCommit: boolean;
  base?: string;
}

const KNOWN_FLAGS = new Set(['--path', '--provider', '--model', '--base-url', '--dry-run', '--api-key', '--last-commit', '--base', '--help', '--version']);

function suggestedFlag(flag: string): string | undefined {
  if (flag.startsWith('--last-')) return '--last-commit';
  if (flag.startsWith('--dry-')) return '--dry-run';
  if (flag.startsWith('--api-')) return '--api-key';
  if (flag.startsWith('--base-u')) return '--base-url';
  return undefined;
}

export function unknownFlagError(flag: string): Error {
  const suggestion = suggestedFlag(flag);
  const hint = suggestion ? `\n│ Возможно, вы имели в виду: ${suggestion}` : '';
  return new Error(`┌─ Ошибка CLI ─────────────────────────────────────────────┐\n│ Неизвестный флаг: ${flag}${hint}\n│ Используй codescout --help, чтобы увидеть доступные флаги.\n└───────────────────────────────────────────────────────────┘`);
}

export function validateFlags(argv: string[]): void {
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const flag = token.split('=', 1)[0];
    if (!KNOWN_FLAGS.has(flag)) throw unknownFlagError(flag);
  }
}

export function parseArgs(argv: string[]): CliArgs {
  validateFlags(argv);
  const parsed = yargs(hideBin(['node', 'codescout', ...argv]))
    .command('$0 [command]', 'Run a CodeScout scan', (builder) => builder.positional('command', { type: 'string', default: 'scan' }))
    .option('path', { type: 'string', default: process.cwd(), describe: 'Directory containing the git repository' })
    .option('provider', { type: 'string', choices: ['gemini', 'groq', 'openrouter', 'github', 'custom'] as const, default: 'gemini', describe: 'LLM provider' })
    .option('model', { type: 'string', describe: 'Model name understood by the selected provider' })
    .option('base-url', { type: 'string', describe: 'Custom OpenAI-compatible endpoint base URL' })
    .option('dry-run', { type: 'boolean', default: false, describe: 'Read the diff without calling an LLM' })
    .option('api-key', { type: 'string', describe: 'API key for the selected provider' })
    .option('last-commit', { type: 'boolean', default: false, describe: 'Review HEAD~1 instead of working-tree changes' })
    .option('base', { type: 'string', describe: 'Compare the current branch against a base branch' })
    .strict()
    .help()
    .parseSync();

  const provider = parsed.provider as ProviderName;
  return {
    command: typeof parsed.command === 'string' ? parsed.command : 'scan',
    path: parsed.path,
    provider,
    model: typeof parsed.model === 'string' ? parsed.model : defaultModel(provider),
    baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : process.env.CODESCOUT_BASE_URL,
    dryRun: parsed.dryRun,
    apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined,
    lastCommit: Boolean(parsed.lastCommit),
    base: typeof parsed.base === 'string' ? parsed.base : undefined
  };
}
