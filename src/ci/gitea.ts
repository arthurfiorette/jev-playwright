import type { ResolvedConfig } from '../config.js';
import { actionsDiff } from './actions.js';
import type { CiDiff } from './shared.js';

/** Detect a Gitea Actions push or pull-request baseline using its GitHub-compatible variables. */
export function giteaDiff(env: NodeJS.ProcessEnv, config: ResolvedConfig): Promise<CiDiff> {
  return actionsDiff('gitea', env, config);
}
