/**
 * Command-line interface: review GitHub PRs or local changes with a self-hosted LLM.
 *
 *   diff-leppard pr 123 --post
 *   diff-leppard local
 *   gh diff-leppard 123          (via the gh extension in ./gh-diff-leppard)
 */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as readline from 'readline/promises';
import { parseArgs } from 'util';
import { CliSettings, loadConfig, REPO_CONFIG_FILE, userConfigPath } from './config';
import { makeExcluder } from './diff';
import { renderTerminal } from './format';
import { getLocalDiff, getRemotes, getRepoRoot } from './git';
import { GitHubClient, parsePrReference, parseRemoteUrl, postReview, RepoRef, ReviewEventSetting, webHostFromApiUrl } from './github';
import { LlmClient } from './llm';
import { loadPullRequest } from './pr';
import { renderMarkdownReport } from './report';
import { CancelledError, runReview } from './review';
import { Logger, ReviewResult, Severity, SEVERITIES, severityRank } from './types';

const HELP = `diff-leppard — AI code review with your own LLM server (vLLM, Ollama, LM Studio, llama.cpp, …)

Usage:
  diff-leppard pr [<number> | <url> | <owner/repo#number>] [options]
      Review a GitHub pull request. With no argument, reviews the PR for the current branch.
  diff-leppard local [--staged] [options]
      Review uncommitted changes (or only staged changes) in the current git repo.
  diff-leppard models          List models on the configured server
  diff-leppard test            Check the server connection with a tiny request
  diff-leppard config          Show the effective configuration and where it came from

  As a gh extension:  gh diff-leppard [<pr>] [options]   (same options; "gh diff-leppard local" for local changes)

Posting (PR reviews):
      --post                Post the review as a comment review
      --request-changes     Post; request changes if there are critical/major findings
      --draft               Create a pending (draft) review you can edit and submit on GitHub
      --no-prompt           Never ask whether to post (default: ask when running in a terminal)

Output:
  -f, --format <fmt>        text | markdown | json   (default: text in a terminal, markdown when piped)
  -o, --output <file>       Also write the report to a file (.json for JSON, otherwise Markdown)
      --fail-on <severity>  Exit with code 1 if any finding is at or above this severity (for CI)
  -q, --quiet               No progress output
  -v, --verbose             Log requests and decisions to stderr (DIFF_LEPPARD_DEBUG=1 adds prompts and raw model output)

Model server (override config files):
      --base-url <url>      e.g. http://gpu-box:8000/v1 (vLLM) or http://gpu-box:11434 (with --provider ollama)
  -m, --model <name>
      --provider <p>        openai | ollama
      --api-key <key>       (or DIFF_LEPPARD_API_KEY)
      --header <K: V>       Extra request header (repeatable)
      --extra-body <json>   Extra request body fields, e.g. '{"chat_template_kwargs":{"enable_thinking":false}}'
      --json-mode <mode>    json_object | json_schema | none
      --no-stream
      --max-chunk-chars <n>
      --concurrency <n>
      --min-severity <s>    critical | major | minor | nit

Other:
  -R, --repo <owner/repo>   Repository for a bare PR number (default: gh's default repo / git remotes)
  -C, --cwd <dir>           Run as if started in <dir>
      --staged              (local) only staged changes
  -h, --help
      --version

Config files (JSON, same keys as the VS Code settings without the "diffLeppard." prefix):
  ${userConfigPath()}   (user; may contain apiKey)
  <repo>/${REPO_CONFIG_FILE}   (per repo; must not contain apiKey)
Environment: DIFF_LEPPARD_BASE_URL, DIFF_LEPPARD_MODEL, DIFF_LEPPARD_PROVIDER, DIFF_LEPPARD_API_KEY, DIFF_LEPPARD_EXTRA_BODY, DIFF_LEPPARD_EXTRA_HEADERS (JSON),
  DIFF_LEPPARD_JSON_MODE, DIFF_LEPPARD_MIN_SEVERITY, DIFF_LEPPARD_MAX_CHUNK_CHARS, DIFF_LEPPARD_MAX_OUTPUT_TOKENS, DIFF_LEPPARD_TIMEOUT_SECONDS, DIFF_LEPPARD_CONCURRENCY,
  DIFF_LEPPARD_EXTRA_INSTRUCTIONS, DIFF_LEPPARD_GITHUB_API_URL, DIFF_LEPPARD_CONFIG. GitHub token: GH_TOKEN / GITHUB_TOKEN, else \`gh auth token\`.

Exit codes: 0 success · 1 findings at/above --fail-on · 2 error · 130 cancelled
`;

