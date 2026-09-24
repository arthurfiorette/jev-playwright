/** CI systems with built-in change-baseline detection. */
export type CiProvider = 'github' | 'gitea' | 'gitlab' | 'bitbucket' | 'azure';

/** The git baseline chosen for a CI run, or the reason it cannot be determined. */
export type CiDiff =
  | { kind: 'local' }
  | {
      kind: 'ref';
      provider: CiProvider | 'explicit';
      baseRef: string;
      source: 'explicit' | 'previous-push' | 'target-branch' | 'default-branch';
    }
  | { kind: 'unavailable'; provider: CiProvider | 'unknown'; reason: string };

function branchName(value: string | undefined): string | undefined {
  const name = value?.replace(/^refs\/heads\//, '');
  if (
    !name ||
    !/^[\w./-]+$/.test(name) ||
    name.startsWith('-') ||
    name.includes('..') ||
    name.includes('//')
  ) {
    return undefined;
  }
  return name;
}

function previousSha(value: string | undefined): string | undefined {
  return value && /^[0-9a-f]{40,64}$/i.test(value) && !/^0+$/.test(value) ? value : undefined;
}

/** Prefer a checked-out remote-tracking branch for merge-base comparisons. */
export function targetRef(
  provider: CiProvider,
  branch: string | undefined,
  source: 'target-branch' | 'default-branch'
): CiDiff {
  const target = branchName(branch);
  if (!target) return { kind: 'unavailable', provider, reason: `Missing ${source} name` };
  return { kind: 'ref', provider, baseRef: `refs/remotes/origin/${target}`, source };
}

/** Compare feature branches against the default branch, and default-branch pushes against their previous tip. */
export function branchDiff(
  provider: CiProvider,
  branch: string | undefined,
  defaultBranch: string,
  before?: string
): CiDiff {
  const current = branchName(branch);
  const main = branchName(defaultBranch);
  if (!current || !main)
    return { kind: 'unavailable', provider, reason: 'Cannot identify the branch' };
  if (current !== main) return targetRef(provider, main, 'default-branch');

  const previous = previousSha(before);
  if (!previous)
    return { kind: 'unavailable', provider, reason: 'No previous push SHA on the default branch' };
  return { kind: 'ref', provider, baseRef: previous, source: 'previous-push' };
}
