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
- Product philosophy: любой новый лимит = настройка с разумным
  дефолтом; хардкод лимитов запрещён без продуктовой причины

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
4. Diff of findings between audits — DONE in 1.2d: full audit writes
   .codescout/history.json (key = file:line:category, stores scanType,
   savedAt, provider/model) and compares with the previous run:
   "🆕 новых · ✅ починено · 🔁 осталось" strip on top of the report,
   🆕 badge on new findings, collapsed <details> "Починено с прошлого
   скана" list. First scan: no diff strip, no errors. history.json is
   git-ignored (.codescout/ in .gitignore) and lives per-workspace.
5. Custom review — DONE in 1.2e: "🎯 Своё ревью" button in the panel
   opens an inline webview form (textarea + scope select all/active/
   list of glob patterns, comma separated). Focus text goes into the
   prompt as FOCUS INSTRUCTIONS fences (control chars stripped, user
   instruction label, JSON format locked). Report header shows
   "🎯 Кастомное ревью: <текст>". NOT written to history.json —
   only full audits are. Reuses collectFilesForScope + glob matcher;
   glob engine learned "**".
6. Settings "Проект" section (1.2e): "📜 Открыть rules.md" creates
   .codescout/rules.md from a template if missing and opens it;
   doc links textarea (one per line) saves to codescout.docLinks
   (array setting, Global scope) and full audit appends
   "Документация проекта: <links>" to the prompt — no fetch, RAG is
   v1.3. All save buttons in settings are dirty-gated with
   ✅/❌ status feedback.
UI style rule: new screens reuse reportHtml.ts style (CSS vars, compact,
no decoration). FULL VISUAL REDESIGN is scheduled for v2.0 — do not
pre-design now.

## v1.3 in progress
1. Audit checkpoints — DONE in 1.3a: full audit writes
   .codescout/audit-progress.json {startedAt, model, checked:[{file,
   issues}], remaining:[...]} after every finished file (resume =
   merge checkpoint findings + review only remaining). Abort/cancel/
   error and rate-limit-skipped runs leave the checkpoint behind and
   the panel shows two buttons: "▶️ Продолжить (N из M)" and
   "🆕 Начать заново" (also at activation if a progress file exists;
   also palette commands codescout.resumeAudit / codescout.restartAudit).
   Resume refuses when model changed (starts fresh, clears).
   Clean completion deletes the file. Not committed (.codescout/).
2. RAG v1 — DONE in 1.3b: full audit fetches codescout.docLinks
   (http(s) only, ≤5 links, AbortSignal.timeout 5s, sanitized text),
   strips tags/scripts/entities, sanitizes C0/bidi + neutralizes
   patch fences, and injects a "Документация проекта" section wrapped
   in CODESCOUT_DOCS fences labeled as untrusted web text. Cache
   .codescout/docs-cache.json (url → {fetchedAt,text}, TTL 24h);
   fetch failure falls back to stale cache, otherwise Output warning
   only — audit never breaks. Cross-file context: every reviewed
   file gets "Файл импортирует: ..." (relative ES imports/exports/
   requires resolved to workspace-relative paths, cap 10) in its
   review prompt via buildReviewPrompt importsLine. Tests: 98.
3. Configurable RAG limits (1.3b-settings): docMaxKb (default 50)
   and docMaxLinks (default 5) settings, edited in Settings → 📁
   Проект (numeric inputs, dirty-gated save). fetchDocsForPrompt
   takes a DocLimits argument (no hardcode at call site; oversized
   docs are truncated to the limit keeping the HEAD — warning
   "⚠️ Док … усечён до NKB", utf8-safe slice); >100KB total docs
   section → advisory Output "🔴 плотный контекст… для сильных
   моделей" (never drops). Defaults also enforced in the manifest
   (minimum/maximum). Tests: 102.
4. Fix-batch 2 (security/crash) — DONE: optional chaining on
   findingsDiff.fixed + readFindingsHistory normalizes corrupt
   entries; imports line → CODESCOUT_UNTRUSTED_IMPORTS fence with
   neutralizeFences; TUI stripAnsi for code/category/suggestion/
   filename, high severity in TUI type (🟠), stats.seconds null →
   'N/A'; panel openFile uses getWorkspaceFolder (multi-root) +
   realpath-before-containment (deleted-parent safe); maskApiKey
   for ≤3 chars → '•••'; resolveBaseUrl forbids http except
   localhost/127.0.0.1; GitHub report escapeHtml + backtick-safe
   inlineCode; audit walker skips symlinks (isSymbolicLink);
   response-parser clear RU errors for null/array/scalar JSON.
   Tests: 109.
5. Fix-batch 3 (core) — DONE: parseUnifiedDiff accepts
   `+++ /dev/null` (deleted files); stampCommitIds uses
   octokit.paginate(repos.listCommits) + console.warn instead of
   empty catch; correctIssueLine matches multi-line snippets
   (whole-content indexOf + newline count); numberPatch uses an
   inHunk state so added `+++i;` lines are numbered and file
   headers are not; normalizeProvider via Object.hasOwn; groq
   detect model → llama-3.3-70b-versatile; validateFlags stops at
   `--`; DiffReader: `git diff HEAD` (no staged/unstaged merge),
   `git diff HEAD~1 HEAD` for lastCommit, maxBuffer 10MB;
   llm-client: abortError()/isAbortError plain-Error pair, sleep
   removes its abort listener on resolve, retry-after RFC1123
   date support, retry-after 0 falls back to the backoff ladder;
   panel: message subscription disposed on re-resolve/dispose,
   update() status kind 'success' (green banner) instead of
   'retry'. Tests: 121.
