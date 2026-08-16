import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { CliArgs } from '../cli/args';
import { LocalDiffFile, readGitDiff } from './DiffReader';

interface Props {
  args: CliArgs;
}

interface ScanState {
  files: LocalDiffFile[];
  error?: string;
}

function scan(path: string): ScanState {
  try {
    return { files: readGitDiff(path) };
  } catch (error) {
    return { files: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export function App({ args }: Props) {
  const [result] = useState(() => scan(args.path));

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>🕵️ CodeScout CLI</Text>
      <Text>Command: {args.command}</Text>
      <Text>Path: {args.path}</Text>
      {result.error ? (
        <Text color="red">Error: {result.error}</Text>
      ) : (
        <>
          <Text>Scanning {result.files.length} file{result.files.length === 1 ? '' : 's'}...</Text>
          {result.files.length === 0 ? (
            <Text dimColor>No changed files found in the latest commit.</Text>
          ) : (
            result.files.map((file) => <Text key={file.filename}>- {file.filename}</Text>)
          )}
        </>
      )}
    </Box>
  );
}
