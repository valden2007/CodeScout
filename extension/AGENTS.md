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
- i18n rule (v1.4b-11): новые UI-строки панели/центра/хост-статусов —
  только через t(key, lang) И ключи сразу в оба словаря
  src/i18n/{ru,en}.json. Контракт-тесты это проверяют: множества
  ключей 1:1, EN-рендер панели+центра без единого кириллического
  символа, миграция reportLanguage→language. Хардкод русского в
  разметке/статусах = красный CI. Не переводим: severity, имена
  настроек/команд, Output-логи, код/пути, тех-термины.

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
 9b. Settings center (v1.4b-1): settingsHtml is now ONE webview with a
    sticky left sidebar (Яндекс-style) and 5 anchor sections — 🔑 Ключ
    и модель, 🔄 Аудит, 📁 Проект, 🎨 Внешний вид, ℹ️ О расширении
    (version + README/repo/issue links via openLink). Click a nav item
    → smooth scrollIntoView; scrollspy highlights the active section
    (scroll listener + setActive). ONE dirty-gated 💾 Сохранить posts
    command 'saveAll' (key/provider/baseUrl + appearance + audit +
    project in one handler). Audit handles (auditPasses, maxLines,
    maxFiles, autoResume + both limits) moved from the old project
    section into 🔄 Аудит (no duplicates); 📁 Проект keeps docLinks,
    docMaxKb, docMaxLinks, auditScope. Both panel buttons (⚙️ and
    🔑 Ключ и модель) open the center via openSettingsPage; the key
    button passes anchor 'sec-key' (panel forwards message.anchor →
    command arg → buildSettingsHtml scrolls on load). Native
    codescout.openSettings kept as system fallback. SettingsState
    gained maxFiles + version. Tests: 186.
10b. Design system (v1.4b-2): @vscode/codicons devDep; media/codicon.css
    + codicon.ttf shipped in the vsix; panel and settings webview load it
    via asWebviewUri and a CSP with font-src/style-src ${cspSource} +
    nonce'd <style>/<script> (buildReportHtml/buildSettingsHtml take
    {codiconCss,cspSource} + nonce; panel/settings pass them, localResourceRoots
    widened to extensionUri). All UI emoji replaced by codicons (commit/diff/
    telescope/beaker/settings-gear/key/debug-stop/play/refresh/robot + section
    icons); Output logs and the GitHub report keep emoji (text, not UI).
    Shared --cs-* token block (spacing 4/8/12/16, radius 4/6, fonts 11/12/13/15,
    colors only from --vscode-*) in both pages — no #hex in inline CSS.
    autoResumeBadgeText lost its 🤖 prefix (icon now in markup). Tests: 192.