class UsageError extends Error {}

const isTTY = (s: NodeJS.WriteStream) => !!s.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim()),
    ),
  );
}

async function gh(args: string[], cwd?: string): Promise<string> {
  let lastErr: Error | undefined;
  for (const bin of [process.env.GH_PATH || 'gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
    try {
      return await run(bin, args, cwd);
    } catch (e) {
      lastErr = e as Error;
      if (!/ENOENT/.test(lastErr.message)) throw lastErr;
    }
  }
  throw new Error(`GitHub CLI (gh) not found: ${lastErr?.message}`);
}

async function githubToken(host: string): Promise<string> {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || (host !== 'github.com' ? process.env.GH_ENTERPRISE_TOKEN : undefined);
  if (env) return env;
  try {
    const t = await gh(['auth', 'token', '--hostname', host]);
    if (t) return t;
  } catch {
    /* fall through */
  }
  throw new Error(`No GitHub token. Set GH_TOKEN, or run "gh auth login --hostname ${host}".`);
}

async function defaultRepo(cwd: string, root: string | undefined, host: string): Promise<RepoRef | undefined> {
  try {
    const nwo = await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd);
    const m = /^([^/]+)\/([^/]+)$/.exec(nwo);
    if (m) return { owner: m[1], repo: m[2] };
  } catch {
    /* no gh, or not a GitHub repo for gh */
  }
  if (!root) return undefined;
  const remotes = await getRemotes(root);
  const rank = (n: string) => (n === 'upstream' ? 0 : n === 'origin' ? 1 : 2);
  for (const r of remotes.sort((a, b) => rank(a.name) - rank(b.name))) {
    const ref = parseRemoteUrl(r.url, host);
    if (ref) return ref;
  }
  return undefined;
}

function makeLogger(verbose: boolean, quiet: boolean, progress: Progress): Logger {
  const debug = !!process.env.DIFF_LEPPARD_DEBUG;
  const write = (prefix: string, m: string) => {
    progress.clear();
    process.stderr.write(`${prefix}${m}\n`);
  };
  return {
    info: (m) => verbose && write('· ', m),
    warn: (m) => !quiet && write('warning: ', m),
    error: (m) => write('error: ', m),
    debug: (m) => debug && write('debug: ', m),
  };
}

class Progress {
  private last = '';
  private lastAt = 0;
  private live = false;
  private frame = 0;
  constructor(private readonly enabled: boolean, private readonly tty: boolean) {}
  update(msg: string): void {
    if (!this.enabled) return;
    if (this.tty) {
      const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[this.frame++ % 10];
      const width = (process.stderr.columns || 100) - 4;
      process.stderr.write(`\r\x1b[K${spin} ${msg.slice(0, width)}`);
      this.live = true;
    } else {
      const now = Date.now();
      const key = msg.replace(/\d+ chars/, '');
      if (key !== this.last || now - this.lastAt > 15000) {
        process.stderr.write(`${msg}\n`);
        this.last = key;
        this.lastAt = now;
      }
    }
  }
  clear(): void {
    if (this.live) {
      process.stderr.write('\r\x1b[K');
      this.live = false;
    }
  }
}

async function makeLlm(s: CliSettings, log: Logger): Promise<LlmClient> {
  const cfg = { ...(await llmBase(s)), model: s.model };
  if (!cfg.model) {
    const models = await new LlmClient(cfg, log).listModels();
    if (models.length !== 1) {
      throw new UsageError(
        models.length
          ? `No model configured and the server has ${models.length}: ${models.join(', ')}. Pass --model or set "model" in ${userConfigPath()}.`
          : `The server at ${cfg.baseUrl} reported no models.`,
      );
    }
    cfg.model = models[0];
    log.info(`Using the server's only model: ${cfg.model}`);
  }
  return new LlmClient(cfg, log);
}

