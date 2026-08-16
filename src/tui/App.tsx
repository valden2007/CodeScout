import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { buildReviewPrompt, SYSTEM_PROMPT } from '../prompt-builder';
import { createProvider } from '../llm-client';
import { parseReviewResponse } from '../response-parser';
import { DiffFile, ReviewIssue } from '../types';
import { splitPatch } from '../diff-parser';
import { CliArgs } from '../cli/args';
import { LocalDiffFile, readGitDiff } from './DiffReader';
import { FilePanel, Header, Issue, SummaryBar } from './components';

interface Props {
  args: CliArgs;
}

interface ScanState {
  files: LocalDiffFile[];
  error?: string;
}

interface ReviewState {
  issues: ReviewIssue[];
  warning?: string;
  error?: string;
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
  const severity = issue.severity === 'low' ? 'low' : issue.severity === 'medium' ? 'medium' : 'critical';
  return {
    severity,
    category: issue.category,
    confidence: Math.round(issue.confidence * 100),
    line: issue.line,
    code: issue.code ?? issue.description,
    suggestion: issue.suggestion ?? issue.description
  };
}

function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate.?limit|too many requests/i.test(message);
}

async function reviewFiles(files: LocalDiffFile[], args: CliArgs, apiKey: string): Promise<ReviewState> {
  const startedAt = Date.now();
  if (args.dryRun) return { issues: [], durationMs: Date.now() - startedAt, complete: true };

  try {
    const provider = createProvider(args.provider, apiKey, 'llama-3.3-70b-versatile');
    const issues: ReviewIssue[] = [];
    let warning: string | undefined;
    for (const file of files) {
      for (const chunk of splitPatch(file.patch, 45_000)) {
        try {
          const raw = await provider.review(
            SYSTEM_PROMPT,
            buildReviewPrompt(toDiffFile(file), chunk)
          );
          issues.push(...parseReviewResponse(raw, file.filename).issues);
        } catch (error) {
          if (isRateLimit(error)) {
            warning = 'Groq временно ограничил частоту запросов. Часть файлов не была проверена.';
            continue;
          }
          throw error;
        }
      }
    }
    return { issues, warning, durationMs: Date.now() - startedAt, complete: true };
  } catch (error) {
    return { issues: [], error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt, complete: true };
  }
}

export function App({ args }: Props) {
  const [result] = useState(() => scan(args.path, args));
  const [review, setReview] = useState<ReviewState>({ issues: [], durationMs: 0, complete: false });
  const apiKey = args.apiKey ?? process.env.GROQ_API_KEY;

  useEffect(() => {
    if (result.error || result.files.length === 0 || !apiKey || args.dryRun) {
      if (args.dryRun) setReview({ issues: [], durationMs: 0, complete: true });
      return;
    }
    let active = true;
    void reviewFiles(result.files, args, apiKey).then((next) => {
      if (active) setReview(next);
    });
    return () => { active = false; };
  }, [apiKey, args, result.error, result.files]);

  const noKey = !apiKey && !args.dryRun && !result.error && result.files.length > 0;
  useEffect(() => {
    if (noKey) process.exitCode = 1;
  }, [noKey]);

  const issueByFile = new Map<string, Issue[]>();
  for (const issue of review.issues) {
    const current = issueByFile.get(issue.file) ?? [];
    current.push(toTuiIssue(issue));
    issueByFile.set(issue.file, current);
  }
  const stats = {
    issues: review.issues.length,
    files: result.files.length,
    seconds: review.durationMs / 1000,
    critical: review.issues.filter((issue) => issue.severity === 'critical' || issue.severity === 'high').length,
    medium: review.issues.filter((issue) => issue.severity === 'medium').length,
    low: review.issues.filter((issue) => issue.severity === 'low').length
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Header path={args.path} filesAnalyzed={result.files.length} />
      {result.error ? (
        <Box borderStyle="round" borderColor="red" padding={1} marginTop={1}><Text color="red">Error: {result.error}</Text></Box>
      ) : result.files.length === 0 ? (
        <Box borderStyle="round" borderColor="green" padding={1} marginTop={1}><Text color="green">✅ Нет изменений — ревьюить нечего</Text></Box>
      ) : noKey ? (
        <Box borderStyle="round" borderColor="red" padding={1} marginTop={1} flexDirection="column">
          <Text color="red" bold>🔑 Нет API-ключа Groq.</Text>
          <Text>1. Получи бесплатно: https://console.groq.com</Text>
          <Text>2. Создай файл .env в папке проекта:</Text>
          <Text>   GROQ_API_KEY=gsk_твой_ключ</Text>
          <Text dimColor>   (.env уже в .gitignore — ключ не попадёт в git)</Text>
        </Box>
      ) : !review.complete ? (
        <Box marginTop={1}><Text color="cyan"><Spinner type="dots" /> 🤖 Отправляю в Groq...</Text></Box>
      ) : review.error ? (
        <Box borderStyle="round" borderColor="red" padding={1} marginTop={1}><Text color="red">Error: {review.error}</Text></Box>
      ) : (
        <>
          {review.warning && <Box borderStyle="round" borderColor="yellow" padding={1} marginTop={1}><Text color="yellow">⚠ {review.warning}</Text></Box>}
          {result.files.map((file) => <FilePanel key={file.filename} filename={file.filename} issues={issueByFile.get(file.filename) ?? []} />)}
          <SummaryBar stats={stats} />
        </>
      )}
    </Box>
  );
}