11. Appearance handles (v1.4b-4): src/uiPrefs.ts — UiPrefs +
    normalizeUiPrefs (clamps junk to defaults) + uiBodyAttrs +
    uiTokensCss (shared --cs-* base + density/fontsize/accent + a
    delimited /* cs-theme-palette */ block that is the ONLY place
    #hex is allowed). 7 settings: uiTheme auto|dark|light,
    accentColor auto|blue|purple|green|orange|pink, uiDensity
    compact|standard, uiFontSize s|m|l, showConfidence (bool),
    findingsSort severity|file|line, reportTheme auto|dark|light
    (export theme, applied to preview via data-report-theme). Panel
    and center render data-* attrs + shared tokens; buildReportHtml
    honors showConfidence (hides % chip) and findingsSort (section/
    issue order). Panel re-renders on config change for all 7 keys
    (no Reload); saveAll writes them. Tests: 198.
12. UI-apply fix + file picker (v1.4b-3/4 follow-up): ROOT CAUSE of
    "appearance settings don't apply" was the fix-batch-7 origin
    guard — the host onDidReceiveMessage callback has NO second
    `event`/origin arg, so `event?.origin !== 'vscode-webview'` was
    always true and dropped EVERY settings message (save never
    re-rendered, button stuck "Сохраняю…"). Replaced with a
    message-shape guard (typeof command === 'string' +
    KNOWN_SETTINGS_COMMANDS). Center now also subscribes to
    onDidChangeConfiguration for all ui/audit/project keys and
    re-renders (disposed on panel dispose). File picker: 📁 Проект
    has "Выбрать файлы/папки" (codicon-folder-opened) → command
    'pickScope' → showOpenDialog(many, defaultUri=workspace);
    folders→"rel/**", files→"rel", outside→inline warn; result
    posted back as {type:'scopePickResult'} and merged into the
    auditScope FIELD (source of truth) with dedupe; chips under the
    field (codicon-close removes a glob) and mark the shared save
    button dirty. Tests: 202.
13. Light theme + form picker (v1.4b-5): all control colors now go
    through --cs-* tokens (--cs-input-bg/fg/border, --cs-select-bg/fg,
    --cs-checkbox, --cs-chip-bg/fg, --cs-card-bg/border, --cs-shadow,
    --cs-list-hover, --cs-btn-*); auto maps them to --vscode-*, and
    forced light/dark override the TOKENS (never the raw --vscode-*).
    Light palette: bg #f5f5f5, cards #ffffff + border + soft shadow,
    light inputs w/ dark text, visible hovers (WCAG AA). Native open
    <select> dropdown stays OS-level (accepted); closed select is
    themed. Contract: no var(--vscode-input/button) outside the auto
    :root block. Custom-review form: in 'list' scope a "Выбрать
    файлы/папки" (codicon-folder-opened) button posts 'pickScope';
    panel.handlePickScope runs showOpenDialog and posts
    {type:'scopePickResult'} back; the form merges into customGlobs
    (folder→rel/**, file→rel, dedupe) with an inline outside-warn.
    Tests: 205.
14. Custom palette + save-bar fix (v1.4b-6): uiTheme enum += custom;
    codescout.customColors (JSON string of 8 tokens bg/card/fg/desc/
    border/accent/inputBg/inputFg). normalizeCustomColors drops broken
    hex to the token default; uiBodyAttrs emits data-theme="custom" +
    an inline style="--cs-*: …" (hex lives only in the inline attr and
    the delimited palette, never in the shared CSS). The 📁 Внешний вид
    section shows a palette editor (color-input + hex field per token,
    label+swatch, «Сбросить палитру») when theme=custom, with a live
    preview applied to body.style BEFORE save (save stays dirty-gated)
    and a WCAG contrast guard (fg-vs-bg/card/input < 4.5:1 → yellow
    «низкий контраст» hint via isLowContrast/contrastRatio). Fixed the
    un-themed save-bar: .savebar now uses --cs-card-bg/--cs-border/
    --cs-fg (was a hardcoded --vscode-editor-background → dark in light).
    Panel + center re-render on customColors config change. Tests: 209.
15. Theme Editor section + sharing (v1.4b-7): findingsSort moved from
    🎨 Внешний вид into 🔄 Аудит (manifest order + markup); uiFontSize
    moved into the new Theme Editor. New 6th sidebar section
    "Theme Editor" (codicon-symbol-color, #sec-theme) with groups
    ЦВЕТА (16 color inputs incl buttons/severity/chips), ГЕОМЕТРИЯ
    (btnRadius 2-12, btnHeight 24-40, cardRadius 0-16 number fields),
    ТИПОГРАФИКА (fontSize s/m/l). CustomColors extended with those
    keys; normalizeCustomColors clamps geometry + drops bad hex;
    customVarsStyle emits --cs-btn-*/--cs-error/warn/pass/--cs-chip-*/
    --cs-radius-btn/--cs-btn-height/--cs-radius-card (button/section
    CSS now uses these). "🎨 Theme Editor" button in appearance sets
    custom (dirty) + scrolls to #sec-theme; when theme!=custom the
    editor shows "применяется при теме custom" + "Включить custom".
    Live preview before save; contrast guard extended to btnFg/btnBg +
    error/warn/pass vs bg. Sharing: "📋 Копировать JSON темы" fills
    #themeJson, "📥 Применить из JSON" parses it into the fields.
    Tests: 215.
16. Batch 8 (rate-limit + hardening): reviewFiles now, on 429
    (RateLimitError) or a network error for a FILE, pauses and retries
    the SAME file via ladder [60,120,300]s up to codescout.rateLimitPauses
    (0-5, default 3; Output "⏸ rate-limit: пауза Ns, ретри файл X");
    skips only after the pauses; rateLimitPauses=0 restores the old
    single quick-retry. Hardening: panel ignores non-object messages;
    TUI Header stripAnsi(path); escapeMarkdown also escapes ` and |;
    summary escapes severity + file(escapeCell); DiffReader runs
    git rev-parse --verify on the base ref (friendly "Ветка не найдена")
    and SAFE_BASE_REF drops ~/@; action masks error.message via
    maskError (type + first 80 chars, scrubs key/token/secret patterns);
    postIssues notes "показаны первые 100 из N"; keyUrl(custom)=undefined;
    cli onExit process.exit(code). prompt-builder escapeAngle and
    ink-box.d.ts generics verified correct + locked by tests. Tests: 222.
17. Appearance subtabs + auto-custom (v1.4b-8): the separate "Theme
    Editor" sidebar section is gone — customization now lives INSIDE
    🎨 Внешний вид as two session-scoped sub-tabs [Базовые]
    [Кастомизация] (Базовые: reportLanguage, uiTheme, Theme Editor
    button, accent, density, reportTheme, showConfidence, banner;
    Кастомизация: colors/geometry/typography + copy/apply JSON).
    Sub-tabs toggle with no scroll (showSubtab). AUTO-CUSTOM: editing
    any control in Кастомизация runs ensureCustom() which sets the
    uiTheme select to custom, dispatches change (applyPreview +
    dirty), so saveAll writes uiTheme=custom — the user never flips
    the theme by hand; a soft hint "Изменения ниже автоматически
    включат тему custom" shows while theme!=custom. The Базовые
    "Theme Editor" button just switches to the Кастомизация sub-tab.
    Tests: 222 (sidebar 5 items, subtabs, auto-custom source, tokens).
 18. i18n ru/en (v1.4b-5): src/i18n/{ru,en}.json + t(key, lang, vars) —
    ALL panel/center strings (buttons, statuses, badges, section/subtab
    headers, labels, hints, save-bar, custom-review form, palette editor,
    About), host-sent progress/status/error strings, native notifications,
    and center save statuses go through t(); Output logs, severities,
    command/setting names, code/paths and tech terms (scope, glob,
    чекпоинт, nonce) are NOT translated (whitelist). codescout.language
    ru|en (default ru) replaces reportLanguage: migrateLanguageSetting
    runs once (legacy value → language, old key cleared, SecretStorage
    flag codescout.languageMigrated). Globe button (codicon-globe,
    data-command=toggleLanguage) in the panel header flips the setting —
    no Reload: panel and center re-render via onDidChangeConfiguration;
    the Базовые «Язык интерфейса и отчётов» select and the globe share
    one source of truth (codescout.language). Prompt language = language:
    en makes system+review prompts fully English (withReportLanguage(en),
    buildReviewPrompt(...,'en') notes), ru keeps the old scaffolding.
    Manifest nls: %tokens% + package.nls.json (English) +
    package.nls.ru.json (Russian). Tests: 231.
 19. Globe fix + «Язык» section (v1.4b-11): ROOT CAUSE of the dead
    globe button — at commits 874c773..c13b91e the codicon-globe was
    already rendered in the panel markup, but the host-side wiring
    (panel onDidReceiveMessage branch + codescout.toggleLanguage
    command + 'language' in the watched-config list) existed only in
    the uncommitted worktree, so every vsix built from those commits
    silently dropped the message (no whitelist in the panel — a plain
    if/else chain without the branch = dead click). The wiring landed
    with c0edcd4; toggleLanguage now also calls panel.forceLanguageRefresh()
    + rerenderSettings() directly after the awaited config.update, so
    re-render never depends on config-event timing. New e2e layer:
    vitest.config.ts aliases 'vscode' → tests/vscode-stub.ts
    (in-memory config store that fires onDidChangeConfiguration,
    command registry, fake webview views/panels), and
    tests/globe.test.ts drives the REAL activate()+CodeScoutPanel:
    mock globe click → codescout.language flips en/ru → BOTH panel and
    center webview.html re-render (EN asserts zero Cyrillic). Settings
    center: 6th sidebar section 🌐 «Язык» (#sec-lang, after «Ключ и
    модель») with the select «Язык интерфейса, отчётов и ответов
    модели» MOVED out of Внешний вид→Базовые (gone from subtab-basic;
    appear.language key deleted → lang.select/lang.hint/sec.lang), hint
    «переключает всё сразу…», extension-point comment: new language =
    new src/i18n/<lang>.json + <option> in the select + manifest enum.
    Globe stays the quick toggle over the same codescout.language
    setting (single source of truth, synced with the section select;
    one switch drives UI dict + review prompt + model answer language).
    Tests: 240.
 20. Onboarding + ETA (v1.4b-12): PanelUx {onboarding, firstAudit,
    progress{checked,total,etaSeconds,pass,totalPasses}, summary} is the
    single ux channel of buildReportHtml/buildEmptyReportHtml. FIRST RUN
    (no key, globalState flag codescout.onboardingDismissed unset):
    3-step welcome card instead of the empty state — 1 key →
    openSettingsPage sec-key, 2 chooseModel, 3 scanFull + «Не показывать
    снова» (codescout.dismissOnboarding command writes globalState).
    KEY BUT NO AUDIT (.codescout/context.json missing): short
    «Запусти первый аудит» card + 🤖 autonomous-mode hint; the panel
    learns firstAuditDone from the host at activation, after a finished
    audit and via resetOnboarding. PROGRESS: bar (checked/total %) +
    file/pass («круг p/t») + ETA — median of clean per-file durations ×
    remaining; «…» while <2 files; rate-limit pauses are SUBTRACTED
    from recorded durations (median stays clean) and enter the ETA
    separately: during auto-catchup wait = secondsLeft + sum of unused
    AUTO_RESUME_LADDER steps (ladderRemainingSeconds). auditEtaSeconds/
    medianSeconds/ladderRemainingSeconds are pure (projectAudit).
    Durations survive auto-resume via setScanning(true, keepAuditStats).
    No duplicate Output line (bar is the ETA surface). FINISHED AUDIT:
    summary card «N находок · M файлов · время» + openReport
    (codescout.openAuditReport → output.show + panel.focus) and runAgain
    (scanFull). All strings in both dicts; e2e: dismissOnboarding click
    hides the card forever (vscode-stub globalState). Tests: 247.
 21. reportIssue + open-source wrapper (v1.4b-13): pure
    extension/src/reportIssue.ts — buildIssueBody(lang, input) makes a
    Markdown draft (Что случилось / Шаги / Ожидал-Получил / Диагностика:
    versions ext+VS Code+OS, provider/model/language/uiTheme/auditPasses/
    rateLimitPauses, key installed? yes/no — NEVER the key, last 50 Output
    lines, last scan error) + redactSecrets strips exact key values AND
    sk/gsk/ghp/AIza/ya29/glpat prefixes, reportIssueUrl →
    github.com/valden2007/CodeScout/issues/new?body=<encoded>. Command
    codescout.reportIssue (registered in activate) closes over the output
    tail mirror (appendLine wrapper keeps the last 50 lines; clear wipes
    them) and module-level lastScanError set at every scan catch; the
    revived «Сообщить о проблеме» button in ℹ️ О расширении posts
    reportIssue (whitelisted) → openExternal; panel message branch too.
    SECURITY CONTRACT in tests: body never contains the mock key or any
    provider prefix (unit + e2e through the real command). GitHub visitors
    get the same fields via .github/ISSUE_TEMPLATE/{bug_report,
    feature_request}.md; CONTRIBUTING.md rewritten (reports, dev flow,
    tests incl. vscode-stub, translation = src/i18n/<lang>.json + option
    + enum); README += «Privacy & local models» (Ollama
    http://localhost:11434/v1, LM Studio, code never leaves the machine)
    and «How to report a bug»; MIT verified in LICENSE (2026) +
    "license":"MIT" in both manifests (locked by test). Tests: 256.
 22. Aggressive pauses + file cooldown (v1.4b-14): the skip-after-2-3-
    attempts was mostly NOT the short ladder — providers like B.AI return
    over-limit as plain Error('too many requests'/'overloaded'/'quota')
    on HTTP 502/503 or 200-text, which failed the
    RateLimitError||isNetworkError gate → file skipped INSTANTLY, the
    ladder never ran. isRateLimitText added to the retriable gate;
    RATE_LIMIT_PAUSE_LADDER doubled to [120,300,600]; new setting
    codescout.fileCooldownSeconds (0-30, manifest) = pause between files
    even without errors — explicit value wins, defaults 5s (1 pass) /
    10s (multi-pass, fileCooldownSecondsFromSetting; 0 = off for Ollama
    etc.); hard PASS_BETWEEN_SECONDS=15 abuse-gap between passes of one
    file (not configurable by design); every 429/overload logs
    «· 429 за 5 мин: N» via recordRateLimitHit/rateLimitHitsLast5min
    (⚠️ hour-rest hint when >10). Cooldown/pass sleeps run through the
    injectable sleeper and honor cancel; audit keeps pauseByFile so the
    ETA median stays clean. reviewFiles is now exported; functional
    tests in tests/rate-limits.test.ts (fake fetch+sleeper; note the
     provider's internal 2s min-interval pacing adds real time). Tests: 263.
  23. Persistent partial audit results (v1.4b-15): results lived only in
     memory — after a VS Code/PC restart the panel showed «0 issues ·
     0 files» while the checkpoint remembered 35/42. After EVERY finished
     file persist() now also writes .codescout/audit-results.json
     {findings, checkedFiles, total, model, updatedAt} ATOMICALLY
     (writeJsonAtomic: temp in the same dir + renameSync — never a half
     file); on clean/interrupted completion runFullAuditOnce writes the
     final report there (single source). At activation, if results exist
     and checkedFiles < total the panel renders them as a normal report
     (panel.restoreAuditResults sets hasRun + stats + resume banner
     «Аудит оборвался: X из Y · находок N» with Продолжить/Начать заново;
     complete runs restore findings WITHOUT the banner). restartAudit is
     now a modal confirm («Удалить и начать заново») — only after yes it
     clearAuditProgress + clearAuditResults (and a fresh run recreates
     them empty). progressView/AuditResumeView carry findings count;
     resume.findings key in both dicts. auditResultsPath/read/write/
     clear helpers in projectAudit; .codescout stays git-ignored.
     e2e in tests/audit-results.test.ts drives a real interrupted audit
     (c.ts errors) through the stub → re-activate → findings+banner.
     Tests: 267.
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
