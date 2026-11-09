/**
 * Configuration for the CLI. Keys mirror the VS Code settings (without the `diffLeppard.` prefix),
 * so a config file looks like:
 *
 *   { "baseUrl": "http://gpu-box:8000/v1", "model": "qwen2.5-coder:32b", "apiKey": "…",
 *     "extraBody": { "chat_template_kwargs": { "enable_thinking": false } },
 *     "github": { "reviewEvent": "COMMENT" } }
 *
 * Precedence (lowest → highest): defaults, user config file, repo config file, environment, CLI flags.
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReviewEventSetting } from './github';
import { JsonMode } from './llm';
import { Severity, SEVERITIES } from './types';

export interface CliSettings {
  provider: 'openai' | 'ollama';
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxOutputTokens: number;
  jsonMode: JsonMode;
  stream: boolean;
  requestTimeoutSeconds: number;
  concurrency: number;
  ollamaNumCtx: number;
  extraHeaders: Record<string, string>;
  extraBody: Record<string, unknown>;
  maxChunkChars: number;
  contextLines: number;
  includeUntracked: boolean;
  minimumSeverity: Severity;
  excludeGlobs: string[];
  extraInstructions: string;
  instructionsFile: string;
  github: {
    apiUrl: string;
    reviewEvent: ReviewEventSetting;
    suggestionBlocks: boolean;
  };
}

export const DEFAULT_EXCLUDES = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/composer.lock',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/go.sum',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.snap',
  '**/*.svg',
  '**/dist/**',
  '**/build/**',
  '**/vendor/**',
  '**/node_modules/**',
];

export function defaultSettings(): CliSettings {
  return {
    provider: 'openai',
    baseUrl: 'http://localhost:8000/v1',
    model: '',
    apiKey: '',
    temperature: 0.1,
    maxOutputTokens: 4096,
    jsonMode: 'json_object',
    stream: true,
    requestTimeoutSeconds: 900,
    concurrency: 1,
    ollamaNumCtx: 16384,
    extraHeaders: {},
    extraBody: {},
    maxChunkChars: 24000,
    contextLines: 5,
    includeUntracked: true,
    minimumSeverity: 'minor',
    excludeGlobs: DEFAULT_EXCLUDES,
    extraInstructions: '',
    instructionsFile: '.github/code-review-instructions.md',
    github: { apiUrl: 'https://api.github.com', reviewEvent: 'COMMENT', suggestionBlocks: false },
  };
}

export const REPO_CONFIG_FILE = '.diff-leppard.json';

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DIFF_LEPPARD_CONFIG) return env.DIFF_LEPPARD_CONFIG;
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'diff-leppard', 'config.json');
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge plain objects; arrays and scalars replace. Accepts `diffLeppard.`-prefixed keys too. */
export function merge<T extends Json>(base: T, over: Json): T {
  const out: Json = { ...base };
  for (let [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    k = k.replace(/^diffLeppard\./, '');
    if (k.startsWith('github.')) {
      out.github = merge((out.github as Json) ?? {}, { [k.slice(7)]: v });
      continue;
    }
    out[k] = isObj(v) && isObj(out[k]) && k !== 'extraHeaders' && k !== 'extraBody' ? merge(out[k] as Json, v) : v;
  }
  return out as T;
}

async function readJson(file: string): Promise<Json | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    // Allow // comments and trailing commas, like VS Code settings.
    const stripped = text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
    const j = JSON.parse(stripped);
    if (!isObj(j)) throw new Error('not an object');
    return j;
  } catch (e) {
    throw new Error(`Could not parse ${file}: ${(e as Error).message}`);
  }
}

function envSettings(env: NodeJS.ProcessEnv): Json {
  const o: Json = {};
  if (env.GH_HOST && env.GH_HOST !== 'github.com') o['github.apiUrl'] = `https://${env.GH_HOST}/api/v3`;
  const str = (k: string, name: string) => env[name] !== undefined && env[name] !== '' && (o[k] = env[name]);
  str('provider', 'DIFF_LEPPARD_PROVIDER');
  str('baseUrl', 'DIFF_LEPPARD_BASE_URL');
  str('model', 'DIFF_LEPPARD_MODEL');
  str('apiKey', 'DIFF_LEPPARD_API_KEY');
  str('minimumSeverity', 'DIFF_LEPPARD_MIN_SEVERITY');
  if (env.DIFF_LEPPARD_MAX_CHUNK_CHARS) o.maxChunkChars = Number(env.DIFF_LEPPARD_MAX_CHUNK_CHARS);
  if (env.DIFF_LEPPARD_CONCURRENCY) o.concurrency = Number(env.DIFF_LEPPARD_CONCURRENCY);
  str('jsonMode', 'DIFF_LEPPARD_JSON_MODE');
  str('extraInstructions', 'DIFF_LEPPARD_EXTRA_INSTRUCTIONS');
  if (env.DIFF_LEPPARD_MAX_OUTPUT_TOKENS) o.maxOutputTokens = Number(env.DIFF_LEPPARD_MAX_OUTPUT_TOKENS);
  if (env.DIFF_LEPPARD_TIMEOUT_SECONDS) o.requestTimeoutSeconds = Number(env.DIFF_LEPPARD_TIMEOUT_SECONDS);
  const json = (name: string) => {
    try {
      return JSON.parse(env[name]!);
    } catch {
      throw new Error(`${name} must be a JSON object`);
    }
  };
  if (env.DIFF_LEPPARD_EXTRA_BODY) o.extraBody = json('DIFF_LEPPARD_EXTRA_BODY');
  if (env.DIFF_LEPPARD_EXTRA_HEADERS) o.extraHeaders = json('DIFF_LEPPARD_EXTRA_HEADERS');
  if (env.DIFF_LEPPARD_GITHUB_API_URL) o['github.apiUrl'] = env.DIFF_LEPPARD_GITHUB_API_URL;
  return o;
}

export interface LoadedConfig {
  settings: CliSettings;
  sources: string[];
}

export async function loadConfig(repoRoot: string | undefined, flags: Json, env = process.env): Promise<LoadedConfig> {
  let settings = defaultSettings() as unknown as Json;
  const sources: string[] = [];
  const userFile = userConfigPath(env);
  const user = await readJson(userFile);
  if (user) {
    settings = merge(settings, user);
    sources.push(userFile);
  }
  if (repoRoot) {
    const repoFile = path.join(repoRoot, REPO_CONFIG_FILE);
    const repo = await readJson(repoFile);
    if (repo) {
      if ('apiKey' in repo) throw new Error(`${repoFile} must not contain apiKey; put it in ${userFile} or DIFF_LEPPARD_API_KEY.`);
      settings = merge(settings, repo);
      sources.push(repoFile);
    }
  }
  settings = merge(settings, envSettings(env));
  settings = merge(settings, flags);
  const s = settings as unknown as CliSettings;
  if (!SEVERITIES.includes(s.minimumSeverity)) throw new Error(`minimumSeverity must be one of ${SEVERITIES.join(', ')}`);
  if (s.provider !== 'openai' && s.provider !== 'ollama') throw new Error('provider must be "openai" or "ollama"');
  return { settings: s, sources };
}