6. Fix-batch 4 (regressions + security layer) — DONE: clampInt
   clamps both ends (1.3b-settings regression); report-formatter
   no escapeCell-before-escapeHtml double escaping (pipes stay
   raw in HTML, escaped once); neutralizeFences replaces only
   complete <<<CODESCOUT_*>>> markers via regex (substring
   corruption fixed); numberPatch isNaN guard on hunk parse;
   auditResume.model escapeHtml (already present — verified);
   webview applyStatus kind whitelist regex; DiffReader base ref
   validated (no leading dash, SAFE_BASE_REF allowlist) —
   argument injection closed; panel containment via
   path.relative ('..' / absolute / empty) instead of startsWith;
   GitHubClient.postIssue catches 422 → console.warn + continue
   (returns boolean, comment-poster counts real posted);
   extractJson balanced-brace scanner (string/escape aware)
   replaces lastIndexOf('}'). WON'T FIX by owner decision:
   maskApiKey tail, key reveal toggle. Tests: 128.
7. Fix-batch 5 (performance + robustness) — DONE: src/async-pool.ts
   (12-line concurrency limiter, no deps, concurrency 4) powers
   action.ts file review (Promise-based pool + core.warning per
   failed file — one bad file no longer kills the run),
   comment-poster dedupe via Set key + parallel posting, and
   stampCommitIds fan-out; RateLimitError now has typed
   waitSeconds/details fields (no JSON-in-message); correctIssueLine
   early-exits on 2nd hit (O(N)); hideBin gone — yargs(argv) with
   user args directly; DiffReader: unborn-branch clear error,
   single-commit lastCommit falls back to `git show --format= HEAD`;
   App.tsx: primitive useEffect deps + onExit prop (no
   process.exitCode in component); parseUnifiedDiff: hunk-state
   counting (in-hunk +++i;/--j; counted as +/-, headers only
   outside hunk) and segment-based ignore (my_vendor_lib safe);
   TUI confidenceLabel rounds/clamps percent; sample summary has a
   1-of-3 message. Tests: 140.
8. maxLines + chunking (1.3f): codescout.maxLines setting
   (default 0 = no limit, edited in Settings → 📁 Проект next to
   the RAG limits). 400-line hardcode is gone — collectAuditFiles/
   collectFilesForScope take maxLines from settings; 0 means every
   file is reviewed and files >800 lines are auto-chunked with a
   50-line overlap (absolute line numbers preserved, Output line
   "📄 файл X: N чанков"), findings merged with dedupeIssues
   (file:line:description) both per-file in the checkpoint and in
   the final report; N > 0 keeps the old skip-with-warning
   behavior for weak models. Panel header got a "⚙️ Настройки"
   button (data-command openSettings) beside the brand; the quick
    "🔑 Ключ и модель" button stays. Tests: 145.
 9. Auto-resume + selective review (1.3g+h): codescout.autoResume
    (bool, default false) + checkbox in 📁 Проект; runFullAudit is a
    wrapper around runFullAuditOnce — on a non-user stop (rate-limit/
    network) it auto-resumes from the checkpoint with a backoff
    ladder 30/60/120/300s (autoResumeDecision); caps are settings
    codescout.autoResumeMaxAttempts (default 0) and
    codescout.autoResumeMaxMinutes (default 0) where 0 = unlimited
    (big multi-pass projects can run for a day); when a cap is set
    and hit, it falls back to the manual banner; panel shows a live
    "🤖 авто-догон: X/Y, попытка N[/max] через Ns" countdown and an
    idle badge "🤖 Автономный режим: ВКЛ (без лимита / макс. …)"
    that re-renders on config change; ⏹ Остановить
    sets autoResumeCancelled and kills both request and wait; VS Code
    startup shows the banner but never auto-starts. codescout.auditScope
    (comma globs) filters the full audit via collectAuditFiles;
    codescout.reviewSelection (explorer/context, "CodeScout: проверить")
    reviews the selected file/folder once, ignoring auditScope; panel
    header has a "🔍 поиск файла…" input filtering file sections by path
    substring. Tests: 152.
10. Multi-pass audit + readable logs (1.3i): codescout.auditPasses
    (1-3, default 1, clamped by auditPassesFromSetting) + field in
    📁 Проект. reviewFiles runs `passes` rounds per file; from pass 2
    the prompt gets "В прошлый круг по этому файлу ты уже нашёл:
    [passFindingsSummary]. Ищи, что ПРОПУСТИЛ, не повторяй их."
    (sanitized + fence-neutralized); per-file findings are deduped
    (file:line:description) across passes before onFileChecked, so the
    checkpoint closes a file only after ALL passes. Output logs are now
    "🔎 файл X/Y: name — старт…" / "✅ файл X/Y: name — готово за Ns"
    (one start per file, real per-file seconds) and "🔄 круг P/T: файл X"
    for extra passes. Tests: 156.
 Backlog v2.x (GitLab CI, compliance mode) — DO NOT start, scope freeze.
 RAG v1.3b is done — the old "RAG" backlog mention is superseded.
