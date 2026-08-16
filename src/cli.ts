#!/usr/bin/env node

import React from 'react';
import { config as loadDotenv } from 'dotenv';
import { render } from 'ink';
import { parseArgs } from './cli/args';
import { App } from './tui/App';

async function main(): Promise<void> {
  loadDotenv();
  const args = parseArgs(process.argv.slice(2));
  render(React.createElement(App, { args }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
