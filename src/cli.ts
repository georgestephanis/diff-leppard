/**
 * Command-line interface: review GitHub PRs or local changes with a self-hosted LLM.
 *
 *   diff-leppard pr 123 --post
 *   diff-leppard local
 *   gh diff-leppard 123          (via the gh extension in ./gh-diff-leppard)
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as readline from 'readline/promises';
import { parseArgs } from 'util';
import { loadConfig, readRepoConfig, REPO_CONFIG_FILE, REPO_CONFIG_KEYS, RepoConfigInput, userConfigPath } from './config';
import { renderTerminal } from './format';
import { toRdjson, toSarif } from './formats';
import { ghExec, githubTokenFor } from './gh';
import { getRepoRoot } from './git';
import { GitHubClient, parsePrReference, postReview, PullRequestInfo, RepoRef, ReviewEventSetting, webHostFromApiUrl } from './github';
import { healthCheck, LlmClient, LlmError } from './llm';
import { defaultRepo, llmBase, makeLlm, reviewLocalChanges, ReviewInputError, reviewPullRequest } from './flow';
import { serveMcp } from './mcp';
import { acquireLock, defaultStateFile, parseInterval, watchOnce } from './watch';
import { CancelledError } from './review';
import { Logger, ReviewResult, Severity, SEVERITIES, severityRank } from './types';

const HELP = `diff-leppard — AI code review with your own LLM server (vLLM, Ollama, LM Studio, llama.cpp, …)

Usage:
  diff-leppard pr [<number> | <url> | <owner/repo#number>] [options]
      Review a GitHub pull request. With no argument, reviews the PR for the current branch.
  diff-leppard local [--staged | --base <ref> | --range <a>..<b>] [options]
      Review uncommitted changes in the current git repo; or only staged changes; or everything since
      branching from <ref> (committed + uncommitted, e.g. --base main); or exactly the commits a..b
      (a...b = since their merge-base).
  diff-leppard hook             For pre-commit: staged changes at pre-commit, the pushed commits at pre-push
  diff-leppard watch [--once] [--dry-run] [--interval 5m]
      Review open PRs that request your review, in every repo you can access, once per head commit,
      leaving a pending (draft) review for you to edit and submit. Configure with "watch" in your config.
  diff-leppard mcp             Run as an MCP server over stdio (tools: review_local_changes, review_pull_request,
                               check_model_server). Read-only: it never posts to GitHub.
  diff-leppard models          List models on the configured server
  diff-leppard test            Check the server connection with a tiny request
  diff-leppard config          Show the effective configuration and where it came from

  As a gh extension:  gh diff-leppard [<pr>] [options]   (same options; "gh diff-leppard local" for local changes)

Posting (PR reviews):
      --post                Post the review (as github.reviewEvent from config; default COMMENT)
      --request-changes     Post; request changes if there are critical/major findings
      --draft               Create a pending (draft) review you can edit and submit on GitHub
      --no-prompt           Never ask whether to post (default: ask when running in a terminal)

Output:
  -f, --format <fmt>        text | markdown | json | sarif | rdjson   (default: text in a terminal, markdown when piped)
                            sarif: GitHub code scanning and other SARIF tools; rdjson: reviewdog (GitLab, Gitea, …)
  -o, --output <file>       Also write the report to a file; repeatable. The format follows the extension:
                            .json, .sarif, .rdjson (or .rdjsonl), otherwise Markdown
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

Watch:
      --once                Check once and exit (for cron, systemd timers, launchd)
      --dry-run             Show which PRs would be reviewed; no model calls, nothing posted (implies --once)
      --interval <time>     Time between checks in loop mode, e.g. 5m, 90s, 1h (default: watch.intervalMinutes)
      --state <file>        Where reviewed PRs are recorded (default: $XDG_STATE_HOME/diff-leppard/watch.json)
      --draft / --post / --request-changes   Override watch.event (default: draft)

Other:
  -R, --repo <owner/repo>   Repository for a bare PR number (default: gh's default repo / git remotes)
  -C, --cwd <dir>           Run as if started in <dir>
      --staged              (local) only staged changes
      --base <ref>          (local) everything since the merge-base with <ref>, e.g. main or origin/main
      --range <a>..<b>      (local) exactly the commits between two refs
  -h, --help
      --version

Config files (JSON, same keys as the VS Code settings without the "diffLeppard." prefix):
  ${userConfigPath()}   (user; may contain apiKey)
  <repo>/${REPO_CONFIG_FILE}   (per repo; only ${REPO_CONFIG_KEYS.join(', ')}.
      For PR reviews it is read from the PR's base branch, never from the PR itself.)
Environment: every setting as DIFF_LEPPARD_<UPPER_SNAKE_KEY>, e.g. DIFF_LEPPARD_BASE_URL, DIFF_LEPPARD_MODEL, DIFF_LEPPARD_API_KEY,
  DIFF_LEPPARD_EXTRA_BODY (JSON), DIFF_LEPPARD_STREAM=false, DIFF_LEPPARD_GITHUB_REVIEW_EVENT. Also DIFF_LEPPARD_CONFIG (config path)
  and DIFF_LEPPARD_DEBUG=1. GitHub token: GH_TOKEN / GITHUB_TOKEN for github.com, GH_ENTERPRISE_TOKEN for other hosts,
  else \`gh auth token\`.

Exit codes: 0 success · 1 findings at/above --fail-on · 2 error, or the review was incomplete (some parts failed) · 130 cancelled
`;

class UsageError extends Error {}

/** Version from package.json; works from dist/ (one level down) and out/src/ (two levels). */
function packageVersion(): string {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require(rel);
      if (pkg?.name === 'diff-leppard') return pkg.version;
    } catch {
      /* try the next location */
    }
  }
  return 'unknown';
}

