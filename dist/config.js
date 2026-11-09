"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPO_CONFIG_KEYS = exports.REPO_CONFIG_FILE = exports.DEFAULT_EXCLUDES = void 0;
exports.defaultSettings = defaultSettings;
exports.userConfigPath = userConfigPath;
exports.normalizeKeys = normalizeKeys;
exports.merge = merge;
exports.parseJsonc = parseJsonc;
exports.readJsonFile = readJsonFile;
exports.filterRepoConfig = filterRepoConfig;
exports.envSettings = envSettings;
exports.readRepoConfig = readRepoConfig;
exports.loadConfig = loadConfig;
/**
 * Configuration for the CLI. Keys mirror the VS Code settings (without the `diffLeppard.` prefix),
 * so a config file looks like:
 *
 *   { "baseUrl": "http://gpu-box:8000/v1", "model": "qwen2.5-coder:32b", "apiKey": "…",
 *     "extraBody": { "chat_template_kwargs": { "enable_thinking": false } },
 *     "github": { "reviewEvent": "COMMENT" } }
 *
 * Precedence (lowest → highest): defaults, user config file, repo config file (restricted keys), environment, CLI flags.
 */
const fs_1 = require("fs");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const types_1 = require("./types");
exports.DEFAULT_EXCLUDES = [
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
function defaultSettings() {
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
        maxChunkChars: 0, // 0 = auto: size to the model's context window
        contextLines: 5,
        includeUntracked: true,
        minimumSeverity: 'minor',
        excludeGlobs: exports.DEFAULT_EXCLUDES,
        extraInstructions: '',
        instructionsFile: '.github/code-review-instructions.md',
        github: { apiUrl: 'https://api.github.com', reviewEvent: 'COMMENT', suggestionBlocks: false, attribution: true },
    };
}
exports.REPO_CONFIG_FILE = '.diff-leppard.json';
function userConfigPath(env = process.env) {
    if (env.DIFF_LEPPARD_CONFIG)
        return env.DIFF_LEPPARD_CONFIG;
    const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(base, 'diff-leppard', 'config.json');
}
function isObj(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}
/** Flatten `diffLeppard.` prefixes and `github.x` dotted keys into the nested settings shape. */
function normalizeKeys(o) {
    const out = {};
    for (let [k, v] of Object.entries(o)) {
        if (v === undefined)
            continue;
        k = k.replace(/^diffLeppard\./, '');
        if (k.startsWith('github.')) {
            out.github = { ...(out.github ?? {}), [k.slice(7)]: v };
        }
        else if (k === 'github' && isObj(v)) {
            out.github = { ...(out.github ?? {}), ...v };
        }
        else
            out[k] = v;
    }
    return out;
}
/** Deep-merge plain objects; arrays and scalars replace. Accepts `diffLeppard.`-prefixed keys too. */
function merge(base, over) {
    const out = { ...base };
    for (const [k, v] of Object.entries(normalizeKeys(over))) {
        out[k] = isObj(v) && isObj(out[k]) && k !== 'extraHeaders' && k !== 'extraBody' ? merge(out[k], v) : v;
    }
    return out;
}
/** Parse JSON with comments and trailing commas (like VS Code settings), leaving string contents untouched. */
function parseJsonc(text) {
    // Two string-aware passes: drop comments, then drop commas that precede } or ].
    const scan = (src, onCode) => {
        let out = '';
        let i = 0;
        while (i < src.length) {
            if (src[i] === '"') {
                let j = i + 1;
                while (j < src.length && src[j] !== '"')
                    j += src[j] === '\\' ? 2 : 1;
                out += src.slice(i, j + 1);
                i = j + 1;
                continue;
            }
            const r = onCode(src, i);
            if (r) {
                out += r.emit;
                i += r.skip;
            }
            else
                out += src[i++];
        }
        return out;
    };
    const noComments = scan(text, (src, i) => {
        if (src[i] === '/' && src[i + 1] === '/') {
            const nl = src.indexOf('\n', i);
            return { skip: (nl < 0 ? src.length : nl) - i, emit: '' };
        }
        if (src[i] === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            return { skip: (end < 0 ? src.length : end + 2) - i, emit: ' ' };
        }
        return undefined;
    });
    const noTrailingCommas = scan(noComments, (src, i) => (src[i] === ',' && /^\s*[}\]]/.test(src.slice(i + 1)) ? { skip: 1, emit: '' } : undefined));
    return JSON.parse(noTrailingCommas);
}
async function readJsonFile(file) {
    let text;
    try {
        text = await fs_1.promises.readFile(file, 'utf8');
    }
    catch {
        return undefined;
    }
    try {
        const j = parseJsonc(text);
        if (!isObj(j))
            throw new Error('not an object');
        return j;
    }
    catch (e) {
        throw new Error(`Could not parse ${file}: ${e.message}`);
    }
}
/**
 * Keys a repository's .diff-leppard.json may set. Anything that decides where requests (and credentials)
 * go, what's sent, or how much load is generated stays under the user's control: a repo, or a PR branch
 * of it, must not be able to redirect your API key / GitHub token or rewrite the request.
 */
