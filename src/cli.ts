#!/usr/bin/env node

import React from 'react';
import { render } from 'ink';
import { parseArgs } from './cli/args';
import { App } from './tui/App';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  render(React.createElement(App, { args }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
