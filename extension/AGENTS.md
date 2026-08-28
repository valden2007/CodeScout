# AGENTS.md — context for AI coding agents (OpenCode, Cline, Aider)

## What is this
CodeScout — AI code reviewer with THREE interfaces:
1. GitHub Action — auto-reviews PRs, posts findings as comments
2. CLI — `node dist/cli.js scan` in terminal
3. VS Code extension — sidebar panel with review buttons

## Stack
- TypeScript, Node 20+, no runtime deps in core (fetch only)
- esbuild for extension bundle (extension/esbuild.js)
- Tests: vitest in tests/core.test.ts, run: npm test

## Structure
- src/ — shared core: llm-client, providers, diff, parser, line-correction
- src/cli/ — CLI entry
- action/ — GitHub Action
- extension/src/ — VS Code extension (panel webview, audit, onboarding)
- tests/ — unit tests
- examples/ — test fixtures (buggy2.ts = planted bugs, DO NOT edit)

## Commands
- npm test
- npm run typecheck
- npm run build (CLI + action)
- npm --prefix extension run compile
- cd extension && npm run package (builds .vsix)

## Work rules
- ONE task = ONE commit, then push
- Commit messages: Russian, lowercase, human style: "модальный баннер аудита"
- After ANY change: npm test + typecheck must pass
- Providers are OpenAI-compatible; models come from live GET /models
- Keys stored in SecretStorage (extension) / env (CLI) / Secrets (action)

## Current state (v1.1.2 released)
Done: zero-config onboarding (provider auto-detected by key prefix),
live model picker, optional full project audit with
.codescout/context.json, .codescout/rules.md custom rules,
clickable findings (open file at line), scan progress with live
seconds ticker, cancel button, rate-limit retry, self-test sample,
reports dumped to Output channel, modal audit welcome banner
(overlay with pointer-events lock, Escape to dismiss, tab-trap).

v1.1.2 security hotfix: commit_id per changed file, prompt-injection
sanitization in buildReviewPrompt, no more security→performance
silent downgrade, path-traversal guards (panel openFile sep-check,
line-correction realpathSync). Tests: 53 in vitest.

## Plan for v1.2
1. Settings Page — DONE in 1.2a: command codescout.openSettings,
   webview "CodeScout: Настройки" (extension/src/settingsHtml.ts) with
   key (SecretStorage, masked, never echoed raw), provider auto/manual,
   baseUrl for custom (config codescout.baseUrl, Global target,
   priority setting > env CODESCOUT_BASE_URL), report language
   (codescout.reportLanguage ru/en wired into prompts via
   withReportLanguage), audit banner toggle (codescout.showAuditBanner
   gates welcome banner at activation), gear button in panel header.
2. Incremental render — DONE in 1.2b: panel.ts keeps one webview
   document during a scan; setProgress/setModelThinking/setRetry send
   postMessage {type:'progress'|'status'} and the webview script
   patches #progressLine / #statusSlot DOM in place (ticker moves the
   seconds counter without rebuilds, scroll preserved). Full
   buildReportHtml runs only on key state changes (scan start/stop,
   new report, error/cancel, key/model, welcome banner). The
   dataset.codescoutWelcomeBound hack is gone — one Escape + one
   tab-trap keydown listener per document, clicks fully delegated.
3. Ignore-lists for full audit — DONE in 1.2c: audit skips files
   matched by root .gitignore + .codescout/ignore (simple parser:
   line-per-pattern, comments, dir patterns "vendor/", slash-less
   globs "*.min.js" match any segment, root-relative "js/data.js";
   negations "!" are skipped by design, zero new deps).
   isIgnoredAuditPath is now live (built-in dirs + hidden + patterns)
   and used by the walk; silent alphabetical cut replaced by
   codescout.maxFiles setting (default 100) with Output line
   "⚠️ Пропущено N файлов по лимиту" and start summary
   "Игнорируется: X файлов".
4. Diff of findings between audits (new/fixed since last run)
UI style rule: new screens reuse reportHtml.ts style (CSS vars, compact,
no decoration). FULL VISUAL REDESIGN is scheduled for v2.0 — do not
pre-design now.
Backlog v2.x (RAG, GitLab CI, compliance mode) — DO NOT start, scope freeze.
