# Changelog

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