exports.REPO_CONFIG_KEYS = [
    'model',
    'temperature',
    'maxChunkChars',
    'contextLines',
    'includeUntracked',
    'minimumSeverity',
    'excludeGlobs',
    'extraInstructions',
    'instructionsFile',
];
/** Keep only allowed keys from a repo config; report the rest. */
function filterRepoConfig(json) {
    const flat = normalizeKeys(json);
    const allowed = {};
    const ignored = [];
    for (const [k, v] of Object.entries(flat)) {
        if (exports.REPO_CONFIG_KEYS.includes(k))
            allowed[k] = v;
        else if (k === 'github' && isObj(v))
            ignored.push(...Object.keys(v).map((g) => `github.${g}`));
        else
            ignored.push(k);
    }
    return { allowed, ignored };
}
const upperSnake = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
/** Aliases kept for the GitHub Action and older docs. */
const ENV_ALIASES = { MIN_SEVERITY: 'minimumSeverity', TIMEOUT_SECONDS: 'requestTimeoutSeconds' };
function parseEnvValue(name, raw, sample) {
    if (typeof sample === 'number')
        return Number(raw);
    if (typeof sample === 'boolean') {
        if (/^(1|true|yes|on)$/i.test(raw))
            return true;
        if (/^(0|false|no|off)$/i.test(raw))
            return false;
        throw new Error(`${name} must be true or false`);
    }
    if (Array.isArray(sample)) {
        if (raw.trim().startsWith('[')) {
            const v = JSON.parse(raw);
            if (!Array.isArray(v))
                throw new Error(`${name} must be a JSON array or a comma-separated list`);
            return v;
        }
        return raw.split(',').map((x) => x.trim()).filter(Boolean);
    }
    if (isObj(sample)) {
        let v;
        try {
            v = JSON.parse(raw);
        }
        catch {
            throw new Error(`${name} must be a JSON object`);
        }
        if (!isObj(v))
            throw new Error(`${name} must be a JSON object`);
        return v;
    }
    return raw;
}
/** Every setting is available as DIFF_LEPPARD_<UPPER_SNAKE_KEY> (github.* as DIFF_LEPPARD_GITHUB_<KEY>). */
function envSettings(env) {
    const o = {};
    if (env.GH_HOST && env.GH_HOST !== 'github.com')
        o['github.apiUrl'] = `https://${env.GH_HOST}/api/v3`;
    const defaults = defaultSettings();
    const set = (key, name, sample) => {
        const raw = env[name];
        if (raw === undefined || raw === '')
            return;
        o[key] = parseEnvValue(name, raw, sample);
    };
    for (const [alias, key] of Object.entries(ENV_ALIASES))
        set(key, `DIFF_LEPPARD_${alias}`, defaults[key]);
    for (const [k, sample] of Object.entries(defaults)) {
        if (k === 'github') {
            for (const [g, gs] of Object.entries(sample))
                set(`github.${g}`, `DIFF_LEPPARD_GITHUB_${upperSnake(g)}`, gs);
        }
        else
            set(k, `DIFF_LEPPARD_${upperSnake(k)}`, sample);
    }
    return o;
}
function validate(s) {
    const int = (k, min, max = Number.MAX_SAFE_INTEGER) => {
        const v = s[k];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
            throw new Error(`${k} must be a whole number between ${min} and ${max === Number.MAX_SAFE_INTEGER ? '∞' : max} (got ${JSON.stringify(v)})`);
        }
    };
    const oneOf = (name, v, allowed) => {
        if (!allowed.includes(v))
            throw new Error(`${name} must be one of ${allowed.join(', ')} (got ${JSON.stringify(v)})`);
    };
    const bool = (name, v) => {
        if (typeof v !== 'boolean')
            throw new Error(`${name} must be true or false (got ${JSON.stringify(v)})`);
    };
    oneOf('provider', s.provider, ['openai', 'ollama']);
    oneOf('jsonMode', s.jsonMode, ['json_object', 'json_schema', 'none']);
    oneOf('minimumSeverity', s.minimumSeverity, types_1.SEVERITIES);
    oneOf('github.reviewEvent', s.github.reviewEvent, ['COMMENT', 'REQUEST_CHANGES_IF_BLOCKING', 'PENDING']);
    int('maxChunkChars', 0);
    if (s.maxChunkChars > 0 && s.maxChunkChars < 1000)
        throw new Error(`maxChunkChars must be 0 (auto) or at least 1000 (got ${s.maxChunkChars})`);
    int('concurrency', 1, 64);
    int('maxOutputTokens', 16);
    int('requestTimeoutSeconds', 1);
    int('contextLines', 0, 1000);
    int('ollamaNumCtx', 256);
    if (typeof s.temperature !== 'number' || !(s.temperature >= 0 && s.temperature <= 2)) {
        throw new Error(`temperature must be a number between 0 and 2 (got ${JSON.stringify(s.temperature)})`);
    }
    bool('stream', s.stream);
    bool('includeUntracked', s.includeUntracked);
    bool('github.suggestionBlocks', s.github.suggestionBlocks);
    bool('github.attribution', s.github.attribution);
    for (const [k, v] of [['baseUrl', s.baseUrl], ['github.apiUrl', s.github.apiUrl]]) {
        try {
            const u = new URL(v);
            if (u.protocol !== 'http:' && u.protocol !== 'https:')
                throw new Error();
        }
        catch {
            throw new Error(`${k} must be an http(s) URL (got ${JSON.stringify(v)})`);
        }
    }
    if (!Array.isArray(s.excludeGlobs) || s.excludeGlobs.some((g) => typeof g !== 'string'))
        throw new Error('excludeGlobs must be a list of strings');
    for (const [k, v] of [['extraHeaders', s.extraHeaders], ['extraBody', s.extraBody]]) {
        if (!isObj(v))
            throw new Error(`${k} must be an object`);
    }
    if (Object.values(s.extraHeaders).some((v) => typeof v !== 'string'))
        throw new Error('extraHeaders values must be strings');
}
/** Read <root>/.diff-leppard.json if present. */
async function readRepoConfig(root) {
    if (!root)
        return undefined;
    const file = path.join(root, exports.REPO_CONFIG_FILE);
    const json = await readJsonFile(file);
    return json ? { json, source: file } : undefined;
}
async function loadConfig(repo, flags, env = process.env) {
    let settings = defaultSettings();
    const sources = [];
    const warnings = [];
    const userFile = userConfigPath(env);
    const user = await readJsonFile(userFile);
    if (user) {
        settings = merge(settings, user);
        sources.push(userFile);
    }
    if (repo) {
        const { allowed, ignored } = filterRepoConfig(repo.json);
        if (ignored.length) {
            warnings.push(`${repo.source}: ignoring ${ignored.join(', ')}. Repo config may only set ${exports.REPO_CONFIG_KEYS.join(', ')}; ` +
                `put server, credential and GitHub settings in ${userFile} or DIFF_LEPPARD_* variables.`);
        }
        settings = merge(settings, allowed);
        sources.push(repo.source);
    }
    settings = merge(settings, envSettings(env));
    settings = merge(settings, flags);
    const s = settings;
    validate(s);
    return { settings: s, sources, warnings };
}
