import { matchesGlob } from 'node:path';
import type { SystemOneRequest, TypeSafeClient } from '@typesafe-ai/sdk';
import createDebug from 'debug';
import type { Changes } from './git.js';
import type { TestDescriptor } from './selection.js';

const debug = createDebug('jev-playwright:config');

const defaultRelevanceGuidance =
  'Relevance includes direct effects and indirect effects via dependencies such as page objects or shared services.';
const defaultRelevanceCriteria = {
  true: 'May affect test setup, execution, or assertions.',
  false: 'No plausible effect on test setup, execution, or assertions.'
};

/** Jev context budgets used for conservative request sizing. */
export interface JevRequestLimits {
  /** State plus the longest question, in model tokens. @default 32000 */
  stateAndQuestionTokens?: number;
  /** State plus every question, in model tokens. @default 64000 */
  requestTokens?: number;
  /** Maximum calls across all diff chunks before running the full suite. @default 100 */
  maxRequests?: number;
  /** Maximum in-flight Jev calls across candidate batches and diff chunks. @default 5 */
  maxConcurrentRequests?: number;
}

/** Git diff presentation sent to Jev; changed-file detection is unaffected. */
export interface JevDiffConfig {
  /**
   * Whitespace changes Git ignores when creating the model patch.
   * `none` preserves whitespace changes; `all` ignores them (-w); `change` ignores
   * changes in whitespace amount (-b); `eol` ignores end-of-line whitespace changes.
   * Changed-file detection is unaffected.
   * @default 'all'
   */
  whitespace?: 'all' | 'change' | 'eol' | 'none';
  /** Omit hunks consisting solely of blank-line changes. @default false */
  ignoreBlankLines?: boolean;
  /** Unchanged lines shown around each hunk. @default 3 */
  contextLines?: number;
}

/** Options shared by the reporter and programmatic selector. Paths are relative to cwd. */
export interface JevPlaywrightConfig {
  /** Selection is opt-in; ordinary Playwright runs do not contact Jev. @default false */
  enabled?: boolean;
  /** Git revision compared to HEAD via merge-base; also reads BASE_REF. @default undefined (local changes) */
  baseRef?: string;
  /** Default branch name for CI detection, when the provider cannot supply one. @default 'main' */
  defaultBranch?: string;
  /** Project directory containing the git repository. @default process.cwd() */
  cwd?: string;
  /** Only these changed paths are sent to Jev. @default ['**\/*'] */
  include?: string[];
  /** Changed paths excluded from context; exclusions take precedence. @default [] */
  exclude?: string[];
  /** Exclude paths marked `linguist-generated` in git attributes from model context. @default true */
  excludeGeneratedFiles?: boolean;
  /** How git formats the patch sent to Jev. @default { whitespace: 'all', ignoreBlankLines: false, contextLines: 3 } */
  diff?: JevDiffConfig;
  /** Select tests at or above this yes probability. @default 0.55 */
  threshold?: number;
  /** Model input budgets; change these when using a provider with different limits. @default TypeSafe Jev limits */
  limits?: JevRequestLimits;
  /** Send each test callback body and leading comments to Jev. @default true */
  includeTestSource?: boolean;
  /** Maximum JavaScript lexical tokens per test when enabled. @default 5000 */
  maxTestSourceTokens?: number;
  /** Judge the same test separately per Playwright project/browser. @default false */
  perProject?: boolean;
  /** Shared guidance sent once in the model state for each request. @default 'Relevance includes direct effects and indirect effects via dependencies such as page objects or shared services.' */
  relevanceGuidance?: string;
  /** Per-test yes/no meanings; either outcome can be overridden. @default { true: 'May affect test setup, execution, or assertions.', false: 'No plausible effect on test setup, execution, or assertions.' } */
  relevanceCriteria?: { true?: string; false?: string };
  /** Pin this model when tuning a threshold. @default 'jev-latest' */
  model?: string;
  /** SDK API root for custom providers. @default TypeSafe SDK base URL */
  providerUrl?: string;
  /** SDK bearer token for custom providers. @default TypeSafe SDK environment key */
  providerKey?: string;
  /** Optional PR title. @default undefined */
  prTitle?: string;
  /** Optional PR description. @default undefined */
  prDescription?: string;
  /** Custom SDK authentication, base URL, or transport. @default new TypeSafeClient() */
  client?: Pick<TypeSafeClient, 'systemOne'>;
  /** Customize each typed relevance question before it is sent. @default defaultQuestion */
  createQuestion?: (test: TestDescriptor, key: string) => string;
  /** Adjust model state or questions before each batch; a complete answer is still required. @default undefined */
  beforeRequest?: (
    request: SystemOneRequest,
    context: { changes: Changes; tests: TestDescriptor[] }
  ) => SystemOneRequest | Promise<SystemOneRequest>;
}