async function askToPost(label: string): Promise<ReviewEventSetting | undefined> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const a = (await rl.question(`Post this review to ${label}? [y]es / [d]raft / [r]equest changes / [N]o: `)).trim().toLowerCase();
    if (a === 'y' || a === 'yes') return 'COMMENT';
    if (a === 'd' || a === 'draft') return 'PENDING';
    if (a === 'r') return 'REQUEST_CHANGES_IF_BLOCKING';
    return undefined;
  } finally {
    rl.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      post: { type: 'boolean' },
      'request-changes': { type: 'boolean' },
      draft: { type: 'boolean' },
      'no-prompt': { type: 'boolean' },
      format: { type: 'string', short: 'f' },
      output: { type: 'string', short: 'o' },
      'fail-on': { type: 'string' },
      quiet: { type: 'boolean', short: 'q' },
      verbose: { type: 'boolean', short: 'v' },
      'base-url': { type: 'string' },
      model: { type: 'string', short: 'm' },
      provider: { type: 'string' },
      'api-key': { type: 'string' },
      header: { type: 'string', multiple: true },
      'extra-body': { type: 'string' },
      'json-mode': { type: 'string' },
      'no-stream': { type: 'boolean' },
      'max-chunk-chars': { type: 'string' },
      concurrency: { type: 'string' },
      'min-severity': { type: 'string' },
      repo: { type: 'string', short: 'R' },
      cwd: { type: 'string', short: 'C' },
      staged: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });

  if (o.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (o.version) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    process.stdout.write(`${require('../../package.json').version}\n`);
    return 0;
  }

  let command = positionals[0] ?? 'pr';
  let rest = positionals.slice(1);
  if (!['pr', 'local', 'staged', 'models', 'test', 'config', 'help'].includes(command)) {
    // `diff-leppard 123` / `gh diff-leppard https://…` → pr
    command = 'pr';
    rest = positionals;
  }
  if (command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === 'staged') {
    command = 'local';
    o.staged = true;
  }

  const cwd = path.resolve(o.cwd ?? process.cwd());
  const root = await getRepoRoot(cwd);

  const flags: Record<string, unknown> = {
    baseUrl: o['base-url'],
    model: o.model,
    provider: o.provider,
    apiKey: o['api-key'],
    jsonMode: o['json-mode'],
    stream: o['no-stream'] ? false : undefined,
    maxChunkChars: o['max-chunk-chars'] ? Number(o['max-chunk-chars']) : undefined,
    concurrency: o.concurrency ? Number(o.concurrency) : undefined,
    minimumSeverity: o['min-severity'],
  };
  if (o['extra-body']) {
    try {
      flags.extraBody = JSON.parse(o['extra-body']);
    } catch {
      throw new UsageError('--extra-body must be JSON');
    }
  }
  const { settings: s, sources } = await loadConfig(root, flags);
  if (o.header?.length) {
    s.extraHeaders = { ...s.extraHeaders };
    for (const h of o.header) {
      const i = h.indexOf(':');
      if (i < 1) throw new UsageError(`--header must look like "Name: value" (got "${h}")`);
      s.extraHeaders[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
  }

  const progress = new Progress(!o.quiet, isTTY(process.stderr));
  const log = makeLogger(!!o.verbose, !!o.quiet, progress);
  for (const src of sources) log.info(`config: ${src}`);

  if (command === 'config') {
    const redacted = JSON.parse(JSON.stringify(s));
    if (redacted.apiKey) redacted.apiKey = '***';
    for (const k of Object.keys(redacted.extraHeaders ?? {})) if (/auth|key|token/i.test(k)) redacted.extraHeaders[k] = '***';
    process.stdout.write(`# sources: ${sources.length ? sources.join(', ') : '(defaults only)'}\n${JSON.stringify(redacted, null, 2)}\n`);
    return 0;
  }

  if (command === 'models') {
    const models = await new LlmClient({ ...(await llmBase(s)), model: s.model }, log).listModels();
    process.stdout.write(models.join('\n') + '\n');
    return 0;
  }

  const ac = new AbortController();
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    progress.clear();
    process.stderr.write('Cancelling… (Ctrl-C again to force)\n');
    ac.abort();
  });

  if (command === 'test') {
    progress.update(`Connecting to ${s.baseUrl}…`);
    const llm = await makeLlm(s, log);
    const t0 = Date.now();
    const r = await llm.chat(
      [
        { role: 'system', content: 'You are a health check. Respond with JSON only.' },
        { role: 'user', content: 'Respond with exactly {"ok": true}' },
      ],
      { signal: ac.signal, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
    );
    progress.clear();
    process.stdout.write(`✓ ${llm.model} at ${s.baseUrl} replied in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${r.content.trim().slice(0, 200)}\n`);
    return 0;
  }

  const failOn = o['fail-on'] as Severity | undefined;
  if (failOn && !SEVERITIES.includes(failOn)) throw new UsageError(`--fail-on must be one of ${SEVERITIES.join(', ')}`);
  const format = o.format ?? (isTTY(process.stdout) ? 'text' : 'markdown');
  if (!['text', 'markdown', 'json'].includes(format)) throw new UsageError('--format must be text, markdown or json');
  const exclude = makeExcluder(s.excludeGlobs);
  const reviewOpts = {
    maxChunkChars: s.maxChunkChars,
    concurrency: s.concurrency,
    minimumSeverity: s.minimumSeverity,
    exclude,
    log,
    signal: ac.signal,
    onProgress: (m: string) => progress.update(m),
  };

  let result: ReviewResult;
  let title: string;
  let markdown: () => string;
  let posting: { client: GitHubClient; repo: RepoRef; pr: Awaited<ReturnType<typeof loadPullRequest>>['pr']; label: string } | undefined;

  try {
    if (command === 'local') {
      if (!root) throw new UsageError(`${cwd} is not inside a git repository`);
      progress.update('Collecting diff…');
      const diff = await getLocalDiff(root, {
        stagedOnly: !!o.staged,
        contextLines: s.contextLines,
        includeUntracked: s.includeUntracked,
        maxUntrackedBytes: 256 * 1024,
        exclude,
      });
      const what = o.staged ? 'staged changes' : 'uncommitted changes';
      if (!diff.files.length) {
        progress.clear();
        process.stderr.write(`No ${what} in ${path.basename(root)}.\n`);
        return 0;
      }
      let repoInstructions: string | undefined;
      if (s.instructionsFile) repoInstructions = await fs.readFile(path.join(root, s.instructionsFile), 'utf8').catch(() => undefined);
      const llm = await makeLlm(s, log);
      result = await runReview(diff.files, {
        ...reviewOpts,
        llm,
        context: { extraInstructions: s.extraInstructions, repoInstructions: repoInstructions?.slice(0, 8000) },
        preSkipped: diff.skipped,
      });
      title = `Review of ${what} — ${path.basename(root)}`;
      markdown = () => renderMarkdownReport(result, { title, source: `${o.staged ? 'Staged' : 'Uncommitted'} changes in **${path.basename(root)}**` });
    } else {
      const host = webHostFromApiUrl(s.github.apiUrl);
      const arg = rest[0];
      let ref: { repo: RepoRef; number: number } | undefined;
      const explicitRepo = o.repo ? /^([^/\s]+)\/([^/\s]+)$/.exec(o.repo) : undefined;
      if (o.repo && !explicitRepo) throw new UsageError('--repo must look like owner/repo');
      const fallbackRepo = explicitRepo ? { owner: explicitRepo[1], repo: explicitRepo[2] } : undefined;
      if (arg) {
        ref = parsePrReference(arg, host, fallbackRepo ?? (/^#?\d+$/.test(arg) ? await defaultRepo(cwd, root, host) : undefined));
        if (!ref) throw new UsageError(`Can't tell which PR "${arg}" is. Use a number inside a GitHub repo checkout, owner/repo#123, a PR URL, or --repo.`);
      } else {
        progress.update('Finding the PR for the current branch…');
        const url = await gh(['pr', 'view', '--json', 'url', '-q', '.url'], cwd).catch(() => '');
        ref = url ? parsePrReference(url, host) : undefined;
        if (!ref) throw new UsageError('No PR given and no PR found for the current branch. Pass a PR number or URL.');
      }
      const label = `${ref.repo.owner}/${ref.repo.repo}#${ref.number}`;
      progress.update(`Fetching ${label}…`);
      const client = new GitHubClient(s.github.apiUrl, await githubToken(host), log);
      const loaded = await loadPullRequest(client, ref.repo, ref.number, s.instructionsFile, log);
      const llm = await makeLlm(s, log);
      result = await runReview(loaded.files, {
        ...reviewOpts,
        llm,
        context: { title: loaded.pr.title, description: loaded.pr.body, extraInstructions: s.extraInstructions, repoInstructions: loaded.repoInstructions },
        preSkipped: loaded.skipped,
      });
      const pr = loaded.pr;
      title = `Review of ${label}: ${pr.title}`;
      markdown = () =>
        renderMarkdownReport(result, {
          title,
          source: `[${label}](${pr.htmlUrl}) by @${pr.author} (${pr.headRef} → ${pr.baseRef})`,
          blobBaseUrl: `https://${host}/${ref!.repo.owner}/${ref!.repo.repo}/blob/${pr.headSha}`,
        });
      posting = { client, repo: ref.repo, pr, label };
    }
  } catch (e) {
    if (e instanceof CancelledError || ac.signal.aborted) {
      progress.clear();
      process.stderr.write('Cancelled.\n');
      return 130;
    }
    throw e;
  }
  progress.clear();

  // Output
  if (format === 'json') process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else if (format === 'markdown') process.stdout.write(markdown());
  else process.stdout.write(renderTerminal(result, { color: isTTY(process.stdout), title }));
  if (o.output) {
    await fs.writeFile(o.output, o.output.endsWith('.json') ? JSON.stringify(result, null, 2) : markdown());
    log.info(`wrote ${o.output}`);
  }

  // Posting
  if (posting) {
    let event: ReviewEventSetting | undefined = o.draft ? 'PENDING' : o['request-changes'] ? 'REQUEST_CHANGES_IF_BLOCKING' : o.post ? 'COMMENT' : undefined;
    if (!event && !o['no-prompt'] && process.stdin.isTTY && process.stderr.isTTY) event = await askToPost(posting.label);
    if (event) {
      progress.update('Posting review…');
      const r = await postReview(posting.client, posting.repo, posting.pr, result, { event, suggestionBlocks: s.github.suggestionBlocks }, log);
      progress.clear();
      for (const n of r.notes) process.stderr.write(`note: ${n}\n`);
      process.stderr.write(`${event === 'PENDING' ? 'Pending review created' : 'Review posted'} (${r.inlineCount} inline comment(s)): ${r.url}\n`);
    }
  }

  if (result.errors.length && !result.findings.length && result.chunkCount === result.errors.length) return 2;
  if (failOn && result.findings.some((f) => severityRank(f.severity) <= severityRank(failOn))) return 1;
  return 0;
}

async function llmBase(s: CliSettings) {
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    apiKey: s.apiKey || undefined,
    temperature: s.temperature,
    maxOutputTokens: s.maxOutputTokens,
    jsonMode: s.jsonMode,
    stream: s.stream,
    timeoutMs: s.requestTimeoutSeconds * 1000,
    ollamaNumCtx: s.ollamaNumCtx,
    extraHeaders: s.extraHeaders,
    extraBody: s.extraBody,
  };
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${isTTY(process.stderr) ? '\r\x1b[K' : ''}error: ${(e as Error).message}\n`);
      if (e instanceof UsageError || (e as { code?: string }).code?.startsWith?.('ERR_PARSE_ARGS')) process.stderr.write('Run with --help for usage.\n');
      process.exit(2);
    },
  );
}
