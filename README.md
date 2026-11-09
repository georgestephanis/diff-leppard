# Local Code Review (VS Code extension)

AI code review using **your own model server**: vLLM, Ollama, LM Studio, llama.cpp, SGLang, LocalAI, or anything else that speaks the OpenAI `/v1/chat/completions` API. Code goes only to your server (and to GitHub, if you post the review).

- **Review uncommitted changes**, including untracked files, or **staged changes only**. Findings show up in the Problems panel and in a Markdown report.
- **Review a GitHub pull request** by picking from the repo's open PRs or pasting a number or URL.
- **Post the result as a real GitHub PR review.** Comments go inline on the changed lines, with a summary in the review body. You can submit it right away, request changes when there are blocking findings, or create a **pending (draft) review** so you can delete bad comments before submitting it yourself.

## Screenshots

**Reviewing uncommitted changes.** Findings show up as diagnostics, in the Problems panel, and in a report beside your code:

![Review of uncommitted changes with findings in the editor, Problems panel and report](docs/screenshots/local-review.png)

**Posting to a pull request.** The review lands on GitHub with a summary and inline comments on the changed lines. See it live on [demo PR #1](https://github.com/georgestephanis/local-code-review-vscode/pull/1); every finding there came from a self-hosted 27B model via vLLM.

![GitHub PR review posted by the extension, with inline comments](docs/screenshots/github-review.png)

<details>
<summary>More screenshots</summary>

The PR report after posting:

![PR review report with a "Review posted" notification](docs/screenshots/pr-report.png)

Progress while the model is working (cancellable):

![Progress notification during a review](docs/screenshots/progress.png)

The status bar **Review** menu:

![Quick menu](docs/screenshots/menu.png)

Settings:

![Extension settings](docs/screenshots/settings.png)

</details>

## Install

```bash
npm install
npm run package                                   # -> local-code-review.vsix
code --install-extension local-code-review.vsix   # or: Extensions view → … → Install from VSIX
```

For development, open this folder in VS Code and press <kbd>F5</kbd> to launch an Extension Development Host.

## Set up your model server

Open **Settings → Extensions → Local Code Review**, or run `Local Code Review: Open Settings`. Then run **`Local Code Review: Test LLM Connection`**.

| Server | `provider` | `baseUrl` |
| --- | --- | --- |
| vLLM (`vllm serve <model>`) | `openai` | `http://gpu-box:8000/v1` |
| Ollama | `ollama` (recommended) | `http://gpu-box:11434` |
| Ollama via its OpenAI endpoint | `openai` | `http://gpu-box:11434/v1` |
| LM Studio | `openai` | `http://localhost:1234/v1` |
| llama.cpp `llama-server` | `openai` | `http://localhost:8080/v1` |

Leave `model` empty to pick from the server's model list (or run **Select Model**). If your server or proxy needs a key, run **Set LLM API Key**. The key is kept in VS Code's secret storage and sent as `Authorization: Bearer …`. You can also put the key in settings with `"localCodeReview.extraHeaders": {"Authorization": "Bearer <key>"}`. Extra request-body fields (sampling options, `chat_template_kwargs`, …) go in `localCodeReview.extraBody`.

Example `settings.json`:

```jsonc
{
  "localCodeReview.provider": "openai",
  "localCodeReview.baseUrl": "http://gpu-box:8000/v1",
  "localCodeReview.model": "Qwen/Qwen2.5-Coder-32B-Instruct",
  "localCodeReview.maxChunkChars": 60000,   // fits a 32k-context model
  "localCodeReview.concurrency": 2,         // vLLM batches concurrent requests well
  "localCodeReview.jsonMode": "json_schema" // vLLM structured outputs: most reliable JSON
}
```

### Picking a model and sizing the context

The bigger and more code-focused the model, the better the review. A ~3B model mostly produces noise. 14B+ code or instruct models (Qwen2.5-Coder 14B/32B, Qwen3-Coder, Devstral, gpt-oss and so on) give useful results.

Large diffs are split into chunks of `maxChunkChars` characters (about 3.5 characters per token). Size the chunk to the context window minus `maxOutputTokens` minus roughly 1.5k tokens for the prompt:

| Context window | `maxChunkChars` |
| --- | --- |
| 8k | 8000 |
| 16k (default) | 24000 |
| 32k | 60000 |
| 128k | 300000 |

**Ollama users:** Ollama silently truncates prompts longer than its context window, which is small by default. Use `provider: "ollama"` so the extension can set `num_ctx` (`localCodeReview.ollamaNumCtx`), or start Ollama with `OLLAMA_CONTEXT_LENGTH=16384`.

**Reasoning models** (Qwen3, DeepSeek-R1, gpt-oss, …) work too. `<think>` blocks and `reasoning` streams are ignored. However, they can think for thousands of tokens before they answer, which counts against `maxOutputTokens`. With guided JSON (`json_schema`), some never get to the answer at all. To skip the thinking on Qwen3-style models served by vLLM or SGLang, use `localCodeReview.extraBody`:

```jsonc
"localCodeReview.extraBody": { "chat_template_kwargs": { "enable_thinking": false } }
// Ollama: { "think": false }
```

In testing, a 27B Qwen model with thinking off reviewed a small diff in about 30 seconds. It flagged the SQL injection, the off-by-one and the hardcoded secret on the right lines.

## Usage

| Command | What it does |
| --- | --- |
| **Review Uncommitted Changes** | `git diff HEAD` plus untracked files. Also a ✓ button in the Source Control title bar and a **Review** item in the status bar. |
| **Review Staged Changes** | `git diff --cached` |
| **Review GitHub Pull Request…** | Pick an open PR from the `upstream`/`origin` GitHub remote, or type `123`, `owner/repo#123`, or a PR URL |
| **Post Last Review to GitHub** | Post (or re-post) the last PR review: comment, request changes, or pending/draft |
| **Open Last Review Report** | Re-open the Markdown report |
| **Clear Findings** | Remove findings from the Problems panel |
| Select Model / Test LLM Connection / Set LLM API Key | Setup helpers |

Each review writes a Markdown report and opens it in the preview. Local reviews also put findings in the **Problems** panel (critical = error, major = warning, minor = info, nit = hint). A PR review does the same when your local `HEAD` is the PR's head commit. Raw prompts and model output are logged to the **Local Code Review** output channel at Debug level (`Developer: Set Log Level…`).

### Posting reviews to GitHub

By default (`github.postReview: "ask"`), you're asked when a PR review finishes:

- **Post review** submits with `github.reviewEvent`: `COMMENT` (default), or `REQUEST_CHANGES_IF_BLOCKING`, which requests changes when anything is critical or major.
- **Post as draft (pending)** creates a pending review. Open the PR on GitHub, delete or edit the AI's comments, then submit it as yourself. This is the best mode when you're unsure about the model.

Findings on lines that are part of the diff become inline comments. Anything else (file-level notes, lines outside the diff) goes in the review body. If the model is off by a line or two, the comment snaps to the nearest changed line. If GitHub still rejects an inline position, the extension re-posts with everything in the body, so the review isn't lost. GitHub won't let you request changes on your own PR, so in that case it posts as a comment instead.

Turn on `github.suggestionBlocks` to render proposed fixes as one-click ```` ```suggestion ```` blocks. It's off by default because local models often get the exact line range slightly wrong.

**Authentication** uses VS Code's built-in GitHub sign-in (scope `repo`). If your org blocks VS Code's OAuth app, set `github.auth` to `gh-cli` to use `gh auth token` instead. For **GitHub Enterprise Server**, set `github.apiUrl` to `https://your-host/api/v3`. Also set VS Code's `github-enterprise.uri`, or use `gh-cli`.

## Project-specific guidelines

Add `.github/code-review-instructions.md` (configurable via `localCodeReview.instructionsFile`) to a repo and its contents get added to the prompt. For PRs it's read from the base branch. For example:

```md
- This is a WordPress plugin. Flag output that isn't escaped (esc_html, esc_attr, wp_kses), missing nonce checks, and missing capability checks.
- Don't comment on PHPCS formatting; CI enforces it.
```

For personal or global rules, use `localCodeReview.extraInstructions`.

## Other settings

`minimumSeverity` (default `minor`; set it to `nit` to see everything), `extraBody`, `extraHeaders`, `excludeGlobs` (lockfiles, minified and built files are excluded by default), `contextLines`, `includeUntracked`, `temperature`, `maxOutputTokens`, `requestTimeoutSeconds`, `stream`, `jsonMode`.

## Troubleshooting

- **"Could not reach …"**: check `baseUrl`. OpenAI-compatible servers need the `/v1` suffix. Try `curl <baseUrl>/models`.
- **"Model did not return parseable JSON"**: the model ignored the format. Try `jsonMode: json_schema` (vLLM, recent Ollama, LM Studio), a stronger model, or a lower temperature. Check the Debug log for the raw reply.
- **Output cut off**: raise `maxOutputTokens`. The extension salvages complete findings from cut-off JSON, but it logs a warning.
- **Request times out on big diffs**: lower `maxChunkChars` or raise `requestTimeoutSeconds`. Keep `stream` on, because Node aborts non-streamed requests whose response headers take longer than 5 minutes.
- If the server rejects `response_format`, the extension switches to plain-text JSON for the rest of the session.

## Contributing

See [AGENTS.md](AGENTS.md) for the architecture, conventions and test commands. It's written for AI coding agents but works just as well for humans.

## Development

```bash
npm run compile   # or: npm run watch
npm test          # unit tests + mock OpenAI/Ollama server tests (node:test)
```

The code is laid out as follows:

- `src/diff.ts`: diff parsing, line-number annotation and chunking
- `src/llm.ts`: OpenAI-compatible and Ollama clients
- `src/prompt.ts`, `src/parse.ts`: the review prompt and output parsing
- `src/review.ts`: orchestration and mapping findings to diff lines
- `src/github.ts`: GitHub API calls and the review payload
- `src/extension.ts`: VS Code integration

Everything except `extension.ts` is plain Node and can be tested without VS Code.
