import { azureDiff } from './ci/azure.js';
import { bitbucketDiff } from './ci/bitbucket.js';
import { giteaDiff } from './ci/gitea.js';
import { githubDiff } from './ci/github.js';
import { gitlabDiff } from './ci/gitlab.js';
import type { CiDiff, CiProvider } from './ci/shared.js';
import type { ResolvedConfig } from './config.js';

export type { CiDiff, CiProvider } from './ci/shared.js';

function providerFrom(env: NodeJS.ProcessEnv): CiProvider | undefined {
  if (env.GITEA_ACTIONS === 'true') return 'gitea';
  if (env.GITHUB_ACTIONS === 'true') return 'github';
  if (env.GITLAB_CI === 'true') return 'gitlab';
  if (env.BITBUCKET_BUILD_NUMBER) return 'bitbucket';
  if (env.TF_BUILD?.toLowerCase() === 'true') return 'azure';
  return undefined;
}

/** Choose a CI diff baseline without network access; explicit base refs bypass detection. */
export async function detectCiDiff(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<CiDiff> {
  if (config.baseRef !== undefined) {
    return { kind: 'ref', provider: 'explicit', baseRef: config.baseRef, source: 'explicit' };
  }

  const provider = providerFrom(env);
  if (!provider) {
    return env.CI === 'true' || env.CI === '1'
      ? { kind: 'unavailable', provider: 'unknown', reason: 'Unrecognized CI provider' }
      : { kind: 'local' };
  }

  switch (provider) {
    case 'github':
      return githubDiff(env, config);
    case 'gitea':
      return giteaDiff(env, config);
    case 'gitlab':
      return gitlabDiff(env, config);
    case 'bitbucket':
      return bitbucketDiff(env, config);
    case 'azure':
      return azureDiff(env, config);
  }
}
