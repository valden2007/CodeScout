# CodeScout

**CodeScout** is an open-source GitHub Action that reviews pull requests with an LLM and posts actionable inline comments directly on changed lines. It uses a **Bring Your Own Key (BYOK)** model: the repository owner supplies the provider key through GitHub Secrets, so CodeScout does not operate a shared proxy or store user credentials.

> Code review should be fast, explainable, and close to the code. CodeScout turns an LLM review into a reproducible CI step.

## Features

| Capability | MVP behavior |
|---|---|
| Pull request trigger | Reviews opened, reopened, and synchronized pull requests |
| GitHub integration | Reads changed files through the GitHub REST API and posts inline review comments |
| LLM provider | Groq with OpenAI-compatible chat completions and JSON mode |
| Review strategy | One request per reviewable file, with large patches split into bounded chunks |
| Noise control | Skips lock files, generated directories, minified assets, binaries, and source maps |
| Reliability | Three attempts with exponential backoff and a two-second request spacing guard |
| Security model | API keys are accepted only as action inputs and should be passed from repository secrets |
| Testability | Unit tests cover parsing, filtering, chunking, and malformed model responses |

## Quick start

Create a Groq API key and save it as a repository secret named `GROQ_API_KEY`. Then add the following workflow to `.github/workflows/codescout.yml`:

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
          provider: groq
          model: llama-3.3-70b-versatile
          api-key: ${{ secrets.GROQ_API_KEY }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

For a production release, pin the action to an immutable tag or commit rather than `main`.

## CLI usage

The same review core can scan local changes from a terminal. Install the package globally or run it through `npx`:

```bash
npm i -g codescout
codescout scan

# Or without a global install
npx codescout scan
```

The CLI loads `.env` from the current project directory. Create the file with your Groq key, or pass a key explicitly with `--api-key`; the flag takes precedence over `GROQ_API_KEY`.

```bash
cat > .env <<'EOF'
GROQ_API_KEY=gsk_your_key_here
EOF

codescout scan
```

The `.env` file is ignored by Git. The available scan flags are shown below.

| Flag | Purpose |
|---|---|
| `--path <dir>` | Scan a different local Git repository. |
| `--last-commit` | Review the diff from `HEAD~1` instead of uncommitted changes. |
| `--base <branch>` | Review the comparison between `<branch>...HEAD`. |
| `--dry-run` | Read and display the diff without calling Groq. |
| `--api-key <key>` | Override `GROQ_API_KEY` for one run. |

For example, to inspect only the current working tree without making an LLM request, run `codescout scan --dry-run`. The CLI reports a friendly message when there is no change to review.

## Configuration

| Input | Required | Default | Description |
|---|---:|---|---|
| `provider` | No | `groq` | LLM provider identifier. The MVP supports Groq. |
| `model` | No | `llama-3.3-70b-versatile` | Model name accepted by the selected provider. |
| `api-key` | Yes | — | Provider key. Pass it from a GitHub Secret. |
| `max-tokens` | No | `2000` | Reserved configuration for provider-specific completion limits. |
| `fail-on-severity` | No | empty | Reserved configuration for making findings fail the job. |

The action requires `pull-requests: write` permission to publish inline comments. It does not check out repository code because the review is based on the pull request file patches returned by GitHub.

## Architecture

The implementation is deliberately modular. `diff-parser.ts` handles filtering and bounded patch chunks; `prompt-builder.ts` defines the review contract; `llm-client.ts` contains the provider strategy and retry behavior; `response-parser.ts` validates untrusted model output; and `github-client.ts` owns GitHub API calls. `action.ts` is a thin orchestration layer.

```text
pull_request event
        |
        v
GitHub API -> changed files -> filter/chunk -> prompt builder
                                                |
                                                v
                                      Groq JSON response
                                                |
                                                v
                              response parser -> issue validation
                                                |
                                                v
                                      inline PR comments
```

## Local development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The generated `dist/index.js` is intentionally committed because JavaScript GitHub Actions execute the bundled entrypoint from the repository. Before opening a pull request, run all three commands and inspect the generated bundle when source dependencies change.

## Security and limitations

CodeScout sends pull request patches to the configured LLM provider. Do not enable it for repositories whose policy prohibits sending source code to that provider. Never hardcode a provider key or print it to logs. GitHub fork pull requests may not receive repository secrets, and therefore require an explicit trust policy before external contributions can be reviewed automatically.

This is an MVP. It currently supports Groq only, posts one comment per validated finding, and does not yet implement persistent review-thread updates, a configurable severity gate, or a second provider. Those are intentional follow-up milestones rather than hidden behavior.

## Roadmap

The next portfolio milestones are provider adapters for OpenAI-compatible endpoints and Anthropic, review-thread deduplication, configurable severity gates, a dry-run mode, stronger schema validation, and integration tests using mocked GitHub and provider clients.

## License

Released under the MIT License. See [LICENSE](LICENSE).