/** Validated options with environment overrides applied. */
export interface ResolvedConfig
  extends Required<
    Omit<
      JevPlaywrightConfig,
      | 'baseRef'
      | 'defaultBranch'
      | 'prTitle'
      | 'prDescription'
      | 'providerUrl'
      | 'providerKey'
      | 'limits'
      | 'diff'
      | 'relevanceCriteria'
      | 'client'
      | 'createQuestion'
      | 'beforeRequest'
    >
  > {
  baseRef: string | undefined;
  defaultBranch: string | undefined;
  prTitle: string | undefined;
  prDescription: string | undefined;
  providerUrl: string | undefined;
  providerKey: string | undefined;
  limits: Required<JevRequestLimits>;
  diff: Required<JevDiffConfig>;
  relevanceCriteria: { true: string; false: string };
  client: JevPlaywrightConfig['client'];
  createQuestion: JevPlaywrightConfig['createQuestion'];
  beforeRequest: JevPlaywrightConfig['beforeRequest'];
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return env[`JEV_PLAYWRIGHT_${key}`];
}

function parseBoolean(raw: string | undefined, key: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${key} must be true, false, 1 or 0`);
}

function parseNumber(raw: string | undefined, key: string): number | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim() === '' || !Number.isFinite(Number(raw)))
    throw new Error(`${key} must be a number`);
  return Number(raw);
}

function parseWhitespace(raw: string | undefined): JevDiffConfig['whitespace'] {
  if (raw === undefined || raw === 'all' || raw === 'change' || raw === 'eol' || raw === 'none') {
    return raw;
  }
  throw new Error('JEV_PLAYWRIGHT_DIFF_WHITESPACE must be all, change, eol, or none');
}

function parseGlobs(raw: string | undefined, key: string): string[] | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${key} must be a JSON array of glob strings`, { cause: error });
  }
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string' && item.length > 0)
  ) {
    throw new Error(`${key} must be a JSON array of glob strings`);
  }
  return value as string[];
}

function validateConfig(config: ResolvedConfig): ResolvedConfig {
  if (
    typeof config.relevanceGuidance !== 'string' ||
    !config.relevanceGuidance.trim() ||
    typeof config.relevanceCriteria.true !== 'string' ||
    !config.relevanceCriteria.true.trim() ||
    typeof config.relevanceCriteria.false !== 'string' ||
    !config.relevanceCriteria.false.trim()
  ) {
    throw new Error('relevanceGuidance and relevanceCriteria must be non-empty strings');
  }
  if (!['all', 'change', 'eol', 'none'].includes(config.diff.whitespace)) {
    throw new Error('diff.whitespace must be all, change, eol, or none');
  }
  if (typeof config.diff.ignoreBlankLines !== 'boolean') {
    throw new Error('diff.ignoreBlankLines must be a boolean');
  }
  if (
    !Number.isInteger(config.diff.contextLines) ||
    config.diff.contextLines < 0 ||
    config.diff.contextLines > 20
  ) {
    throw new Error('diff.contextLines must be an integer from 0 to 20');
  }
  if (config.threshold < 0 || config.threshold > 1 || !Number.isFinite(config.threshold)) {
    throw new Error('threshold must be between 0 and 1');
  }
  if (
    !Number.isSafeInteger(config.limits.stateAndQuestionTokens) ||
    config.limits.stateAndQuestionTokens < 1 ||
    !Number.isSafeInteger(config.limits.requestTokens) ||
    config.limits.requestTokens < 1 ||
    !Number.isSafeInteger(config.limits.maxRequests) ||
    config.limits.maxRequests < 1 ||
    !Number.isSafeInteger(config.limits.maxConcurrentRequests) ||
    config.limits.maxConcurrentRequests < 1
  ) {
    throw new Error('limits must be positive integer token budgets');
  }
  if (
    !Number.isInteger(config.maxTestSourceTokens) ||
    config.maxTestSourceTokens < 1 ||
    config.maxTestSourceTokens > 5000
  ) {
    throw new Error('maxTestSourceTokens must be an integer from 1 to 5000');
  }
  if ([...config.include, ...config.exclude].some((glob) => !glob))
    throw new Error('Glob patterns cannot be empty');
  if (!config.cwd || !config.model) throw new Error('cwd and model cannot be empty');
  return config;
}

