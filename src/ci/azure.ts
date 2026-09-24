import type { ResolvedConfig } from '../config.js';
import type { CiDiff } from './shared.js';
import { branchDiff, targetRef } from './shared.js';

/** Detect an Azure Pipelines pull-request or branch baseline. */
export function azureDiff(env: NodeJS.ProcessEnv, config: ResolvedConfig): CiDiff {
  const provider = 'azure';
  if (env.BUILD_REASON === 'PullRequest')
    return targetRef(provider, env.SYSTEM_PULLREQUEST_TARGETBRANCH, 'target-branch');
  if (env.BUILD_SOURCEBRANCH && !env.BUILD_SOURCEBRANCH.startsWith('refs/heads/')) {
    return { kind: 'unavailable', provider, reason: 'The build does not target a branch' };
  }

  return branchDiff(provider, env.BUILD_SOURCEBRANCH, config.defaultBranch ?? 'main');
}
