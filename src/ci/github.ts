import type { ResolvedConfig } from '../config.js';
import { actionsDiff } from './actions.js';
import type { CiDiff } from './shared.js';

/** Detect a GitHub Actions push or pull-request baseline. */
export function githubDiff(env: NodeJS.ProcessEnv, config: ResolvedConfig): Promise<CiDiff> {
  return actionsDiff('github', env, config);
}
