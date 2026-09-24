import type { ResolvedConfig } from '../config.js';
import type { CiDiff } from './shared.js';
import { branchDiff, targetRef } from './shared.js';

/** Detect a Bitbucket Pipelines pull-request or branch baseline. */
export function bitbucketDiff(env: NodeJS.ProcessEnv, config: ResolvedConfig): CiDiff {
  const provider = 'bitbucket';
  if (env.BITBUCKET_PR_ID)
    return targetRef(provider, env.BITBUCKET_PR_DESTINATION_BRANCH, 'target-branch');
  if (env.BITBUCKET_TAG)
    return { kind: 'unavailable', provider, reason: 'Tag pipelines have no branch baseline' };

  return branchDiff(provider, env.BITBUCKET_BRANCH, config.defaultBranch ?? 'main');
}