/** Resolve JEV_PLAYWRIGHT_* variables before config values, then defaults. */
export function resolveConfig(
  config: JevPlaywrightConfig = {},
  env: NodeJS.ProcessEnv = process.env
): ResolvedConfig {
  const resolved = validateConfig({
    enabled:
      parseBoolean(readEnv(env, 'ENABLED'), 'JEV_PLAYWRIGHT_ENABLED') ?? config.enabled ?? false,
    baseRef: readEnv(env, 'BASE_REF') ?? env.BASE_REF ?? config.baseRef,
    defaultBranch: readEnv(env, 'DEFAULT_BRANCH') ?? config.defaultBranch,
    cwd: readEnv(env, 'CWD') ?? config.cwd ?? process.cwd(),
    include: parseGlobs(readEnv(env, 'INCLUDE'), 'JEV_PLAYWRIGHT_INCLUDE') ??
      config.include ?? ['**/*'],
    exclude: parseGlobs(readEnv(env, 'EXCLUDE'), 'JEV_PLAYWRIGHT_EXCLUDE') ?? config.exclude ?? [],
    excludeGeneratedFiles:
      parseBoolean(
        readEnv(env, 'EXCLUDE_GENERATED_FILES'),
        'JEV_PLAYWRIGHT_EXCLUDE_GENERATED_FILES'
      ) ??
      config.excludeGeneratedFiles ??
      true,
    diff: {
      whitespace:
        parseWhitespace(readEnv(env, 'DIFF_WHITESPACE')) ?? config.diff?.whitespace ?? 'all',
      ignoreBlankLines:
        parseBoolean(
          readEnv(env, 'DIFF_IGNORE_BLANK_LINES'),
          'JEV_PLAYWRIGHT_DIFF_IGNORE_BLANK_LINES'
        ) ??
        config.diff?.ignoreBlankLines ??
        false,
      contextLines:
        parseNumber(readEnv(env, 'DIFF_CONTEXT_LINES'), 'JEV_PLAYWRIGHT_DIFF_CONTEXT_LINES') ??
        config.diff?.contextLines ??
        3
    },
    threshold:
      parseNumber(readEnv(env, 'THRESHOLD'), 'JEV_PLAYWRIGHT_THRESHOLD') ??
      config.threshold ??
      0.55,
    limits: {
      stateAndQuestionTokens:
        parseNumber(
          readEnv(env, 'LIMITS_STATE_AND_QUESTION_TOKENS'),
          'JEV_PLAYWRIGHT_LIMITS_STATE_AND_QUESTION_TOKENS'
        ) ??
        config.limits?.stateAndQuestionTokens ??
        32_000,
      requestTokens:
        parseNumber(
          readEnv(env, 'LIMITS_REQUEST_TOKENS'),
          'JEV_PLAYWRIGHT_LIMITS_REQUEST_TOKENS'
        ) ??
        config.limits?.requestTokens ??
        64_000,
      maxRequests:
        parseNumber(readEnv(env, 'LIMITS_MAX_REQUESTS'), 'JEV_PLAYWRIGHT_LIMITS_MAX_REQUESTS') ??
        config.limits?.maxRequests ??
        100,
      maxConcurrentRequests:
        parseNumber(
          readEnv(env, 'LIMITS_MAX_CONCURRENT_REQUESTS'),
          'JEV_PLAYWRIGHT_LIMITS_MAX_CONCURRENT_REQUESTS'
        ) ??
        config.limits?.maxConcurrentRequests ??
        5
    },
    includeTestSource:
      parseBoolean(readEnv(env, 'INCLUDE_TEST_SOURCE'), 'JEV_PLAYWRIGHT_INCLUDE_TEST_SOURCE') ??
      config.includeTestSource ??
      true,
    maxTestSourceTokens:
      parseNumber(
        readEnv(env, 'MAX_TEST_SOURCE_TOKENS'),
        'JEV_PLAYWRIGHT_MAX_TEST_SOURCE_TOKENS'
      ) ??
      config.maxTestSourceTokens ??
      5000,
    perProject:
      parseBoolean(readEnv(env, 'PER_PROJECT'), 'JEV_PLAYWRIGHT_PER_PROJECT') ??
      config.perProject ??
      false,
    relevanceGuidance: config.relevanceGuidance ?? defaultRelevanceGuidance,
    relevanceCriteria: { ...defaultRelevanceCriteria, ...config.relevanceCriteria },
    model: readEnv(env, 'MODEL') ?? config.model ?? 'jev-latest',
    providerUrl: readEnv(env, 'PROVIDER_URL') ?? config.providerUrl,
    providerKey: readEnv(env, 'PROVIDER_KEY') ?? config.providerKey,
    prTitle: readEnv(env, 'PR_TITLE') ?? config.prTitle,
    prDescription: readEnv(env, 'PR_DESCRIPTION') ?? config.prDescription,
    client: config.client,
    createQuestion: config.createQuestion,
    beforeRequest: config.beforeRequest
  });
  if (debug.enabled) {
    debug('resolved config %O', {
      ...resolved,
      providerKey: resolved.providerKey ? '[redacted]' : undefined,
      client: resolved.client ? '[configured client]' : undefined
    });
  }
  return resolved;
}

/** Filter changed paths before building model context. */
export function filterPaths(paths: string[], config: ResolvedConfig): string[] {
  return paths.filter((path) => {
    const normalized = path.replaceAll('\\', '/');
    return (
      config.include.some((glob) => glob === '**/*' || matchesGlob(normalized, glob)) &&
      !config.exclude.some((glob) => matchesGlob(normalized, glob))
    );
  });
}
