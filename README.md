# 🕵️ CodeScout

**AI code review for VS Code, CLI and GitHub Actions.** One review core, three
interfaces: a VS Code sidebar panel, a terminal CLI, and a GitHub Action that
posts inline comments on pull requests. Bring your own key — CodeScout never
runs a shared proxy and never stores your credentials on a server.

![CI](https://github.com/valden2007/CodeScout/actions/workflows/ci.yml/badge.svg)

## Features

- **Four review modes** — last commit, uncommitted changes, full project audit,
  and a custom review with your own focus text.
- **Full project audit with checkpoints** — progress is written to
  `.codescout/audit-progress.json` after every file, so an interrupted audit
  resumes with **▶️ Continue** instead of starting over.
- **🤖 Auto-resume (autonomous mode)** — on a rate-limit or network stop the
  audit retries itself from the checkpoint with a 30s → 60s → 2min → 5min
  backoff. **Unlimited by default** (no attempt/time cap unless you set one);
  a user stop always wins.
- **Multi-pass audit (1–3 rounds)** — from round 2 the model is shown what it
  already found and told to look for what it *missed*; findings are merged and
  de-duplicated.
- **Large-file chunking** — files over 800 lines are split into overlapping
  chunks (50-line overlap) with absolute line numbers preserved, so the model
  never loses the middle of a big file.
- **Selective audit** — restrict the full audit with `codescout.auditScope`
  glob patterns, or right-click any file/folder in the Explorer and choose
  **CodeScout: проверить** for a one-off review that ignores the scope.
- **RAG over project docs** — `codescout.docLinks` are fetched (http(s) only,
  5s timeout), stripped to sanitized text, cached in
  `.codescout/docs-cache.json` for 24h, truncated to a size limit, and injected
  as an untrusted "Project documentation" section.
- **Findings diff between audits** — `🆕 new · ✅ fixed · 🔁 still there`, with a
  collapsed "fixed since last scan" list.
- **Project rules** — `.codescout/rules.md` is mixed into every review prompt.
- **Report language RU/EN** — `codescout.reportLanguage`.
- **Providers: auto + custom** — the provider is detected from the key prefix
  (Groq `gsk_`, Gemini `AIza`/`AQ.`, OpenRouter `sk-or-`, GitHub `ghp_`/
  `github_pat_`); `custom` points at any OpenAI-compatible endpoint (Ollama,
  LM Studio, a proxy). Models are read live from `GET /models`.
- **Keys in SecretStorage** — the extension stores the key in VS Code
  SecretStorage (masked, never echoed raw); the CLI reads env/`.env`; the
  Action reads a repository secret.

## Quick start

### VS Code extension

**From a `.vsix`:** download the latest `codescout-vscode-*.vsix` (the CI
uploads it as a build artifact on every push to `main`), then in VS Code:
`Extensions → … → Install from VSIX…`.

**From source:**

```bash
git clone https://github.com/valden2007/CodeScout.git
cd CodeScout
npm ci
npm run package          # builds extension/dist and packages the .vsix
```

Then install the generated `extension/codescout-vscode-*.vsix` as above.

**First run:**

1. Open the CodeScout sidebar and click **🔑 Key and model** — paste a provider
   key; the provider and a sensible model are detected automatically.
2. Click **🔬 Full project audit** to let CodeScout learn the project (it writes
   `.codescout/context.json`), or start with **🔍 Review last commit**.
3. Findings are clickable — they open the file at the reported line.

### CLI

```bash
npm i -g codescout
codescout scan                 # review uncommitted changes (git diff HEAD)
codescout scan --last-commit   # review the last commit (HEAD~1..HEAD)
codescout scan --base main     # review <branch>...HEAD
codescout scan --dry-run       # show the diff, call no LLM
```

The CLI loads `.env` from the project directory (already git-ignored):

```bash
GEMINI_API_KEY=...     # or GROQ_API_KEY / OPENROUTER_API_KEY / GITHUB_TOKEN
```

### GitHub Action

Add a repository secret (e.g. `GEMINI_API_KEY`) and this workflow:

```yaml
name: CodeScout review
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: valden2007/CodeScout@main
        with:
          provider: gemini
          model: gemini-2.5-flash
          api-key: ${{ secrets.GEMINI_API_KEY }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Pin to an immutable tag or commit for production use.

## Settings (VS Code)

All extension settings live under the `codescout.` namespace. Defaults below
come from the extension manifest.

| Setting | Default | Meaning |
|---|---|---|
| `codescout.autoResume` | `false` | Autonomous mode: auto-resume an interrupted audit from the checkpoint with backoff. A user stop cancels it; VS Code startup never auto-starts. |
| `codescout.autoResumeMaxAttempts` | `0` | Max auto-resumes per audit run. `0` = unlimited. |
| `codescout.autoResumeMaxMinutes` | `0` | Max minutes auto-resume is allowed. `0` = unlimited. |
| `codescout.auditPasses` | `1` | Review rounds per file in a full audit (1–3). Round 2+ re-reads prior findings and hunts for misses. |
| `codescout.maxLines` | `0` | Max lines per file. `0` = no limit (files > 800 lines are chunked with a 50-line overlap); `N > 0` skips longer files (for weak models). |
| `codescout.auditScope` | `""` | Comma-separated globs limiting the full audit (e.g. `src/**, extension/src/**`). Empty = all files. Right-click review ignores it. |
| `codescout.docLinks` | `[]` | Project documentation URLs fetched into the audit prompt (RAG). |
| `codescout.docMaxKb` | `50` | Max size of one doc in the prompt (KB); larger docs are truncated keeping the head. |
| `codescout.docMaxLinks` | `5` | Max doc links fetched per full audit. |
| `codescout.maxFiles` | `100` | Max files per full audit; the rest are reported in Output. |
| `codescout.reportLanguage` | `ru` | Language of model-written report text (`ru` / `en`). |
| `codescout.provider` | `gemini` | LLM provider (`gemini`, `groq`, `openrouter`, `github`, `custom`). |
| `codescout.model` | `gemini-2.5-flash` | Model name for the chosen provider. |
| `codescout.baseUrl` | `""` | OpenAI-compatible base URL for `custom` (Ollama/LM Studio/proxy). |
| `codescout.showAuditBanner` | `true` | Show the full-audit welcome banner on window start. |

Most of these are editable in the in-panel settings page (**🔑 Key and model →
📁 Project**); every limit is a setting with a sane default.

## Extension commands

Available from the Command Palette (`Ctrl/Cmd+Shift+P`) and the panel buttons:

| Command | What it does |
|---|---|
| `CodeScout: review last commit` | Review `HEAD~1..HEAD`. |
| `CodeScout: review uncommitted changes` | Review the working tree (`git diff HEAD`). |
| `CodeScout: full project audit` | Review every source file (respecting scope/limits), with checkpoints. |
| `CodeScout: продолжить прерванный аудит` | Resume the last audit from its checkpoint. |
| `CodeScout: полный аудит заново` | Clear the checkpoint and start a fresh full audit. |
| `CodeScout: своё ревью с фокусом` | Custom review with your own focus text and scope. |
| `CodeScout: проверить` | Right-click a file/folder in the Explorer for a one-off review. |
| `CodeScout: test on sample` | Run the built-in planted-bug sample to verify the model. |
| `CodeScout: stop scan` | Cancel the running scan (and any auto-resume). |
| `CodeScout: set API key` / `clear API key` | Store or remove the key in SecretStorage. |
| `CodeScout: choose model` | Pick a model from the provider's live `/models` list. |
| `CodeScout: настройки (нативные)` | Open the native VS Code settings filtered to `codescout`. |
| `CodeScout: ключ и модель` | Open the in-panel settings webview. |

## Files CodeScout writes

All audit state lives in a git-ignored `.codescout/` folder at the workspace
root, so nothing is committed:

| File | Purpose |
|---|---|
| `.codescout/context.json` | Project summary from the last full audit (stack, top findings). |
| `.codescout/history.json` | Previous findings, used for the `🆕/✅/🔁` diff. |
| `.codescout/audit-progress.json` | Checkpoint for resume / auto-resume. |
| `.codescout/docs-cache.json` | 24h cache of fetched documentation text. |
| `.codescout/rules.md` | Your project rules, mixed into every prompt. |
| `.codescout/ignore` | Extra ignore patterns for the audit (on top of `.gitignore`). |

## CLI flags

| Flag | Purpose |
|---|---|
| `--path <dir>` | Repository directory to scan (default: cwd). |
| `--provider <name>` | `gemini`, `groq`, `openrouter`, `github`, `custom`. |
| `--model <name>` | Model for the provider. |
| `--base-url <url>` | Custom OpenAI-compatible endpoint (https, or http only for localhost). |
| `--api-key <key>` | Override the environment key for one run. |
| `--last-commit` | Review `HEAD~1..HEAD` instead of the working tree. |
| `--base <branch>` | Review `<branch>...HEAD`. |
| `--dry-run` | Read and print the diff without calling an LLM. |

Unknown flags and value-less string flags are rejected with a Russian hint.

## Providers & models

The provider is auto-detected from the key prefix, or chosen manually:

| Prefix | Provider | Default model |
|---|---|---|
| `gsk_` | Groq | `llama-3.3-70b-versatile` |
| `AIza` / `AQ.` | Gemini | `gemini-2.5-flash` |
| `sk-or-` | OpenRouter | `meta-llama/llama-3.3-70b-instruct:free` |
| `ghp_` / `github_pat_` | GitHub Models | `gpt-4o-mini` |
| *(none)* | custom | — (set a base URL) |

Models are fetched live from the provider's `GET /models`, so the picker always
shows what your key can actually use. For `custom`, point `codescout.baseUrl`
(or `--base-url` / `CODESCOUT_BASE_URL`) at any OpenAI-compatible endpoint —
Ollama, LM Studio, or a proxy. Base URLs must be `https://`; plain `http://` is
accepted only for `localhost` / `127.0.0.1` so keys never travel in the clear.

## Architecture

A single TypeScript core (`src/`) is shared by all three frontends:

- `diff-parser.ts` / `line-numbering.ts` — parse and number unified diffs.
- `prompt-builder.ts` — the review contract; untrusted code/imports/docs are
  wrapped in neutralized `CODESCOUT_*` fences.
- `llm-client.ts` — OpenAI-compatible provider with rate-limit backoff and
  cancellation.
- `response-parser.ts` — validates untrusted model JSON (balanced-brace scan).
- `line-correction.ts` — re-anchors findings to real file lines.
- `github-client.ts` / `comment-poster.ts` — PR comments with per-file commit
  stamps and de-duplication.
- `extension/src/` — the VS Code panel, full audit, settings webview.

```text
diff / files  ->  filter + chunk  ->  prompt builder  ->  LLM (JSON)
                                                              |
   comments / panel  <-  validate + line-correct  <-  parse
```

## Development

```bash
npm ci
npm run typecheck
npm test
npm run compile          # typecheck + build (CLI + action)
npm run package          # build + package the extension .vsix
```

CI runs the test/compile matrix on Ubuntu and Windows (Node 20) and packages a
`.vsix` artifact on pushes to `main`.

## Security

CodeScout sends the reviewed diff (and, if enabled, fetched doc text) to the
configured provider — do not enable it where source may not leave the machine.
Keys are only ever read from SecretStorage / env / repository secrets and are
never logged. Model output and fetched web content are treated as untrusted
input: control/bidi characters are stripped, prompt-injection fences are
neutralized, and doc fetches block localhost and cloud-metadata addresses
(SSRF). The extension webview runs under a nonce-based Content-Security-Policy.

## License

Released under the MIT License. See [LICENSE](LICENSE).
