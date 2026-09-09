# Contributing to CodeScout

CodeScout is an AI code reviewer with three faces: a GitHub Action, a CLI, and a VS Code extension. Contributions of every size are welcome — a typo fix counts.

## Report a bug

Fastest way: open the CodeScout panel → **Настройки → О расширении → «Сообщить о проблеме»**. The button pre-fills an issue with steps, expected/actual and an auto-collected diagnostics block (versions, provider/model, recent Output lines — API keys are redacted automatically, and the key itself is never included).

Or use the [bug template](.github/ISSUE_TEMPLATE/bug_report.md) directly. If you paste Output by hand, scrub `sk-…`, `gsk_…`, `ghp_…`, `AIza…` first. Ideas and superpowers go to the [feature template](.github/ISSUE_TEMPLATE/feature_request.md).

## Set up & run

```bash
npm install
npm test && npm run typecheck && npm run build   # core, CLI, action
npm --prefix extension run compile               # the VS Code extension bundle
```

Before any PR: `npm test` and `npm run typecheck` must be green. Tests live in `tests/` (vitest) — every behavior change deserves a test; source-contract tests are fine where a real VS Code host isn't available (`tests/vscode-stub.ts` emulates one).

## Pull requests

One task = one focused commit (commit messages are lowercase, human style: `язык: секция + фикс глобуса`). Describe the user-visible behavior and the trade-off. Never commit API keys, real secrets or unredacted private code — fixtures included.

## Translations

The UI (panel + settings center) is fully localized via two dictionaries:

- **New language = 3 steps:** add `src/i18n/<lang>.json` (key set identical to `ru.json`), add an `<option>` to the Language section select in `extension/src/settingsHtml.ts`, extend the `codescout.language` enum in `extension/package.json`.
- Hard rule: no hardcoded UI strings — everything goes through `t(key, lang)` and **both dictionaries are updated in the same commit** (`ru`/`en` key sets are kept 1:1 by contract tests; the EN render must contain zero Cyrillic).
- Not translated: severities, setting/command names, Output logs, code and paths.

Thanks! 🤝
