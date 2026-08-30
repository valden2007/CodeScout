import React from 'react';
import { Box, Text } from 'ink';

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Issue {
  severity: IssueSeverity;
  category: string;
  confidence: number;
  line: number;
  code: string;
  suggestion: string;
}

export interface SummaryStats {
  issues: number;
  files: number;
  seconds?: number | null;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

const severityMeta: Record<IssueSeverity, { emoji: string; color: 'red' | 'yellow' | 'green' }> = {
  critical: { emoji: '🔴', color: 'red' },
  high: { emoji: '🟠', color: 'yellow' },
  medium: { emoji: '🟡', color: 'yellow' },
  low: { emoji: '🟢', color: 'green' }
};

// терминальные escape-последовательности (ANSI/OSC) вырезаются перед рендером:
// непроверенный текст из LLM не должен управлять терминалом
const ANSI_PATTERN = /\x1B(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_]|\([B0-9])/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function confidenceLabel(confidence: number): string {
  const value = Number.isFinite(confidence) ? Math.round(confidence <= 1 ? confidence * 100 : confidence) : 0;
  return `${Math.min(100, Math.max(0, value))}%`;
}

export function Header({ path, filesAnalyzed = 0 }: { path: string; filesAnalyzed?: number }) {
  return (
    <Box borderStyle="round" borderColor="cyan" padding={1}>
      <Box flexDirection="column">
        <Text color="cyan" bold>🕵️ CodeScout CLI</Text>
        <Text>Scanning: {path}</Text>
        <Text dimColor>Changed files: {filesAnalyzed}</Text>
      </Box>
    </Box>
  );
}

export function IssueRow({ issue }: { issue: Issue }) {
  const meta = severityMeta[issue.severity] ?? severityMeta.medium;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={meta.color} bold>{meta.emoji} {stripAnsi(issue.severity).toUpperCase()} · {stripAnsi(issue.category)} · {confidenceLabel(issue.confidence)}</Text>
      <Text dimColor>line {issue.line} │ {stripAnsi(issue.code)}</Text>
      <Text color="green">→ {stripAnsi(issue.suggestion)}</Text>
    </Box>
  );
}

export function FilePanel({ filename, issues }: { filename: string; issues: Issue[] }) {
  const safeName = stripAnsi(filename);
  return (
    <Box borderStyle="single" borderColor="gray" padding={1} marginTop={1}>
      <Box flexDirection="column">
        <Text bold>{safeName}</Text>
        {issues.map((issue, index) => <IssueRow key={`${safeName}-${issue.line}-${index}`} issue={issue} />)}
      </Box>
    </Box>
  );
}

export function SummaryBar({ stats }: { stats: SummaryStats }) {
  return (
    <Box borderStyle="round" borderColor="green" padding={1} marginTop={1}>
      <Text color="green" bold>{stats.issues} issues · {stats.files} files · {typeof stats.seconds === 'number' && Number.isFinite(stats.seconds) ? stats.seconds.toFixed(1) : 'N/A'}s · 🔴 {stats.critical} · 🟠 {stats.high} · 🟡 {stats.medium} · 🟢 {stats.low}</Text>
    </Box>
  );
}
