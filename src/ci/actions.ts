import { readFile, stat } from 'node:fs/promises';
import type { ResolvedConfig } from '../config.js';
import type { CiDiff } from './shared.js';
import { branchDiff, targetRef } from './shared.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordField(value: unknown, field: string): Record<string, unknown> | undefined {
  return asRecord(asRecord(value)?.[field]);
}

function stringField(value: unknown, field: string): string | undefined {
  const entry = asRecord(value)?.[field];
  return typeof entry === 'string' && entry.length > 0 ? entry : undefined;
}

async function readActionsEvent(env: NodeJS.ProcessEnv): Promise<unknown> {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) return undefined;

  try {
    if ((await stat(path)).size > 1_000_000) return undefined;
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    // A missing or malformed event payload must never turn into a guessed diff.
    return undefined;
  }
}

/** Use the Actions-compatible event context shared by GitHub and Gitea. */
export async function actionsDiff(
  provider: 'github' | 'gitea',
  env: NodeJS.ProcessEnv,
  config: ResolvedConfig
): Promise<CiDiff> {
  const event = await readActionsEvent(env);
  const repository = recordField(event, 'repository');
  const defaultBranch = config.defaultBranch ?? stringField(repository, 'default_branch') ?? 'main';
  const eventName = env.GITHUB_EVENT_NAME;

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const target =
      env.GITHUB_BASE_REF ??
      stringField(recordField(recordField(event, 'pull_request'), 'base'), 'ref');
    return targetRef(provider, target, 'target-branch');
  }

  if (env.GITHUB_REF && !env.GITHUB_REF.startsWith('refs/heads/')) {
    return { kind: 'unavailable', provider, reason: 'The event does not target a branch' };
  }

  const branch =
    env.GITHUB_REF?.replace(/^refs\/heads\//, '') ??
    (env.GITHUB_REF_TYPE === 'branch' ? env.GITHUB_REF_NAME : undefined);
  const before = eventName === 'push' ? stringField(event, 'before') : undefined;
  return branchDiff(provider, branch, defaultBranch, before);
}
