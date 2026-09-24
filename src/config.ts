import { matchesGlob } from 'node:path';
import type { SystemOneRequest, TypeSafeClient } from '@typesafe-ai/sdk';
import type { Changes } from './git.js';
import type { TestDescriptor } from './selection.js';

/** Options shared by the reporter and programmatic selector. Paths are relative to cwd. */
export interface JevPlaywrightConfig {
  /** Selection is opt-in; ordinary Playwright runs do not contact Jev. @default false */
  enabled?: boolean;
  /** Git revision compared to HEAD via merge-base; also reads BASE_REF. @default undefined (local changes) */
  baseRef?: string;
  /** Project directory containing the git repository. @default process.cwd() */
  cwd?: string;
  /** Only these changed paths are sent to Jev. @default ['**\/*'] */
  include?: string[];
  /** Changed paths excluded from context; exclusions take precedence. @default [] */
  exclude?: string[];
  /** Select tests at or above this yes probability. @default 0.5 */
  threshold?: number;
  /** Maximum tests per Jev request. @default 50 */
  batchSize?: number;
  /** Include a bounded source excerpt starting at each test declaration. @default false */
  includeTestSource?: boolean;
  /** Maximum JavaScript lexical tokens per test when enabled. @default 5000 */
  maxTestSourceTokens?: number;
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
      | 'prTitle'
      | 'prDescription'
      | 'providerUrl'
      | 'providerKey'
      | 'client'
      | 'createQuestion'
      | 'beforeRequest'
    >
  > {
  baseRef: string | undefined;
  prTitle: string | undefined;
  prDescription: string | undefined;
  providerUrl: string | undefined;
  providerKey: string | undefined;
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
  if (config.threshold < 0 || config.threshold > 1 || !Number.isFinite(config.threshold)) {
    throw new Error('threshold must be between 0 and 1');
  }
  if (!Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > 200) {
    throw new Error('batchSize must be an integer from 1 to 200');
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
  return validateConfig({
    enabled:
      parseBoolean(readEnv(env, 'ENABLED'), 'JEV_PLAYWRIGHT_ENABLED') ?? config.enabled ?? false,
    baseRef: readEnv(env, 'BASE_REF') ?? env.BASE_REF ?? config.baseRef,
    cwd: readEnv(env, 'CWD') ?? config.cwd ?? process.cwd(),
    include: parseGlobs(readEnv(env, 'INCLUDE'), 'JEV_PLAYWRIGHT_INCLUDE') ??
      config.include ?? ['**/*'],
    exclude: parseGlobs(readEnv(env, 'EXCLUDE'), 'JEV_PLAYWRIGHT_EXCLUDE') ?? config.exclude ?? [],
    threshold:
      parseNumber(readEnv(env, 'THRESHOLD'), 'JEV_PLAYWRIGHT_THRESHOLD') ?? config.threshold ?? 0.5,
    batchSize:
      parseNumber(readEnv(env, 'BATCH_SIZE'), 'JEV_PLAYWRIGHT_BATCH_SIZE') ??
      config.batchSize ??
      50,
    includeTestSource:
      parseBoolean(readEnv(env, 'INCLUDE_TEST_SOURCE'), 'JEV_PLAYWRIGHT_INCLUDE_TEST_SOURCE') ??
      config.includeTestSource ??
      false,
    maxTestSourceTokens:
      parseNumber(
        readEnv(env, 'MAX_TEST_SOURCE_TOKENS'),
        'JEV_PLAYWRIGHT_MAX_TEST_SOURCE_TOKENS'
      ) ??
      config.maxTestSourceTokens ??
      5000,
    model: readEnv(env, 'MODEL') ?? config.model ?? 'jev-latest',
    providerUrl: readEnv(env, 'PROVIDER_URL') ?? config.providerUrl,
    providerKey: readEnv(env, 'PROVIDER_KEY') ?? config.providerKey,
    prTitle: readEnv(env, 'PR_TITLE') ?? config.prTitle,
    prDescription: readEnv(env, 'PR_DESCRIPTION') ?? config.prDescription,
    client: config.client,
    createQuestion: config.createQuestion,
    beforeRequest: config.beforeRequest
  });
}

/** Filter changed paths before building model context. */
export function filterPaths(paths: string[], config: ResolvedConfig): string[] {
  return paths.filter((path) => {
    const normalized = path.replaceAll('\\', '/');
    return (
      config.include.some((glob) => matchesGlob(normalized, glob)) &&
      !config.exclude.some((glob) => matchesGlob(normalized, glob))
    );
  });
}
