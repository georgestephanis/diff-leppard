# Changelog

## Unreleased

- **Neovim plugin.** The repo is also a Neovim plugin (0.10+): `:DiffLeppard`, `:DiffLeppardStaged` and `:DiffLeppardPR` run the CLI in the background and show findings as diagnostics and in the quickfix list. It uses the CLI's config, so there are no settings to duplicate. `:checkhealth diff-leppard` checks the setup. Install with lazy.nvim: `{ "georgestephanis/diff-leppard", opts = {} }`.

## 1.2.0 (2026-11-09)

- **`diff-leppard watch`** reviews the PRs that request your review, across every repo you can access, with no per-repo setup. Each one gets a **pending (draft) review** to edit and submit as yourself, once per commit. It only makes outbound calls to GitHub, so the model server never has to be reachable from the internet. Run it with `--once` from cron or a timer, or long-running using the systemd and launchd files in `docs/watch/`. Settings go in a `watch` block in the user config. `--dry-run` shows what it would review.
- **SARIF and reviewdog output:**
  - `-f sarif` writes SARIF 2.1.0 for GitHub code scanning, IDEs and dashboards, with stable fingerprints, security-severity scores and fixes from suggestions.
  - `-f rdjson` writes reviewdog's format, so reviewdog can post findings to GitLab, Bitbucket, Gitea or Gerrit.
  - `-o` can be repeated and picks the format from the file extension.
  - The Action always writes SARIF and exposes it as the `sarif` output.
- **Runaway replies are stopped early.** Models sometimes get stuck emitting the same thing over and over: a run of whitespace in JSON mode, or the same finding again and again. Diff Leppard used to wait for `maxOutputTokens`, which kept the GPU busy for minutes (one real case: 9 minutes at 15 tokens/s, for a 400-token review). It now spots the loop as it streams, hangs up so the server stops generating, keeps one copy of what was repeated, and salvages the findings. If nothing parses, it asks once more and tells the model it was repeating itself. Loops in a reasoning stream are caught too. This needs `stream: true`, which is the default.
- **Release automation (for maintainers):** pushing a `vX.Y.Z` tag tests the code, builds the `.vsix` and CLI tarball, and opens a draft release with notes from this changelog. Publishing the draft publishes to npm, Open VSX and the VS Code Marketplace, syncs the `gh-diff-leppard` repo and moves the `vX` tag. Each of those runs only if its secret is set, and publishing as a pre-release keeps the release quiet. See `docs/RELEASING.md`.

## 1.1.0 (2026-11-09)

- **pre-commit hooks:** `diff-leppard` (installs itself) and `diff-leppard-system` (uses the CLI on PATH). They review staged changes at pre-commit and the pushed commits at pre-push.
- **CLI:**
  - `local --base <ref>` reviews everything since the merge-base with `<ref>`
  - `local --range a..b` (or `a...b`) reviews exact commit ranges
  - `hook` is the pre-commit entry point
- **Claude Code plugin** with a `diff-leppard` skill covering setup, troubleshooting, reviews, and a second-opinion loop for Claude's own changes.
- **The compiled JavaScript is committed in `dist/`.** Installing from git (`npm i -g github:…`, pre-commit, the gh extension) needs no build step, which fixes installs on npm 11. The GitHub Action no longer builds anything before reviewing.
- **Icon** for the VS Code extension and the Claude Code plugin.

## 1.0.1 (2026-11-09)

- **GitHub Action:** shortened the `action.yml` description to fit the GitHub Marketplace's 125-character limit.
- **Docs:** install the CLI from the prebuilt `diff-leppard.tgz` release asset, because npm 11 can't build it from a git URL.

## 1.0.0 (2026-11-09)

The first release of Diff Leppard 🐆: AI code review on your own model server.

### Ways to run it
- **VS Code extension:** reviews uncommitted or staged changes, or a GitHub PR. Findings appear in the editor, the Problems panel and a Markdown report, and can be posted to the PR.
- **CLI (`diff-leppard`):** `pr`, `local` and `staged` reviews; text, Markdown or JSON output; `--fail-on` for CI; `--post`, `--draft` and `--request-changes`.
- **`gh` extension (`gh diff-leppard`):** the CLI as a `gh` command. With no arguments it reviews the PR for the current branch.
- **GitHub Action (`georgestephanis/diff-leppard@v1`):** reviews PRs in any repo with any OpenAI-compatible host. It can run automatically, on a `/review` comment, or by hand, and writes a job summary, annotations and outputs.

### Highlights
- **Model servers:** works with vLLM, Ollama (native API, with `num_ctx`), LM Studio, llama.cpp, SGLang, or any OpenAI-compatible server.
- **Real GitHub reviews:** inline comments on changed lines and a summary, posted as a comment, request-changes or a pending draft. Positions GitHub rejects fall back to the review body, and the review can end with an attribution footer (`github.attribution`).
- **Automatic chunk sizing** from the context window the server reports.
- **Robust output parsing:** handles fences, `<think>` blocks, chatter and truncated JSON.
- **Structured output** (`json_object` / `json_schema`), with an automatic fallback for servers that don't support it.
- **Reasoning models** are supported; `extraBody` can turn thinking off for faster reviews.
- **Per-repo review guidelines** from `.github/code-review-instructions.md`.

### Security
- **Credentials only go where you configured them.** A repo's `.diff-leppard.json` can only set review preferences, and for PRs it's read from the base branch. GitHub tokens are scoped to their host.
- **File reads stay inside the repo,** and model output is stripped of terminal control characters.
- **VS Code:** sensitive settings are restricted in untrusted workspaces.

Licensed under GPL-3.0-or-later.
