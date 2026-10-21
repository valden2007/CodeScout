# 🕵️ CodeScout — AI code review that takes zero configuration

**VS Code extension · CLI · GitHub Action.** One review core, three interfaces.
Bring your own key — CodeScout never runs a shared proxy and never stores your
credentials on a server.

![CI](https://github.com/valden2007/CodeScout/actions/workflows/ci.yml/badge.svg)

## ⚡ Zero-config start — just paste a key

Open the CodeScout sidebar, click **🔑 Key and model**, and paste your key.
No provider dropdown, no model IDs, no base URLs:

```text
Paste  oc_sk_…   →  CodeScout auto-configures the OpenCode Go provider
                    and selects the Qwen3.8 Flash model. Done — hit scan.
```

Other prefixes are detected the same way: `gsk_` → Groq, `AIza…`/`AQ.` →
Gemini, `sk-or-` → OpenRouter, `ghp_`/`github_pat_` → GitHub Models. The model
list is always fetched live from the provider (`GET /models`), so the picker
only ever shows what your key can actually run.

## Key features

### 🔬 RAG Full Project Audit
One click audits the whole repository and writes `.codescout/context.json`,
which is then mixed into every future review — findings get sharper with
project knowledge. `codescout.docLinks` are fetched (5 s timeout, 24 h cache,
sanitized and fenced as untrusted input) and injected per file as section-level
RAG matched by token overlap. Interrupted audits checkpoint after every file
and resume with **▶️ Continue** — or in 🤖 autonomous mode with an exponential
backoff, unlimited by default.

### 🪶 Smart Chunking
Large files are split into adaptive chunks with a 50-line overlap while
absolute line numbers are preserved. A token-budget pre-estimator splits heavy
requests *before* sending, and rate-limit errors split the chunk in half and
retry recursively — the model never loses the middle of a big file, and free
tiers never get a request too big.

### ✅ Dedupe, proof, and false-positive control
Findings are de-duplicated across chunks, passes and files. Every finding
carries a **proof of finding** (trigger condition + execution trace) and a
confidence class — **verified** (concrete code path) vs **suggested** (model
guess). One click — **👎 False positive** — hides a finding for good: it is
finger-printed (file · severity · category · ±3-line radius) and suppressed
per workspace, so repeated scans stay quiet.

### 💻 Local models, fully offline
Point `codescout.baseUrl` at any OpenAI-compatible endpoint — **Ollama**
(`http://localhost:11434/v1`), **LM Studio** (`http://localhost:1234/v1`) or a
proxy. Local servers run without an API key, and the code never leaves the
machine — `code never leaves the machine` is the actual architecture here, not
a slogan: plain `http://` is accepted only for `localhost`/`127.0.0.1`.

### 🧭 Four review modes
Last commit · uncommitted changes · full project audit · custom review with
your own focus text and scope (all / active file / glob list). Right-click any
file or folder in the Explorer for a one-off review.

### 🌐 Human-readable errors, no hangs
401/403/429/404, connection refused, timeouts and broken JSON are mapped to
titled error cards with an actionable hint and Retry / Open settings buttons.
Every inference call runs under a configurable hard deadline
(`codescout.requestTimeoutSeconds`, default 60 s); model-list probes always
wait 5 s. Raw provider text goes only to the Output channel, redacted.

Also: multi-pass audits (1–3 rounds hunting for what the model missed),
findings diff between runs (`🆕 new · ✅ fixed · 🔁 still there`), project
rules via `.codescout/rules.md`, RU/EN interface and reports, click-to-line
findings, live progress with ETA.

## Install

### VS Code Marketplace
Search **CodeScout** in the Extensions view (`Ctrl/Cmd+Shift+X`) and install —
then paste a key and go. Pre-release builds are available as `.vsix` artifacts
from CI on every push to `main`
(`Extensions → … → Install from VSIX…`).

### From source
```bash
git clone https://github.com/valden2007/CodeScout.git
cd CodeScout
npm ci
npm run package          # builds extension/dist and packages the .vsix
```

### CLI
```bash
npm i -g codescout
codescout scan                 # review uncommitted changes (git diff HEAD)
codescout scan --last-commit   # review the last commit (HEAD~1..HEAD)
codescout scan --base main     # review <branch>...HEAD
codescout scan --dry-run       # show the diff, call no LLM
```
Env keys: `OPENCODE_GO_API_KEY` (oc_sk_…), `GROQ_API_KEY`, `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`, `GITHUB_TOKEN`, or `CODESCOUT_API_KEY` +
`CODESCOUT_BASE_URL` for any OpenAI-compatible endpoint. `.env` in the project
directory is loaded automatically (already git-ignored).

### GitHub Action
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
          provider: opencode
          model: qwen3.8-flash
          api-key: ${{ secrets.OPENCODE_GO_API_KEY }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```
Pin to an immutable tag or commit for production use.

## Providers & models

| Prefix | Provider | Default model |
|---|---|---|
| `oc_sk_` | OpenCode Go | `qwen3.8-flash` |
| `gsk_` | Groq | `llama-3.3-70b-versatile` |
| `AIza` / `AQ.` | Gemini | `gemini-2.5-flash` |
| `sk-or-` | OpenRouter | `meta-llama/llama-3.3-70b-instruct:free` |
| `ghp_` / `github_pat_` | GitHub Models | `gpt-4o-mini` |
| *(none)* | custom (Ollama/LM Studio/proxy) | — (set a base URL) |

## Settings (VS Code)

All settings live under `codescout.` and are editable in the in-panel
settings center (five sections, one save bar). Every limit is a setting with a
sane default — highlights:

| Setting | Default | Meaning |
|---|---|---|
| `codescout.provider` / `model` | `gemini` / live-picked | Auto-detected from the key prefix; override any time. |
| `codescout.baseUrl` | `""` | OpenAI-compatible endpoint for `custom` (Ollama/LM Studio/proxy). |
| `codescout.requestTimeoutSeconds` | `60` | Hard deadline per inference request (10–600 s). |
| `codescout.rateLimitPauses` | `3` | Pauses per file on 429/network errors (ladder 120→300→600 s). |
| `codescout.fileCooldownSeconds` | `5` | Pause between files even when nothing failed; `0` for local models. |
| `codescout.auditPasses` | `1` | Review rounds per file in a full audit (1–3). |
| `codescout.chunkLines` / `maxRequestKTokens` | `800` / `12` | Base chunk size and pre-split token budget. |
| `codescout.autoResume` (+ caps) | `false` | Autonomous re-resume of interrupted audits. |
| `codescout.auditScope` / `maxFiles` / `maxLines` | all / 100 / 0 | Audit scope and cost guards. |
| `codescout.docLinks` / `docMaxKb` / `docBudgetKb` | `[]` / 50 / 24 | RAG over project documentation. |
| `codescout.language` | `ru` | Interface, findings and model answers language (`ru`/`en`), one globe button. |
| `codescout.uiTheme` … `customColors` | VS Code-like | Appearance: themes, density, font size, Theme Editor, shareable JSON palettes. |

## Files CodeScout writes

All audit state lives in a git-ignored `.codescout/` folder at the workspace
root: `context.json` (project knowledge), `history.json` (findings diff),
`audit-progress.json` (checkpoint), `audit-results.json` (partial results that
survive restarts), `docs-cache.json` (24 h RAG cache), `rules.md`, `ignore`.
Suppressed false-positives live in VS Code workspaceState — per project, never
global.

## Privacy & local models

CodeScout can run **fully offline**: point it at a local OpenAI-compatible
server and your code never leaves the machine.

- **Ollama** — set `codescout.baseUrl` to `http://localhost:11434/v1`.
- **LM Studio** — set it to `http://localhost:1234/v1`.
- Plain `http://` is accepted only for `localhost` / `127.0.0.1`; anything
  else must be `https://`, so keys and diffs never travel unencrypted.
- Keys live in VS Code SecretStorage (or env / GitHub Secrets) and are never
  logged, exported or sent anywhere except the provider you configured.
  Error cards, notifications, logs and issue drafts are passed through
  secret-redaction before display.

## Architecture

A single TypeScript core (`src/`) is shared by all three frontends:
`diff-parser` / `line-numbering` → `prompt-builder` (prompt-injection fences
neutralized) → `llm-client` (OpenAI-compatible, backoff, deadlines) →
`response-parser` (balanced-brace scan of untrusted JSON) → `line-correction`
→ panel comments / PR reviews. `error-classifier` turns raw failures into
localized categories; `findingsStore` persists suppressions. ~390 vitest tests,
including e2e that drive the real extension activation against a VS Code stub.

## Development

```bash
npm ci
npm test
npm run compile          # typecheck + build (CLI + action)
npm run package          # build + package the extension .vsix
```

CI runs the test/compile matrix on Ubuntu and Windows (Node 20) and packages a
`.vsix` artifact on pushes to `main`.

## Security

CodeScout sends the reviewed diff (and, if enabled, fetched doc text) to the
configured provider — do not enable it where source may not leave the machine.
Model output and fetched web content are treated as untrusted input: control
and bidi characters are stripped, prompt-injection fences are neutralized, and
doc fetches block localhost and cloud-metadata addresses (SSRF). The extension
webview runs under a nonce-based Content-Security-Policy.

## How to report a bug

Two clicks inside VS Code: open the CodeScout panel → **Settings → About →
“Report an issue”**. The button builds an issue draft with your versions,
provider/model/language, the last scan error and the last 50 Output lines —
API keys are redacted before the browser opens, and the key itself is never
included. From anywhere else, use the [bug template](.github/ISSUE_TEMPLATE/bug_report.md)
or just [open an issue](https://github.com/valden2007/CodeScout/issues);
contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Released under the MIT License. See [LICENSE](LICENSE).
