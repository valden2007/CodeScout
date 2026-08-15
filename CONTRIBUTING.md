# Contributing to CodeScout

Thank you for contributing. CodeScout is an experimental but production-oriented GitHub Action, so changes should preserve predictable behavior, clear failure modes, and secret safety.

## Development flow

Create a focused branch, install dependencies with `npm install`, and make the smallest change that solves the problem. Before opening a pull request, run `npm run typecheck`, `npm test`, and `npm run build`. The generated `dist/index.js` must be included whenever source code changes affect the action.

## Pull requests

Describe the user-visible behavior, the design trade-off, and the tests that demonstrate the change. Do not include API keys, real repository secrets, or unredacted private source code in fixtures. New provider integrations should implement the `LLMProvider` interface and include tests for errors, retries, and malformed responses.

## Commit style

Use conventional commit prefixes such as `feat:`, `fix:`, `test:`, `docs:`, and `chore:`. Keep unrelated refactors out of feature pull requests.
