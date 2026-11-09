/** End-to-end review flows shared by the CLI's `pr` and `watch` commands (no `vscode` imports). */
import { CliSettings, LoadedConfig, parseJsonc, REPO_CONFIG_FILE, RepoConfigInput, userConfigPath } from './config';
import * as path from 'path';
import { makeExcluder } from './diff';
import { ghExec, githubRemotes } from './gh';
import { getLocalDiff, git, readRepoFile, resolveRef } from './git';
import { GitHubClient, PullRequestInfo, RepoRef } from './github';
import { LlmClient, LlmConfig, resolveChunkChars } from './llm';
import { loadPullRequest } from './pr';
import { renderMarkdownReport } from './report';
import { runReview } from './review';
import { Logger, ReviewResult } from './types';

export function llmBase(s: CliSettings): Omit<LlmConfig, 'model'> {
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

/** A client for the configured model; with no model set, uses the server's only model. */
export async function makeLlm(s: CliSettings, log: Logger): Promise<LlmClient> {
  const cfg = { ...llmBase(s), model: s.model };
  if (!cfg.model) {
    const models = await new LlmClient(cfg, log).listModels();
    if (models.length !== 1) {
      throw new Error(
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

export interface PrReview {
  pr: PullRequestInfo;
  result: ReviewResult;
  /** Settings after applying the repo's base-branch config. */
  settings: CliSettings;
  title: string;
  markdown: () => string;
}

/**
 * Review one pull request: apply the repo config from the PR's *base* branch (a PR can't change how it is
 * itself reviewed), load the diff and guidelines, size chunks to the model, and run the review.
 */
export async function reviewPullRequest(p: {
  client: GitHubClient;
  repo: RepoRef;
  number: number;
  host: string;
  settings: CliSettings;
  /** Reload settings with a repo config layered in (user < repo < env < flags). */
  configure: (repo: RepoConfigInput | undefined) => Promise<LoadedConfig>;
  log: Logger;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Already-fetched PR metadata. */
  prefetched?: PullRequestInfo;
}): Promise<PrReview> {
  const label = `${p.repo.owner}/${p.repo.repo}#${p.number}`;
  let s = p.settings;
  const pr0 = p.prefetched ?? (await p.client.getPull(p.repo, p.number));
  const repoCfgText = await p.client.getFileContent(p.repo, REPO_CONFIG_FILE, pr0.baseSha).catch(() => undefined);
  if (repoCfgText !== undefined) {
    let json: unknown;
    try {
      json = parseJsonc(repoCfgText);
    } catch (e) {
      throw new Error(`Could not parse ${REPO_CONFIG_FILE} on ${pr0.baseRef} of ${label}: ${(e as Error).message}`);
    }
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const source = `${p.repo.owner}/${p.repo.repo}@${pr0.baseRef}:${REPO_CONFIG_FILE}`;
      const loaded = await p.configure({ json: json as Record<string, unknown>, source });
      s = loaded.settings;
      p.log.info(`config: ${source}`);
      for (const w of loaded.warnings) p.log.warn(w);
    }
  }
  const loaded = await loadPullRequest(p.client, p.repo, p.number, s.instructionsFile, p.log, pr0);
  const llm = await makeLlm(s, p.log);
  const result = await runReview(loaded.files, {
    llm,
    maxChunkChars: await resolveChunkChars(llm, s.maxChunkChars, s.maxOutputTokens, p.log, p.signal),
    concurrency: s.concurrency,
    minimumSeverity: s.minimumSeverity,
    exclude: makeExcluder(s.excludeGlobs),
    context: { title: loaded.pr.title, description: loaded.pr.body, extraInstructions: s.extraInstructions, repoInstructions: loaded.repoInstructions },
    log: p.log,
    signal: p.signal,
    onProgress: p.onProgress,
    preSkipped: loaded.skipped,
  });
  const pr = loaded.pr;
  const title = `Review of ${label}: ${pr.title}`;
  const markdown = () =>
    renderMarkdownReport(result, {
      title,
      source: `[${label}](${pr.htmlUrl}) by @${pr.author} (${pr.headRef} → ${pr.baseRef})`,
      blobBaseUrl: `https://${p.host}/${p.repo.owner}/${p.repo.repo}/blob/${pr.headSha}`,
    });
  return { pr, result, settings: s, title, markdown };
}

/** A problem with what was asked for (bad ref, not a repo, …), as opposed to a failure while reviewing. */
export class ReviewInputError extends Error {}

/** The GitHub repo for a checkout: what `gh` thinks, else the first GitHub remote (upstream, then origin). */
export async function defaultRepo(cwd: string, root: string | undefined, host: string): Promise<RepoRef | undefined> {
  try {
    const nwo = await ghExec(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd);
    const m = /^([^/]+)\/([^/]+)$/.exec(nwo);
    if (m) return { owner: m[1], repo: m[2] };
  } catch {
    /* no gh, or not a GitHub repo for gh */
  }
  return (await githubRemotes(root, host))[0]?.repo;
}

export interface LocalReviewRequest {
  /** Repo root. */
  root: string;
  settings: CliSettings;
  /** At most one of these. Neither: uncommitted changes (including untracked files). */
  staged?: boolean;
  /** Everything since the merge-base with this ref (committed + uncommitted). */
  base?: string;
  /** Exactly these commits: `a..b`, or `a...b` for "since their merge-base". */
  range?: string;
  log: Logger;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface LocalReview {
  /** "uncommitted changes", "changes since main", … */
  what: string;
  /** Undefined when there was nothing to review. */
  result?: ReviewResult;
  title: string;
  markdown: () => string;
}

/** Review local changes in a repo (shared by `diff-leppard local` and the MCP server). */
export async function reviewLocalChanges(p: LocalReviewRequest): Promise<LocalReview> {
  const s = p.settings;
  if ([p.staged, p.base, p.range].filter(Boolean).length > 1) throw new ReviewInputError('Use only one of staged, base and range');
  let range: { from: string; to: string } | undefined;
  if (p.range) {
    const m = /^(.+?)(\.{2,3})(.+)$/.exec(p.range);
    if (!m) throw new ReviewInputError('range must look like <from>..<to> (or <from>...<to> for "since the merge-base")');
    range = { from: m[1], to: m[3] };
    if (m[2] === '...') {
      let mb = '';
      try {
        mb = (await git(p.root, ['merge-base', await resolveRef(p.root, m[1]), await resolveRef(p.root, m[3])])).trim();
      } catch (e) {
        throw new ReviewInputError((e as Error).message);
      }
      if (!mb) throw new ReviewInputError(`No common ancestor between ${m[1]} and ${m[3]}`);
      range.from = mb;
    }
  }
  const what = p.range ? `commits ${p.range}` : p.base ? `changes since ${p.base}` : p.staged ? 'staged changes' : 'uncommitted changes';
  const name = path.basename(p.root);
  const title = `Review of ${what} — ${name}`;
  p.onProgress?.('Collecting diff…');
  const exclude = makeExcluder(s.excludeGlobs);
  let diff;
  try {
    diff = await getLocalDiff(p.root, {
      stagedOnly: !!p.staged,
      base: p.base,
      range,
      contextLines: s.contextLines,
      includeUntracked: s.includeUntracked,
      maxUntrackedBytes: 256 * 1024,
      exclude,
    });
  } catch (e) {
    throw new ReviewInputError((e as Error).message);
  }
  if (!diff.files.length) return { what, title, markdown: () => `No ${what} in ${name}.\n` };
  const repoInstructions = s.instructionsFile ? await readRepoFile(p.root, s.instructionsFile) : undefined;
  if (repoInstructions) p.log.info(`Using review guidelines from ${s.instructionsFile}`);
  const llm = await makeLlm(s, p.log);
  const result = await runReview(diff.files, {
    llm,
    maxChunkChars: await resolveChunkChars(llm, s.maxChunkChars, s.maxOutputTokens, p.log, p.signal),
    concurrency: s.concurrency,
    minimumSeverity: s.minimumSeverity,
    exclude,
    context: { extraInstructions: s.extraInstructions, repoInstructions },
    log: p.log,
    signal: p.signal,
    onProgress: p.onProgress,
    preSkipped: diff.skipped,
  });
  return {
    what,
    result,
    title,
    markdown: () => renderMarkdownReport(result, { title, source: `${what[0].toUpperCase()}${what.slice(1)} in **${name}**` }),
  };
}