/** Whether a stream is an interactive terminal (decides text vs. Markdown output and the spinner). */
const isTTY = (s: NodeJS.WriteStream) => !!s.isTTY && process.env.TERM !== 'dumb';
/** Whether to use ANSI colors (https://no-color.org: NO_COLOR disables color only). */
const useColor = (s: NodeJS.WriteStream) => isTTY(s) && !process.env.NO_COLOR;

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

async function askToPost(label: string, configured: ReviewEventSetting): Promise<ReviewEventSetting | undefined> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const a = (await rl.question(`Post this review to ${label}? [y]es / [d]raft / [r]equest changes / [N]o: `)).trim().toLowerCase();
    if (a === 'y' || a === 'yes') return configured === 'PENDING' ? 'COMMENT' : configured;
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
      output: { type: 'string', short: 'o', multiple: true },
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
      base: { type: 'string' },
      range: { type: 'string' },
      once: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      interval: { type: 'string' },
      state: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });

  if (o.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (o.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  let command = positionals[0] ?? 'pr';
  let rest = positionals.slice(1);
  if (!['pr', 'local', 'staged', 'hook', 'watch', 'mcp', 'models', 'test', 'config', 'help'].includes(command)) {
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
  if (command === 'hook') {
    // pre-commit (https://pre-commit.com) exports these for pre-push; otherwise review what's staged.
    const from = process.env.PRE_COMMIT_FROM_REF;
    const to = process.env.PRE_COMMIT_TO_REF;
    if (from && to) o.range = `${from}..${to}`;
    else o.staged = true;
    o['no-prompt'] = true;
    o.format ??= 'text';
    command = 'local';
  }
  if ([o.staged, o.base, o.range].filter(Boolean).length > 1) throw new UsageError('Use only one of --staged, --base and --range');

  const cwd = path.resolve(o.cwd ?? process.cwd());
  const root = await getRepoRoot(cwd);

  const flags: Record<string, unknown> = {
    baseUrl: o['base-url'],
    model: o.model,
    provider: o.provider,
    apiKey: o['api-key'],
    jsonMode: o['json-mode'],
    stream: o['no-stream'] ? false : undefined,
    maxChunkChars: o['max-chunk-chars'] !== undefined ? Number(o['max-chunk-chars']) : undefined,
    concurrency: o.concurrency !== undefined ? Number(o.concurrency) : undefined,
    minimumSeverity: o['min-severity'],
  };
  if (o['extra-body']) {
    try {
      flags.extraBody = JSON.parse(o['extra-body']);
    } catch {
      throw new UsageError('--extra-body must be JSON');
    }
  }
  const headers: Record<string, string> = {};
  for (const h of o.header ?? []) {
    const i = h.indexOf(':');
    if (i < 1) throw new UsageError(`--header must look like "Name: value" (got "${h}")`);
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  const configure = async (repo: RepoConfigInput | undefined) => {
    let loaded;
    try {
      loaded = await loadConfig(repo, flags);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    if (Object.keys(headers).length) loaded.settings.extraHeaders = { ...loaded.settings.extraHeaders, ...headers };
    return loaded;
  };
  // PR reviews take repo config from the PR's base branch (below); local reviews from the working tree.
  const isPr = !['local', 'watch', 'mcp', 'models', 'test', 'config'].includes(command);
  let { settings: s, sources, warnings } = await configure(isPr ? undefined : await readRepoConfig(root));

  // MCP: stdout is the protocol, so no spinner. Warnings (and -v info) still go to stderr, which clients log.
  const progress = new Progress(!o.quiet && command !== 'mcp', isTTY(process.stderr));
  const log = makeLogger(!!o.verbose, !!o.quiet, progress);
  for (const src of sources) log.info(`config: ${src}`);
  for (const w of warnings) log.warn(w);

  if (command === 'mcp') {
    await serveMcp({ input: process.stdin, output: process.stdout, version: packageVersion(), cwd, configure, log });
    return 0;
  }

  if (command === 'config') {
    const redacted = JSON.parse(JSON.stringify(s));
    if (redacted.apiKey) redacted.apiKey = '***';
    for (const k of Object.keys(redacted.extraHeaders ?? {})) redacted.extraHeaders[k] = '***';
    process.stdout.write(`# sources: ${sources.length ? sources.join(', ') : '(defaults only)'}\n${JSON.stringify(redacted, null, 2)}\n`);
    return 0;
  }

  if (command === 'models') {
    const models = await new LlmClient({ ...llmBase(s), model: s.model }, log).listModels();
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

  const cancelled = () => {
    progress.clear();
    process.stderr.write('Cancelled.\n');
    return 130;
  };

  if (command === 'test') {
    progress.update(`Connecting to ${s.baseUrl}…`);
    try {
      const llm = await makeLlm(s, log);
      const r = await healthCheck(llm, ac.signal);
      progress.clear();
      process.stdout.write(`✓ ${llm.model} at ${s.baseUrl} replied in ${(r.ms / 1000).toFixed(1)}s: ${r.content.trim().slice(0, 200) || '(empty reply)'}\n`);
      return 0;
    } catch (e) {
      if (ac.signal.aborted) return cancelled();
      throw e;
    }
  }

  if (command === 'watch') {
    const host = webHostFromApiUrl(s.github.apiUrl);
    const client = new GitHubClient(s.github.apiUrl, await githubTokenFor(host), log);
    const stateFile = path.resolve(o.state ?? (s.watch.stateFile || defaultStateFile()));
    const intervalMs = o.interval ? parseInterval(o.interval) : s.watch.intervalMinutes * 60_000;
    const once = !!(o.once || o['dry-run']);
    const event: ReviewEventSetting | undefined = o.draft ? 'PENDING' : o['request-changes'] ? 'REQUEST_CHANGES_IF_BLOCKING' : o.post ? 'COMMENT' : undefined;
    const release = await acquireLock(stateFile);
    if (!release) {
      process.stderr.write(`Another diff-leppard watch is already running (lock: ${stateFile}.lock); exiting.\n`);
      return 0;
    }
    const say = (line: string) => {
      progress.clear();
      process.stderr.write(`[${new Date().toLocaleTimeString()}] ${line}\n`);
    };
    if (!once) say(`watching every ${Math.round(intervalMs / 1000)}s (Ctrl-C to stop); state: ${stateFile}`);
    try {
      for (;;) {
        try {
          const sum = await watchOnce({
            client,
            host,
            settings: s,
            configure,
            event,
            stateFile,
            dryRun: !!o['dry-run'],
            log,
            say,
            signal: ac.signal,
            onProgress: (m) => progress.update(m),
          });
          const extra = [sum.skipped && `${sum.skipped} skipped`, sum.failed && `${sum.failed} failed`, sum.deferred && `${sum.deferred} left for next time`]
            .filter(Boolean)
            .join(', ');
          say(`checked ${sum.candidates} open PR(s): ${sum.reviewed} ${o['dry-run'] ? 'to review' : 'reviewed'}${extra ? `, ${extra}` : ''}`);
        } catch (e) {
          if (ac.signal.aborted) break;
          if (once) throw e;
          say(`check failed: ${(e as Error).message} (retrying next time)`);
        }
        if (once || ac.signal.aborted) break;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, intervalMs);
          ac.signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
        });
        if (ac.signal.aborted) break;
      }
    } finally {
      await release();
    }
    return ac.signal.aborted ? cancelled() : 0;
  }

  const failOn = o['fail-on'] as Severity | undefined;
  if (failOn && !SEVERITIES.includes(failOn)) throw new UsageError(`--fail-on must be one of ${SEVERITIES.join(', ')}`);
  const format = o.format ?? (isTTY(process.stdout) ? 'text' : 'markdown');
  if (!['text', 'markdown', 'json', 'sarif', 'rdjson'].includes(format)) throw new UsageError('--format must be text, markdown, json, sarif or rdjson');

  let result: ReviewResult;
  let title: string;
  let markdown: () => string;
  let posting: { client: GitHubClient; repo: RepoRef; pr: PullRequestInfo; label: string } | undefined;

  try {
    if (command === 'local') {
      if (!root) throw new UsageError(`${cwd} is not inside a git repository`);
      const local = await reviewLocalChanges({
        root,
        settings: s,
        staged: !!o.staged,
        base: o.base,
        range: o.range,
        log,
        signal: ac.signal,
        onProgress: (m) => progress.update(m),
      });
      if (!local.result) {
        progress.clear();
        process.stderr.write(`No ${local.what} in ${path.basename(root)}.\n`);
        return 0;
      }
      result = local.result;
      ({ title, markdown } = local);
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
        const url = await ghExec(['pr', 'view', '--json', 'url', '-q', '.url'], cwd).catch(() => '');
        ref = url ? parsePrReference(url, host) : undefined;
        if (!ref) throw new UsageError('No PR given and no PR found for the current branch. Pass a PR number or URL.');
      }
      const label = `${ref.repo.owner}/${ref.repo.repo}#${ref.number}`;
      progress.update(`Fetching ${label}…`);
      const client = new GitHubClient(s.github.apiUrl, await githubTokenFor(host), log);
      const review = await reviewPullRequest({
        client,
        repo: ref.repo,
        number: ref.number,
        host,
        settings: s,
        configure,
        log,
        signal: ac.signal,
        onProgress: (m) => progress.update(m),
      });
      ({ result, title, markdown } = review);
      s = review.settings;
      const pr = review.pr;
      posting = { client, repo: ref.repo, pr, label };
    }
  } catch (e) {
    if (e instanceof CancelledError || ac.signal.aborted) return cancelled();
    throw e;
  }
  progress.clear();

  // Output
  const render = (fmt: string): string => {
    if (fmt === 'json') return JSON.stringify(result, null, 2) + '\n';
    if (fmt === 'sarif') return JSON.stringify(toSarif(result, packageVersion()), null, 2) + '\n';
    if (fmt === 'rdjson') return JSON.stringify(toRdjson(result)) + '\n';
    if (fmt === 'markdown') return markdown();
    return renderTerminal(result, { color: useColor(process.stdout), title });
  };
  process.stdout.write(render(format));
  for (const file of o.output ?? []) {
    const ext = path.extname(file).toLowerCase();
    const fmt = ext === '.json' ? 'json' : ext === '.sarif' ? 'sarif' : ext === '.rdjson' || ext === '.rdjsonl' ? 'rdjson' : 'markdown';
    await fs.writeFile(file, render(fmt));
    log.info(`wrote ${file} (${fmt})`);
  }

  // Posting
  if (posting) {
    let event: ReviewEventSetting | undefined = o.draft
      ? 'PENDING'
      : o['request-changes']
        ? 'REQUEST_CHANGES_IF_BLOCKING'
        : o.post
          ? s.github.reviewEvent
          : undefined;
    if (!event && !o['no-prompt'] && process.stdin.isTTY && process.stderr.isTTY) event = await askToPost(posting.label, s.github.reviewEvent);
    if (event) {
      progress.update('Posting review…');
      const r = await postReview(posting.client, posting.repo, posting.pr, result, { event, suggestionBlocks: s.github.suggestionBlocks, attribution: s.github.attribution }, log);
      progress.clear();
      for (const n of r.notes) process.stderr.write(`note: ${n}\n`);
      process.stderr.write(`${event === 'PENDING' ? 'Pending review created' : 'Review posted'} (${r.inlineCount} inline comment(s)): ${r.url}\n`);
    }
  }

  if (result.errors.length) {
    process.stderr.write(`error: review incomplete: ${result.errors.length} of ${result.chunkCount} part(s) failed (see above).\n`);
    return 2;
  }
  if (failOn && result.findings.some((f) => severityRank(f.severity) <= severityRank(failOn))) return 1;
  return 0;
}

/** Run the CLI and exit the process with its status code. Used by bin/diff-leppard.js and `node dist/cli.js`. */
export function run(argv: string[] = process.argv.slice(2)): void {
  main(argv).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${isTTY(process.stderr) ? '\r\x1b[K' : ''}error: ${(e as Error).message}\n`);
      if (e instanceof UsageError || e instanceof ReviewInputError || (e as { code?: string }).code?.startsWith?.('ERR_PARSE_ARGS')) process.stderr.write('Run with --help for usage.\n');
      process.exit(e instanceof LlmError && e.message === 'Cancelled' ? 130 : 2);
    },
  );
}

if (require.main === module) run();
