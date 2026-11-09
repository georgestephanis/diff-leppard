# AGENTS.md

Guidance for AI coding agents (and humans) working on this repository.

## What this is

A VS Code extension that reviews code with a **self-hosted LLM**. It supports any OpenAI-compatible `/v1/chat/completions` server (vLLM, LM Studio, llama.cpp, SGLang, …) and Ollama's native `/api/chat`. It can review:

- uncommitted changes (`git diff HEAD` plus untracked files)
- staged changes (`git diff --cached`)
- a GitHub pull request

It can also post the result back to the PR as a GitHub review with inline comments.

## Layout

| Path | Role | May import `vscode`? |
| --- | --- | --- |
| `src/types.ts` | Shared types (`FileDiff`, `Finding`, `ReviewResult`, `Logger`) | no |
| `src/diff.ts` | Unified-diff parsing, new-file line annotation, chunking, glob excludes | no |
| `src/llm.ts` | OpenAI-compatible + Ollama clients (streaming SSE / NDJSON, structured-output fallback) | no |
| `src/prompt.ts` | System prompt, JSON schema, per-chunk and synthesis prompts | no |
| `src/parse.ts` | Tolerant JSON extraction from model output (fences, `<think>`, chatter, truncation) | no |
| `src/review.ts` | Orchestration: chunk → model → normalize → map lines onto the diff → dedupe/sort | no |
| `src/git.ts` | `git` subprocess helpers, local diffs, untracked files | no |
| `src/github.ts` | GitHub REST client, PR/remote URL parsing, review payload + posting with fallbacks | no |
| `src/report.ts` | Markdown report rendering | no |
| `src/markdown.ts` | `fence`, severity counts, `sanitizeText` (strips control chars from model output) | no |
| `src/gh.ts` | `gh` CLI lookup, host-scoped GitHub tokens, GitHub remotes (shared by extension and CLI) | no |
| `src/pr.ts` | Load a PR's files + review guidelines (shared by extension and CLI) | no |
| `src/config.ts` | CLI config: defaults < user file < repo `.diff-leppard.json` < `DIFF_LEPPARD_*` env < flags | no |
| `src/format.ts` | Terminal (ANSI) rendering of results | no |
| `src/formats.ts` | SARIF 2.1.0 and reviewdog rdjson output (validated against the official schemas) | no |
| `src/flow.ts` | Shared review flows: `reviewPullRequest` (base-branch repo config → load → size → review), `makeLlm` | no |
| `src/watch.ts` | `diff-leppard watch`: GitHub search for PRs wanting your review, state file, lock, once-per-commit, posting | no |
| `src/cli.ts` | CLI entry (`diff-leppard`, `gh diff-leppard`): arg parsing, posting prompt, exit codes | no |
| `src/extension.ts` | **The only VS Code glue**: commands, settings, progress, diagnostics, auth, quick picks | yes |
| `test/*.test.ts` | `node:test` unit tests + mock OpenAI/Ollama HTTP server tests | no |
| `test/watch.test.ts` | `watch` and `pr` end to end against a mock GitHub API + mock model server | no |
| `test/cli.test.ts` | Config layering and the CLI end-to-end against `test/fixtures/mock-openai.js` | no |
| `dist/` | **Committed** build of `src/` (`npm run build`). The extension, CLI, gh extension, pre-commit hook and Action all run it, so installing from git needs no build. CI fails if it's stale. | – |
| `bin/diff-leppard.js` | npm `bin` shim → `dist/cli.js` | – |
| `gh-diff-leppard/` | `gh` extension wrapper (bash) that runs `dist/cli.js` from the clone, or `diff-leppard` on PATH | – |
| `action.yml`, `action/run.sh` | Composite GitHub Action; runs `dist/cli.js` directly (no install or build) | – |
| `.pre-commit-hooks.yaml` | pre-commit hooks (`diff-leppard` = language node, `diff-leppard-system` = PATH); both run `diff-leppard hook` | – |
| `skills/diff-leppard/SKILL.md`, `.claude-plugin/` | Claude Code skill + plugin/marketplace manifests (`claude plugin validate .`) | – |
| `examples/workflows/` | Copy-paste workflow for other repos | – |
| `.github/workflows/release.yml`, `scripts/release-notes.sh` | Tag → draft release with assets; publish → npm / Open VSX / VS Code Marketplace / gh extension repo / move `vN` tag. See `docs/RELEASING.md` | – |
| `gh-diff-leppard/standalone/` | Templates for the generated `georgestephanis/gh-diff-leppard` repo (wrapper pinned to the release via `npx diff-leppard@X.Y.Z`) | – |
| `plugin/`, `lua/diff-leppard/`, `doc/` | Neovim plugin (Lua, 0.10+): runs the CLI with `-f json`, shows findings as diagnostics + quickfix. Lives at the repo root so plugin managers can install the repo directly | – |
| `test/nvim/test.lua` | Headless Neovim tests with a fake CLI (`nvim --headless -u NONE -l test/nvim/test.lua`, Neovim 0.11+) | – |
| `.github/workflows/ci.yml` | Tests, VSIX packaging, and an action smoke test against the mock server | – |
| `test/vscode/` | Integration test that launches a real VS Code via `@vscode/test-electron` | yes |

