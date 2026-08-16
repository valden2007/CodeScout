import React from 'react';
import { Box, Text } from 'ink';

export type IssueSeverity = 'critical' | 'medium' | 'low';

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
  seconds: number;
  critical: number;
  medium: number;
  low: number;
}

const severityMeta: Record<IssueSeverity, { emoji: string; color: 'red' | 'yellow' | 'green' }> = {
  critical: { emoji: '🔴', color: 'red' },
  medium: { emoji: '🟡', color: 'yellow' },
  low: { emoji: '🟢', color: 'green' }
};

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
  const meta = severityMeta[issue.severity];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={meta.color} bold>{meta.emoji} {issue.severity.toUpperCase()} · {issue.category} · {issue.confidence}%</Text>
      <Text dimColor>line {issue.line} │ {issue.code}</Text>
      <Text color="green">→ {issue.suggestion}</Text>
    </Box>
  );
}

export function FilePanel({ filename, issues }: { filename: string; issues: Issue[] }) {
  return (
    <Box borderStyle="single" borderColor="gray" padding={1} marginTop={1}>
      <Box flexDirection="column">
        <Text bold>{filename}</Text>
        {issues.map((issue, index) => <IssueRow key={`${filename}-${issue.line}-${index}`} issue={issue} />)}
      </Box>
    </Box>
  );
}

export function SummaryBar({ stats }: { stats: SummaryStats }) {
  return (
    <Box borderStyle="round" borderColor="green" padding={1} marginTop={1}>
      <Text color="green" bold>{stats.issues} issues · {stats.files} files · {stats.seconds.toFixed(1)}s · 🔴 {stats.critical} · 🟡 {stats.medium} · 🟢 {stats.low}</Text>
    </Box>
  );
}
