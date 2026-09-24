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
    const pullRequest = recordField(event, 'pull_request');
    const target = env.GITHUB_BASE_REF ?? stringField(recordField(pullRequest, 'base'), 'ref');
    const baseline = targetRef(provider, target, 'target-branch');
    if (baseline.kind !== 'ref') return baseline;
    const title = stringField(pullRequest, 'title');
    const description = stringField(pullRequest, 'body');
    return {
      ...baseline,
      ...(title ? { title } : {}),
      ...(description ? { description } : {})
    };
  }

  if (env.GITHUB_REF && !env.GITHUB_REF.startsWith('refs/heads/')) {
    return { kind: 'unavailable', provider, reason: 'The event does not target a branch' };
  }

  const branch =
    env.GITHUB_REF?.replace(/^refs\/heads\//, '') ??
    (env.GITHUB_REF_TYPE === 'branch' ? env.GITHUB_REF_NAME : undefined);
  const before = eventName === 'push' ? stringField(event, 'before') : undefined;
  const baseline = branchDiff(provider, branch, defaultBranch, before);
  if (baseline.kind !== 'ref') return baseline;

  const message = stringField(recordField(event, 'head_commit'), 'message');
  if (!message) return baseline;
  const [title, ...body] = message.split('\n');
  return {
    ...baseline,
    ...(title ? { title } : {}),
    ...(body.length ? { description: body.join('\n') } : {})
  };
}
