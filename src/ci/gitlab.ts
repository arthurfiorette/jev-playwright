import type { ResolvedConfig } from '../config.js';
import type { CiDiff } from './shared.js';
import { branchDiff, targetRef } from './shared.js';

/** Detect a GitLab merge-request or branch-push baseline. */
export function gitlabDiff(env: NodeJS.ProcessEnv, config: ResolvedConfig): CiDiff {
  const provider = 'gitlab';
  if (env.CI_MERGE_REQUEST_IID)
    return targetRef(provider, env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME, 'target-branch');
  if (env.CI_COMMIT_TAG)
    return { kind: 'unavailable', provider, reason: 'Tag pipelines have no branch baseline' };

  const before = env.CI_PIPELINE_SOURCE === 'push' ? env.CI_COMMIT_BEFORE_SHA : undefined;
  return branchDiff(
    provider,
    env.CI_COMMIT_BRANCH,
    config.defaultBranch ?? env.CI_DEFAULT_BRANCH ?? 'main',
    before
  );
}
