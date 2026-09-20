# CodeScout

**AI-powered code review for your local Git changes — right inside VS Code.**

[![Version](https://img.shields.io/badge/version-1.1.2-blue)](https://github.com/valden2007/CodeScout)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-blueviolet)](https://code.visualstudio.com/)

CodeScout turns an LLM into a review partner for your working tree. Open a
workspace, pick a model, and CodeScout reviews your **uncommitted changes**,
your **last commit**, or your **entire project** — then shows findings in a
panel with severity, category, confidence, and one-click navigation to the
exact line. Bring your own key, keep full control over where your code goes,
or run it fully offline against a local model.

> Fast, explainable, and close to the code. No CI needed — it runs in your editor.

![CodeScout panel](media/icon.svg)

## Features

- **Three review modes** — review uncommitted changes, review the last commit, or run a **full project audit** with checkpoints and resume.
- **Live model picker** — models are read from the provider's `GET /models`, so the list always shows what your key can actually use.
- **Zero-config onboarding** — the provider is auto-detected from your key prefix; a sensible default model is picked for you.
- **Clickable findings** — every issue opens the file at the reported line, with severity, category and confidence.
- **Diff between audits** — see what's **new**, what's **fixed**, what's **left**, and what was **not rechecked** since the previous run.
- **Custom review** — describe your own focus ("check error handling in network calls") and scope.
- **RAG from your docs** — CodeScout can pull project documentation URLs into the prompt, with a section-aware token budget.
- **Autonomous mode** — an interrupted audit auto-resumes with backoff (rate-limit friendly), with limits you control.
- **RU / EN interface** — the whole panel and settings center are localized; model answers follow the same language.
- **Extensible rules** — drop a `.codescout/rules.md` in your project to steer the reviewer.
- **Full theming** — dark/light/auto plus a deep custom theme editor (colors, geometry, typography) and a compact UI.

## Installation

CodeScout ships as a `.vsix` and is installed manually:

1. Open VS Code.
2. Open the **Extensions** view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Open the **…** menu (top-right) → **Install from VSIX…**.
4. Select the `codescout-vscode-*.vsix` file.
5. Reload the window if prompted.

You should see a **CodeScout** icon in the Activity Bar. Click it to open the
review panel.

> The extension is distributed outside the Marketplace for now. Grab the latest
> `.vsix` from the [releases](https://github.com/valden2007/CodeScout/releases)
> page. A Marketplace listing is planned.

## Quick start

Five steps from a fresh install:

1. **Add a key.** Click **CodeScout: set API key** in the Command Palette
   (`Ctrl+Shift+P` / `Cmd+Shift+P`), paste your provider key, and the provider
   is detected automatically. The key is stored in VS Code **SecretStorage** —
   never echoed, never logged.
2. **Choose a model.** In the panel, click **Key and model** and pick a model
   from the live list. (Changing the model only swaps the model — re-run a scan
   with the **Re-run with this model** button.)
3. **Review one file.** Right-click a file in the Explorer → **CodeScout:
   проверить**, or open a file and run **CodeScout: review last commit**.
4. **Read the report.** Findings appear in the panel with severity, category
   and confidence. Click any finding to jump to the line. A full report is also
   dumped to the **Output** channel.
5. **Run a full audit.** Press **Full project audit** to review every source
   file (respecting ignore lists and limits). Interrupted? Resume from the
   checkpoint or let autonomous mode catch up.

Still unsure? Run **CodeScout: test on sample** — it reviews a built-in file
with planted bugs to verify your model is set up correctly.

## Privacy

CodeScout is a **Bring Your Own Key** tool. What happens with your data is up
to you:

- **What is sent:** the reviewed diff/patches (and, if you enable docs RAG, the
  text of documentation URLs you listed). They are sent only to the provider
  you configured.
- **What is never sent:** your API key. It lives in VS Code SecretStorage and
  is used only in the request to the provider you chose.
- **Workspace trust:** if a custom `baseUrl` comes from **workspace settings**,
  CodeScout asks you to confirm before sending anything — and refuses outright
  in an **untrusted workspace**. A `baseUrl` from your user settings works as
  before.
- **How to disable:** never add a key, and set the provider to a local model —
  nothing is sent anywhere.
- **Local state:** audit state lives in a git-ignored `.codescout/` folder at
  the workspace root (project context, history, checkpoints, doc cache) and is
  never committed.

## Local mode (offline)

Run CodeScout **fully offline** by pointing it at a local OpenAI-compatible
server. Your code never leaves the machine.

| Server | Set `codescout.baseUrl` to |
|---|---|
| **Ollama** | `http://localhost:11434/v1` |
| **LM Studio** | `http://localhost:1234/v1` |

- Models are fetched live from `GET /models`, so local model names work as-is.
- Plain `http://` is accepted **only** for `localhost` / `127.0.0.1`; everything
  else must be `https://` — so keys and diffs never travel unencrypted.
- Set the provider to `custom` in Settings → **Key and model → Base URL**.
- Tip: set `codescout.fileCooldownSeconds` to `0` if you're rate-limited by a
  local server, or lower `codescout.chunkLines` / `maxRequestKTokens` for weak
  models.

## Configuration

Open the **settings center** from the panel (gear icon) or run
**CodeScout: openSettingsPage**. Key settings:

| Setting | Default | Meaning |
|---|---|---|
| `codescout.apiKey` | — | Provider key (SecretStorage, masked). |
| `codescout.provider` | `gemini` | `gemini`, `groq`, `openrouter`, `github`, `custom`. |
| `codescout.model` | `gemini-2.5-flash` | Model for the provider. |
| `codescout.baseUrl` | `""` | OpenAI-compatible base URL for `custom` (Ollama/LM Studio/proxy). |
| `codescout.language` | `ru` | Interface + report + answer language (`ru` / `en`). |
| `codescout.auditScope` | `""` | Comma-separated globs limiting the full audit. |
| `codescout.auditPasses` | `1` | Review rounds per file (1–3); round 2+ hunts for misses. |
| `codescout.maxFiles` | `100` | Max files per full audit. |
| `codescout.maxLines` | `0` | `0` = no limit (long files are chunked); `N>0` skips longer files. |
| `codescout.docLinks` | `[]` | Project documentation URLs fetched into the audit prompt (RAG). |
| `codescout.docMaxKb` / `docMaxLinks` | `50` / `5` | Doc size / count limits for RAG. |
| `codescout.autoResume` | `false` | Auto-resume an interrupted audit with backoff. |
| `codescout.autoResumeMaxAttempts` / `MaxMinutes` | `0` / `0` | Autonomous-mode caps; `0` = unlimited. |
| `codescout.rateLimitPauses` | `3` | How many rate-limit pauses per file before skipping. |
| `codescout.fileCooldownSeconds` | `5` | Pause between files even without errors. |
| `codescout.uiTheme` | `auto` | `auto` / `dark` / `light` / `custom`. |
| `codescout.findingsSort` | `severity` | How findings are ordered in the report. |
| `codescout.reportTheme` | `auto` | Export theme of the report preview. |

## Troubleshooting

**“API key not found for gemini”** — run **CodeScout: set API key**; the key
is stored in SecretStorage and survives reloads. If you use `codescout.apiKey`
as a setting instead, note it is stored masked.

**“Model too weak / sample found 1 of 3”** — pick a stronger model with
**Key and model** (the live list reflects what your key allows), then press
**Re-run with this model**.

**404 on the model endpoint** — the model name is not available on the
provider. Use **Key and model** to choose a valid one.

**Audit shows 0 files or skipped many** — check `codescout.maxFiles`,
`codescout.maxLines`, and your ignore lists (`.gitignore` + `.codescout/ignore`).
`codescout.auditScope` filters which files are walked.

**Rate-limit errors keep appearing** — increase `codescout.rateLimitPauses`
or enable `codescout.autoResume` so an interrupted audit catches up; lower
`codescout.chunkLines` / `maxRequestKTokens` for long files on weak models.

**Nothing is reviewed (silent)** — make sure you opened a Git repository
folder, have a key set, and use **Review last commit** / **Review uncommitted
changes** with actual changes present. If a scan was stopped, a new scan
always starts fresh.

**Report says “not rechecked” (⏳)** — files skipped by rate-limit/errors were
not re-checked in the current run; use **Continue** to re-check them before
treating old findings as gone.

**UI looks broken after an update** — reload the window (`Ctrl+Shift+P` →
**Developer: Reload Window**).

Still stuck? Use **Settings → About → Report an issue** — it pre-fills an
issue with your versions and diagnostics (keys are redacted automatically).

## Commands

| Command | What it does |
|---|---|
| `CodeScout: review last commit` | Review `HEAD~1..HEAD`. |
| `CodeScout: review uncommitted changes` | Review the working tree (`git diff HEAD`). |
| `CodeScout: full project audit` | Review every source file (scope/limits respected), with checkpoints. |
| `CodeScout: resume audit` | Continue the last audit from its checkpoint. |
| `CodeScout: restart audit` | Clear the checkpoint and start a fresh audit. |
| `CodeScout: custom review` | Review with your own focus text and scope. |
| `CodeScout: проверить` | Right-click a file/folder in Explorer for a one-off review. |
| `CodeScout: test on sample` | Verify the model against built-in planted bugs. |
| `CodeScout: stop scan` | Cancel the running scan (and any auto-resume). |
| `CodeScout: set/clear API key` | Store or remove the key in SecretStorage. |
| `CodeScout: choose model` | Swap the model from the provider's live `/models` list. |
| `CodeScout: openSettingsPage` | Open the in-panel settings center. |

## Files CodeScout writes

All audit state lives in a git-ignored `.codescout/` folder at the workspace
root — nothing is committed:

| File | Purpose |
|---|---|
| `.codescout/context.json` | Project summary from the last full audit. |
| `.codescout/history.json` | Previous findings for the `🆕/✅/⏳/🔁` diff. |
| `.codescout/audit-progress.json` | Checkpoint for resume / auto-resume. |
| `.codescout/audit-results.json` | Last partial/full results, restored on reload. |
| `.codescout/docs-cache.json` | 24h cache of fetched documentation text. |
| `.codescout/rules.md` | Your project rules, mixed into every prompt. |
| `.codescout/ignore` | Extra ignore patterns for the audit. |

## Requirements

- VS Code `^1.85.0` or newer.
- A Git repository in the opened workspace.
- A provider API key (Gemini, Groq, OpenRouter, GitHub Models, or any
  OpenAI-compatible endpoint), **or** a local model server (Ollama / LM Studio).

## Release notes

See [CHANGELOG.md](CHANGELOG.md) for the full history. CodeScout also ships a
GitHub Action and a CLI — the action instruction lives in the
[project README](https://github.com/valden2007/CodeScout).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Report
bugs through the panel (**Settings → About → Report an issue**) or
[open an issue](https://github.com/valden2007/CodeScout/issues).

## License

MIT. See [LICENSE](LICENSE).
