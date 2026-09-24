import type { ResolvedConfig } from '../config.js';
import type { CiDiff } from './shared.js';
import { branchDiff, targetRef } from './shared.js';

/** Detect a GitLab merge-request or branch-push baseline. */
export function gitlabDiff(env: NodeJS.ProcessEnv, config: ResolvedConfig): CiDiff {
  const provider = 'gitlab';
  if (env.CI_MERGE_REQUEST_IID) {
    const baseline = targetRef(provider, env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME, 'target-branch');
    if (baseline.kind !== 'ref') return baseline;
    return {
      ...baseline,
      ...(env.CI_MERGE_REQUEST_TITLE ? { title: env.CI_MERGE_REQUEST_TITLE } : {}),
      ...(env.CI_MERGE_REQUEST_DESCRIPTION ? { description: env.CI_MERGE_REQUEST_DESCRIPTION } : {})
    };
  }
  if (env.CI_COMMIT_TAG)
    return { kind: 'unavailable', provider, reason: 'Tag pipelines have no branch baseline' };

  const before = env.CI_PIPELINE_SOURCE === 'push' ? env.CI_COMMIT_BEFORE_SHA : undefined;
  const baseline = branchDiff(
    provider,
    env.CI_COMMIT_BRANCH,
    config.defaultBranch ?? env.CI_DEFAULT_BRANCH ?? 'main',
    before
  );
  if (baseline.kind !== 'ref') return baseline;
  return {
    ...baseline,
    ...(env.CI_COMMIT_TITLE ? { title: env.CI_COMMIT_TITLE } : {}),
    ...(env.CI_COMMIT_DESCRIPTION ? { description: env.CI_COMMIT_DESCRIPTION } : {})
  };
}
