import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

export interface CliArgs {
  command: string;
  path: string;
  provider: 'groq' | 'openai';
  dryRun: boolean;
  apiKey?: string;
  lastCommit: boolean;
  base?: string;
}

const KNOWN_FLAGS = new Set(['--path', '--provider', '--dry-run', '--api-key', '--last-commit', '--base', '--help', '--version']);

function suggestedFlag(flag: string): string | undefined {
  if (flag.startsWith('--last-')) return '--last-commit';
  if (flag.startsWith('--dry-')) return '--dry-run';
  if (flag.startsWith('--api-')) return '--api-key';
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
    .option('provider', { type: 'string', choices: ['groq', 'openai'] as const, default: 'groq', describe: 'LLM provider reserved for a future stage' })
    .option('dry-run', { type: 'boolean', default: false, describe: 'Read the diff without calling an LLM' })
    .option('api-key', { type: 'string', describe: 'Groq API key (overrides GROQ_API_KEY)' })
    .option('last-commit', { type: 'boolean', default: false, describe: 'Review HEAD~1 instead of working-tree changes' })
    .option('base', { type: 'string', describe: 'Compare the current branch against a base branch' })
    .strict()
    .help()
    .parseSync();

  return {
    command: typeof parsed.command === 'string' ? parsed.command : 'scan',
    path: parsed.path,
    provider: parsed.provider as 'groq' | 'openai',
    dryRun: parsed.dryRun,
    apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined,
    lastCommit: Boolean(parsed.lastCommit),
    base: typeof parsed.base === 'string' ? parsed.base : undefined
  };
}