Keep the "no `vscode`" modules free of VS Code imports so they stay testable with plain Node.

## Commands

```bash
npm install
npm run compile        # tsc -> out/ (src + tests, for development and tests)
npm run build          # tsc -> dist/ (the committed artifact; commit it with your change)
npm test               # compile + unit tests + mock-server tests (fast, no network)
npm run test:vscode    # launches VS Code; set VSCODE_PATH="/Applications/Visual Studio Code.app/Contents/MacOS/Code" to skip the download
npm run package        # -> diff-leppard.vsix
nvim --headless -u NONE -l test/nvim/test.lua   # Neovim plugin tests
```

Run `npm test` before you finish any change; it also rebuilds `dist/`. **Commit `dist/` together with your `src/` changes**, because CI fails when they differ. Anything imported by `src/cli.ts` must not import `vscode`: the CLI tests spawn `dist/cli.js` in plain Node and fail if it does. CLI settings mirror the extension's `diffLeppard.*` settings; when you add a setting, add it to `package.json`, `readSettings()` in `extension.ts`, `CliSettings`/`defaultSettings()` in `config.ts`, and an `DIFF_LEPPARD_*` env var / action input if CI users need it. Run `npm run test:vscode` when you change `extension.ts` or `package.json` contributions.

## Conventions and invariants

- **No runtime dependencies.** Use Node built-ins and global `fetch`. Dev dependencies are fine.
- **Line numbers are the contract with the model.** `annotateFile` / `chunkDiff` prefix every new-side line with its line number. `mapLines` only accepts findings on lines that are in the diff (added or context lines). It snaps findings up to 3 lines away and otherwise marks them `inline: false`. GitHub rejects inline comments outside the diff, so don't loosen this without updating `postReview`'s fallback.
- **Multi-line comments** (`start_line` to `line`) must stay inside a single hunk.
- **Be tolerant of model output.** Small or local models break JSON in many ways. Add new cases to `parse.ts` and cover them in `test/core.test.ts`. Don't make the parser stricter.
- **Fall back instead of failing.** For example:
  - a server that rejects `response_format` gets plain mode for the rest of the session
  - GitHub 422 on an inline position moves every comment into the review body
  - REQUEST_CHANGES on your own PR becomes COMMENT

  Keep this style.
- **Settings** live under `diffLeppard.*` in `package.json` `contributes.configuration`. Read them only in `readSettings()` in `extension.ts`. Give new settings sensible defaults and a description.
- **Secrets:** the LLM API key is stored in VS Code `SecretStorage` (`Set LLM API Key`). Users may also pass auth through `diffLeppard.extraHeaders`. Never log keys or tokens. Debug logs may contain prompts and model output.
- **Prompt changes** (`src/prompt.ts`) change review quality for every model. Test them against a real model when you can. A ~3B model is not a meaningful quality signal; use a 14B+ coder or instruct model.

## Security model (keep it this way)

- **Repo-controlled input is untrusted.** That covers `.diff-leppard.json`, `.vscode/settings.json` and anything in a PR.
  - Repo config is filtered to `REPO_CONFIG_KEYS` in `config.ts`. Nothing that sets where requests go, credentials, headers, request bodies or GitHub settings.
  - For PR reviews it's read from the base branch.
  - The VS Code extension declares the sensitive settings as `restrictedConfigurations` for untrusted workspaces.
- **Credentials never cross hosts.** GitHub tokens are host-scoped (`githubTokenFor`), and the LLM key only goes to `baseUrl`.
- **File reads stay in the repo.** `readRepoFile` refuses paths that resolve outside the repo; untracked symlinks are skipped.
- **Model output is sanitized** (`sanitizeText`) before it reaches a terminal, a report or GitHub.

## Testing against a real model

The mock server tests cover the protocol. For quality, point the CLI (`node dist/cli.js local …`) at a real server. A demo diff with a SQL injection, an `i <= length` off-by-one, and a hardcoded secret is a good smoke test. A decent model should flag all three on the right lines.

Qwen3-style reasoning models can think for thousands of tokens before they answer. With vLLM/SGLang, `diffLeppard.extraBody: {"chat_template_kwargs": {"enable_thinking": false}}` makes reviews much faster. With Ollama, use `{"think": false}`.

## Don't commit

`out/`, `node_modules/`, `.vscode-test/`, `*.vsix` (but **do** commit `dist/`), personal hostnames, IPs, API keys, or absolute paths from your machine. Screenshots in `docs/` must not show private paths, hostnames, or tokens.
