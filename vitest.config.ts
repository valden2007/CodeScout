import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./tests/vscode-stub.ts', import.meta.url))
    }
  },
  test: {
    include: ['tests/**/*.test.ts']
  }
});
