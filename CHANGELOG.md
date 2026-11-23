# Changelog

## Unreleased

- **More context per review, sized from the model's context window.** Each request now carries more than the diff hunks, within one budget, so a bigger context window buys more context and a small one degrades to plain hunks. See [What the model sees](README.md#what-the-model-sees).
  - Changed files are shown whole when they fit (`fullFileMaxChars`), otherwise with hunks widened by as many lines as fit (#30).
  - Related code: names the change uses are searched for elsewhere in the repo, and folders it names are listed with their README and last commit (`relatedMaxChars`, #31).
  - `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md` or `CONTRIBUTING.md` is used as review guidelines when `instructionsFile` doesn't exist, trimmed to the sections that matter (`instructionsFallback`, `maxInstructionsChars`, #34).
  - Optionally, the change description's claims are checked against the diff (`checkDescription`, off by default, #33). `local --range` and `--base` use the commit messages as the description; `--title` and `--description` set them explicitly.
- **Verification pass** (`verifyFindings`, default `critical-major`, `--verify`): each serious finding gets a second request that must confirm it and quote the code. Rejected findings are dropped and listed as `rejectedFindings` in JSON (#32). Findings on files outside the change, or naming no file, are checked too (against that file read from the reviewed version plus the change, or against the whole change); one with nothing to check against is lowered one step.
- **Experimental `--agentic` mode**: the model may call read-only `read_file`, `grep` and `list_dir` tools, confined to the repo at the reviewed commit, with a call and output budget. Falls back to a normal review when the server doesn't do tool calling. In testing with a 27B model it found nothing more and was slower, so it stays off (#35).
- **Evaluation set:** `npm run eval` runs small cases with known answers and traps and reports recall, false positives and time (#29). See `eval/README.md`.
- `--no-context` reviews hunks only, as before.
- **Docs:** a [Platform differences](README.md#platform-differences) section covers what each surface (CLI, MCP, VS Code, Action, watch, Neovim) gets and which settings reach it, including how to set `DIFF_LEPPARD_*` variables in the Action's step `env:` for settings without an input.
- **Platform fixes** (#42):
  - **watch** no longer applies the starting directory's `.diff-leppard.json` to other repos' PRs, and warns about `agentic` once instead of on every PR.
  - **GitHub Action:** inputs left empty no longer override the repo's `.diff-leppard.json` or `DIFF_LEPPARD_*` variables in the step's `env:`. `min-severity`, `provider` and `attribution` now default to empty (same behaviour unless the repo sets `minimumSeverity`). New `verify-findings`, `check-description` and `no-context` inputs. The example workflow has an optional checkout of the PR head, for related code and `agentic`.
  - **VS Code** applies a repo's `.diff-leppard.json` (the same keys as the CLI; for PRs from the base branch), under workspace settings. New `agentic` and `maxToolCalls` settings. Untrusted workspaces can't change settings that add load on your server.
  - **MCP:** `review_local_changes` takes `title` and `description`.
  - **Neovim:** `minimum_severity` is passed to the CLI (default: the CLI's setting), and `:DiffLeppardPR` keeps findings out of buffers when the PR's head isn't checked out. PR results in JSON now include `headSha`.
- **watch can review from local clones** (`watch.clones`, #44): map `owner/repo` (or `owner/*`) to a clone, and watch fetches each PR's commits into it (objects only) so related code is searched and `agentic` works.
- **VS Code local reviews know what the change is for** (#45): the message in the Source Control commit box is used as the title and description (`diffLeppard.localDescription`: `commitMessage`, `ask` or `off`), so `checkDescription` works there too.
- **Verification of findings that name no changed file** (#40): the files and hunks the finding mentions are shown first and get more room, at most 8 files are shown, and the total stays within the request size. A finding on a changed file the review skipped as too large is labelled as changed, not as outside the change.
- Small cleanups (#46): `eval --keep` prints where it kept each test repo; setting both `DIFF_LEPPARD_MIN_SEVERITY` and `DIFF_LEPPARD_MINIMUM_SEVERITY` (or the two timeout names) warns; an unused `loadPullRequest` parameter is gone.
- **Reviews are slower by default:** requests are bigger, and each critical or major finding gets one more request. In testing with a 27B model, reviews took about twice as long per range (rough: one 1.3.0 run, on a different set of ranges), and false critical/major findings went from 5 in a 1.3.0 run (3–6 per run on the new defaults before findings outside the change were verified) to 0 in each of 3 runs. `--verify off` and `--no-context` trade that back for speed.

## 1.3.0 (2026-11-10)

1.2.0 was a quiet pre-release, so this is the first full release with its changes too: `diff-leppard watch`, SARIF and reviewdog output, and stopping runaway replies early. See [1.2.0 in the changelog](https://github.com/georgestephanis/diff-leppard/blob/main/CHANGELOG.md#120-2026-11-09).

- **MCP server: `diff-leppard mcp`.** Agents such as Cursor, Copilot, Claude Desktop and Claude Code can ask your model for a review with three tools: `review_local_changes`, `review_pull_request` and `check_model_server`. It is read-only (it never posts to GitHub), runs reviews one at a time with progress and cancellation, and has no dependencies.
- **Org rollout guide** ([docs/ORG-ROLLOUT.md](docs/ORG-ROLLOUT.md)): org secrets, a workflow template, a new [reusable workflow](examples/workflows/diff-leppard-reusable.yml) that keeps settings in one place, and workflows required by org rulesets, with the fork-PR and secret caveats.
- **Git refs that look like options are rejected** (`--base`, `--range`), since agents can now supply them.
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
