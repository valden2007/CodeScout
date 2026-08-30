import { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { buildReviewPrompt, SYSTEM_PROMPT } from '../prompt-builder';
import { createProvider, RetryEvent } from '../llm-client';
import { keyUrl, resolveApiKey } from '../providers';
import { parseReviewResponse } from '../response-parser';
import { DiffFile, ReviewIssue } from '../types';
import { splitPatch } from '../diff-parser';
import { correctIssueLine } from '../line-correction';
import { CliArgs } from '../cli/args';
import { LocalDiffFile, readGitDiff } from './DiffReader';
import { FilePanel, Header, Issue, SummaryBar } from './components';

interface Props {
  args: CliArgs;
  onExit?: (code: number) => void;
}

interface ScanState {
  files: LocalDiffFile[];
  error?: string;
}

interface ReviewState {
  issues: ReviewIssue[];
  warning?: string;
  error?: string;
  retry?: RetryEvent;
  durationMs: number;
  complete: boolean;
}

function scan(path: string, args: CliArgs): ScanState {
  try {
    return { files: readGitDiff(path, { lastCommit: args.lastCommit, base: args.base }) };
  } catch (error) {
    return { files: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function toDiffFile(file: LocalDiffFile): DiffFile {
  return file;
}

function toTuiIssue(issue: ReviewIssue): Issue {
  const severity: Issue['severity'] = issue.severity === 'critical' ? 'critical' : issue.severity === 'high' ? 'high' : issue.severity === 'low' ? 'low' : 'medium';
  return {
    severity,
    category: issue.category,
    confidence: Math.round(issue.confidence * 100),
    line: issue.line,
    code: issue.code ?? issue.description,
    suggestion: issue.suggestion ?? issue.description
  };
}

export function reviewStatus(model: string, retry?: RetryEvent): string {
  return retry
    ? `⏳ Rate limit у ${model}, ожидание ${retry.waitSeconds}с (попытка ${retry.attempt}/${retry.maxRetries})...`
    : `🤖 Отправляю запрос в ${model}...`;
}

async function reviewFiles(
  files: LocalDiffFile[],
  args: CliArgs,
  apiKey: string,
  onRetry: (event: RetryEvent) => void
): Promise<ReviewState> {
  const startedAt = Date.now();
  if (args.dryRun) return { issues: [], durationMs: Date.now() - startedAt, complete: true };

  try {
    const provider = createProvider(args.provider, apiKey, args.model, onRetry, args.baseUrl);
    const issues: ReviewIssue[] = [];
    for (const file of files) {
      for (const chunk of splitPatch(file.patch, 45_000)) {
        const raw = await provider.review(SYSTEM_PROMPT, buildReviewPrompt(toDiffFile(file), chunk));
        const parsed = parseReviewResponse(raw, file.filename);
        issues.push(...parsed.issues.map((issue) => correctIssueLine(issue, args.path)));
      }
    }
    return { issues, durationMs: Date.now() - startedAt, complete: true };
  } catch (error) {
    return { issues: [], error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt, complete: true };
  }
}

export function filesWithIssues(files: LocalDiffFile[], issueByFile: Map<string, Issue[]>): LocalDiffFile[] {
  return files.filter((file) => (issueByFile.get(file.filename)?.length ?? 0) > 0);
}

export function App({ args, onExit }: Props) {
  const [result] = useState(() => scan(args.path, args));
  const [review, setReview] = useState<ReviewState>({ issues: [], durationMs: 0, complete: false });
  const reviewStarted = useRef(false);
  const apiKey = resolveApiKey(args.provider, args.apiKey);

  useEffect(() => {
    if (result.error || result.files.length === 0 || !apiKey || args.dryRun) {
      if (args.dryRun) setReview({ issues: [], durationMs: 0, complete: true });
      return;
    }
    if (reviewStarted.current) return;
    reviewStarted.current = true;
    let active = true;
    void reviewFiles(result.files, args, apiKey, (retry) => {
      if (active) setReview((current) => ({ ...current, retry, complete: false }));
    }).then((next) => {
      if (active) setReview(next);
    });
    return () => { active = false; };
  }, [apiKey, args.path, args.provider, args.model, args.baseUrl, args.dryRun, args.apiKey, args.lastCommit, args.base, args.command, result.error, result.files]);

  const noKey = !apiKey && !args.dryRun && !result.error && result.files.length > 0;
  useEffect(() => {
    if (noKey || review.error) onExit?.(1);
  }, [noKey, review.error, onExit]);

  const showHeader = Boolean(result.error || result.files.length === 0 || noKey || review.complete);
  const issueByFile = new Map<string, Issue[]>();
  const tuiIssues = review.issues.map(toTuiIssue);
  for (const [index, tuiIssue] of tuiIssues.entries()) {
    const current = issueByFile.get(review.issues[index].file) ?? [];
    current.push(tuiIssue);
    issueByFile.set(review.issues[index].file, current);
  }
  const stats = {
    issues: review.issues.length,
    files: result.files.length,
    seconds: review.durationMs / 1000,
    critical: review.issues.filter((issue) => issue.severity === 'critical').length,
    high: review.issues.filter((issue) => issue.severity === 'high').length,
    medium: review.issues.filter((issue) => issue.severity !== 'critical' && issue.severity !== 'high' && issue.severity !== 'low').length,
    low: review.issues.filter((issue) => issue.severity === 'low').length
  };
  const retryText = reviewStatus(args.model, review.retry);

  return (
    <Box flexDirection="column" padding={1}>
      {showHeader && <Header path={args.path} filesAnalyzed={result.files.length} />}
      {result.error ? (
        <Box borderStyle="round" borderColor="red" padding={1} marginTop={1}><Text color="red">Error: {result.error}</Text></Box>
      ) : result.files.length === 0 ? (
        <Box borderStyle="round" borderColor="green" padding={1} marginTop={1}><Text color="green">✅ Нет изменений — ревьюить нечего</Text></Box>
      ) : noKey ? (
        <Box borderStyle="round" borderColor="red" padding={1} marginTop={1} flexDirection="column">
          <Text color="red" bold>🔑 Нет API-ключа для {args.provider}.</Text>
          <Text>1. Получи ключ: {keyUrl(args.provider)}</Text>
          <Text>2. Создай файл .env в папке проекта:</Text>
          <Text>   {args.provider === 'custom' ? 'CODESCOUT_API_KEY' : `${args.provider.toUpperCase()}_API_KEY`}=твой_ключ</Text>
          <Text dimColor>   (.env уже в .gitignore — ключ не попадёт в git)</Text>
        </Box>
      ) : !review.complete ? (
        <Box marginTop={1}><Text color={review.retry ? 'yellow' : 'cyan'}><Spinner type="dots" /> {retryText}</Text></Box>
      ) : review.error ? (
        <Box borderStyle="round" borderColor="red" padding={1} marginTop={1} flexDirection="column"><Text color="red">{review.error}</Text></Box>
      ) : (
        <>
          {review.warning && <Box borderStyle="round" borderColor="yellow" padding={1} marginTop={1}><Text color="yellow">⚠ {review.warning}</Text></Box>}
          {filesWithIssues(result.files, issueByFile).map((file) => <FilePanel key={file.filename} filename={file.filename} issues={issueByFile.get(file.filename) ?? []} />)}
          <SummaryBar stats={stats} />
        </>
      )}
    </Box>
  );
}
