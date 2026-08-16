import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
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

const MOCK_ISSUES: Record<string, Issue[]> = {
  'examples/buggy2.ts': [
    { severity: 'critical', category: 'security', confidence: 90, line: 14, code: 'const apiKey = "sk-live-1234567890";', suggestion: 'Use environment variables or a secrets manager' },
    { severity: 'critical', category: 'bug', confidence: 90, line: 8, code: 'for (let i = 0; i <= prices.length; i++) {', suggestion: 'Change loop condition to i < prices.length' },
    { severity: 'medium', category: 'bug', confidence: 80, line: 17, code: 'return a / b;', suggestion: 'Add a check for b === 0' }
  ],
  'src/payments.ts': [
    { severity: 'low', category: 'maintainability', confidence: 76, line: 22, code: 'const timeout = 5000;', suggestion: 'Move configuration values into a named settings object' }
  ]
};

function scan(path: string): ScanState {
  try {
    return { files: readGitDiff(path) };
  } catch (error) {
    return { files: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export function App({ args }: Props) {
  const [result] = useState(() => scan(args.path));
  const [isScanning, setIsScanning] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setIsScanning(false), 1000);
    return () => clearTimeout(timer);
  }, []);

  const allIssues = Object.values(MOCK_ISSUES).flat();
  const stats = {
    issues: allIssues.length,
    files: result.files.length,
    seconds: 1.0,
    critical: allIssues.filter((issue) => issue.severity === 'critical').length,
    medium: allIssues.filter((issue) => issue.severity === 'medium').length,
    low: allIssues.filter((issue) => issue.severity === 'low').length
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Header path={args.path} filesAnalyzed={result.files.length} />
      {isScanning ? (
        <Box marginTop={1}><Text color="cyan"><Spinner type="dots" /> Scanning local diff...</Text></Box>
      ) : result.error ? (
        <Box marginTop={1}><Text color="red">Error: {result.error}</Text></Box>
      ) : (
        <>
          <Box marginTop={1}><Text color="cyan">Visual preview — mock review findings</Text></Box>
          {Object.entries(MOCK_ISSUES).map(([filename, issues]) => <FilePanel key={filename} filename={filename} issues={issues} />)}
          <SummaryBar stats={stats} />
        </>
      )}
    </Box>
  );
}
