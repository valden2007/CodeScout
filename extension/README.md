# CodeScout — AI code review that takes zero configuration

[![Version](https://img.shields.io/badge/version-1.5.0-blue)](https://github.com/valden2007/CodeScout)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-blueviolet)](https://code.visualstudio.com/)

CodeScout turns any LLM into a review partner inside VS Code. It reviews your
**uncommitted changes**, your **last commit**, or your **entire project** — and
shows findings in a sidebar panel with severity, confidence, proof and
one-click navigation to the exact line. Bring your own key; or run it fully
offline against a local model.

## ⚡ Paste a key. That's the setup.

Click **🔑 Key and model** and paste `oc_sk_…` — CodeScout auto-configures the
**OpenCode Go** provider and selects the **Qwen3.8 Flash** model. No dropdown
dancing, no endpoint URLs. Other key prefixes are detected the same way
(`gsk_` → Groq, `AIza…` → Gemini, `sk-or-` → OpenRouter, `ghp_` → GitHub).
The model list is always fetched live from your provider, so you only see
models your key can actually run.

Prefer local? Set a Base URL like `http://localhost:11434/v1` (Ollama) or
`http://localhost:1234/v1` (LM Studio) — no key needed, and your code never
leaves the machine.

## Key features

### 🔬 RAG Full Project Audit
One click learns the whole repository into `.codescout/context.json`, which
sharpens every later review. Project doc links (`codescout.docLinks`) are
fetched, sanitized and injected per file as section-level RAG within a token
budget. Interrupted audits checkpoint after every file: resume with
**▶️ Continue**, or enable 🤖 autonomous mode and it re-resumes itself with
backoff — surviving restarts with partial results in the panel.

### 🪶 Smart Chunking
Files are reviewed in adaptive chunks with a 50-line overlap and preserved
absolute line numbers. A pre-request token estimate splits heavy chunks *before*
sending; rate-limit errors split the chunk in half and retry recursively. Big
files never get silently skipped, free tiers never get oversized requests.

### ✅ Dedupe, proof and false-positive control
Findings are de-duplicated across chunks and passes. Each finding shows a
confidence badge — **verified by code** vs **model suggestion** — and an
expandable *proof of finding* (trigger condition + execution trace). Click
**👎 False positive** and it disappears permanently: a ±3-line-radius
fingerprint is stored in workspace state, so the next scans stay quiet too.

### 🧭 Everything else
Four review modes (commit / working tree / full audit / custom focus text) ·
findings diff between audits (`🆕 new · ✅ fixed · 🔁 still there`) · live
progress bar with ETA and cancel · multi-pass audits (1–3 rounds hunting for
missed issues) · `.codescout/rules.md` project rules · right-click Explorer
review · clickable findings that open the exact line · built-in planted-bug
self-test · human-readable error cards (401/429/404/timeout/ECONNREFUSED) with
Retry and Settings actions and request deadlines · full RU/EN localization with
a one-click globe switcher · appearance system with themes, density and a
Theme Editor.

## Use it

1. Install CodeScout and open its sidebar icon.
2. Paste a provider key (or point at a local server) — first-run wizard guides you.
3. Hit **🔍 Check last commit (Git Diff)** for a 5-second review, or
   **🔬 Full project audit** to teach CodeScout your project.
4. Click a finding to jump to the line; hide false positives; expand proofs.

All limits (timeouts, pauses, chunks, audit scope, doc budgets, language,
appearance) are settings with sane defaults, editable in the in-panel settings
center — nothing is hardcoded.

## Privacy

Keys live in VS Code SecretStorage and are never logged or echoed; raw error
text is redacted before it reaches logs. `http://` base URLs are allowed only
for `localhost`/`127.0.0.1`; everything else requires `https://`. Webview runs
under a nonce-based CSP, and model/web content is treated as untrusted input
(prompt-injection fences neutralized, SSRF-safe doc fetches).

## Links

Source, CLI and GitHub Action variants, full settings table and architecture:
[github.com/valden2007/CodeScout](https://github.com/valden2007/CodeScout) ·
Issues: [bug report template](https://github.com/valden2007/CodeScout/issues)
(the **ℹ️ About → Report an issue** button inside the extension redacts your key
for you) · License: MIT, see [LICENSE](LICENSE).

## Release notes — 1.5.0

- Marketplace packaging: metadata, categories, icon, full docs.
- New built-in provider: **OpenCode Go** — paste an `oc_sk_…` key and the
  provider + **Qwen3.8 Flash** are configured automatically.
- False-positive suppression with proof of finding and verified/suggested badges.
- User-friendly error cards and hard request deadlines (no more hung scans).
- Fixed settings persistence edge cases; the provider status line is now
  strictly dynamic (mask · provider · actually selected model, or
  “local mode · Ollama”).
