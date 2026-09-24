import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectCiDiff } from '../src/ci.js';
import { resolveConfig } from '../src/config.js';

const previous = 'a'.repeat(40);

test('GitHub and Gitea use the push event before SHA on main', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'jev-ci-'));
  const eventPath = join(cwd, 'event.json');

  try {
    await writeFile(
      eventPath,
      JSON.stringify({
        before: previous,
        repository: { default_branch: 'trunk' },
        pull_request: { base: { ref: 'release' } }
      })
    );

    for (const providerEnv of [
      { GITHUB_ACTIONS: 'true' },
      { GITEA_ACTIONS: 'true', GITHUB_ACTIONS: 'true' }
    ]) {
      const env = {
        ...providerEnv,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/trunk',
        GITHUB_EVENT_PATH: eventPath
      };
      assert.deepEqual(await detectCiDiff(resolveConfig({}, env), env), {
        kind: 'ref',
        provider: providerEnv.GITEA_ACTIONS ? 'gitea' : 'github',
        baseRef: previous,
        source: 'previous-push'
      });
      const pr = {
        ...env,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_BASE_REF: 'release',
        GITHUB_REF: 'refs/pull/3/merge'
      };
      assert.deepEqual(await detectCiDiff(resolveConfig({}, pr), pr), {
        kind: 'ref',
        provider: providerEnv.GITEA_ACTIONS ? 'gitea' : 'github',
        baseRef: 'refs/remotes/origin/release',
        source: 'target-branch'
      });

      const branch = { ...env, GITHUB_REF: 'refs/heads/feature/login' };
      assert.deepEqual(await detectCiDiff(resolveConfig({}, branch), branch), {
        kind: 'ref',
        provider: providerEnv.GITEA_ACTIONS ? 'gitea' : 'github',
        baseRef: 'refs/remotes/origin/trunk',
        source: 'default-branch'
      });
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('GitLab detects merge requests, feature branches, main pushes, and unknown previous SHAs', async () => {
  const merge = {
    GITLAB_CI: 'true',
    CI_MERGE_REQUEST_IID: '17',
    CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'release/v2'
  };
  assert.deepEqual(await detectCiDiff(resolveConfig({}, merge), merge), {
    kind: 'ref',
    provider: 'gitlab',
    baseRef: 'refs/remotes/origin/release/v2',
    source: 'target-branch'
  });

  const branch = {
    GITLAB_CI: 'true',
    CI_COMMIT_BRANCH: 'feature/search',
    CI_DEFAULT_BRANCH: 'trunk'
  };
  assert.deepEqual(await detectCiDiff(resolveConfig({}, branch), branch), {
    kind: 'ref',
    provider: 'gitlab',
    baseRef: 'refs/remotes/origin/trunk',
    source: 'default-branch'
  });

  const main = {
    ...branch,
    CI_COMMIT_BRANCH: 'trunk',
    CI_PIPELINE_SOURCE: 'push',
    CI_COMMIT_BEFORE_SHA: previous
  };
  assert.deepEqual(await detectCiDiff(resolveConfig({}, main), main), {
    kind: 'ref',
    provider: 'gitlab',
    baseRef: previous,
    source: 'previous-push'
  });
  assert.equal(
    (
      await detectCiDiff(resolveConfig({}, { ...main, CI_COMMIT_BEFORE_SHA: '0'.repeat(40) }), {
        ...main,
        CI_COMMIT_BEFORE_SHA: '0'.repeat(40)
      })
    ).kind,
    'unavailable'
  );
});

test('Bitbucket and Azure use PR target or default branch but do not guess the previous main push', async () => {
  const bitbucket = { BITBUCKET_BUILD_NUMBER: '12', BITBUCKET_BRANCH: 'main' };
  assert.equal((await detectCiDiff(resolveConfig({}, bitbucket), bitbucket)).kind, 'unavailable');
  const bbPr = { ...bitbucket, BITBUCKET_PR_ID: '7', BITBUCKET_PR_DESTINATION_BRANCH: 'develop' };
  assert.deepEqual(await detectCiDiff(resolveConfig({}, bbPr), bbPr), {
    kind: 'ref',
    provider: 'bitbucket',
    baseRef: 'refs/remotes/origin/develop',
    source: 'target-branch'
  });

  const bbBranch = { ...bitbucket, BITBUCKET_BRANCH: 'feature/login' };
  assert.deepEqual(
    await detectCiDiff(resolveConfig({ defaultBranch: 'trunk' }, bbBranch), bbBranch),
    {
      kind: 'ref',
      provider: 'bitbucket',
      baseRef: 'refs/remotes/origin/trunk',
      source: 'default-branch'
    }
  );

  const azure = { TF_BUILD: 'True', BUILD_SOURCEBRANCH: 'refs/heads/feature/x' };
  assert.deepEqual(await detectCiDiff(resolveConfig({}, azure), azure), {
    kind: 'ref',
    provider: 'azure',
    baseRef: 'refs/remotes/origin/main',
    source: 'default-branch'
  });
  const azPr = {
    ...azure,
    BUILD_REASON: 'PullRequest',
    SYSTEM_PULLREQUEST_TARGETBRANCH: 'refs/heads/release'
  };
  assert.deepEqual(await detectCiDiff(resolveConfig({}, azPr), azPr), {
    kind: 'ref',
    provider: 'azure',
    baseRef: 'refs/remotes/origin/release',
    source: 'target-branch'
  });

  const azMain = { ...azure, BUILD_SOURCEBRANCH: 'refs/heads/main' };
  assert.equal((await detectCiDiff(resolveConfig({}, azMain), azMain)).kind, 'unavailable');
});

test('explicit refs bypass CI detection and local runs retain working tree behavior', async () => {
  const ci = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' };
  const overridden = resolveConfig({ baseRef: 'release', defaultBranch: 'trunk' }, ci);
  assert.deepEqual(await detectCiDiff(overridden, ci), {
    kind: 'ref',
    provider: 'explicit',
    baseRef: 'release',
    source: 'explicit'
  });
  const envRef = { ...ci, BASE_REF: 'refs/heads/custom' };
  assert.deepEqual(await detectCiDiff(resolveConfig({}, envRef), envRef), {
    kind: 'ref',
    provider: 'explicit',
    baseRef: 'refs/heads/custom',
    source: 'explicit'
  });
  assert.deepEqual(await detectCiDiff(resolveConfig({}, {}), {}), { kind: 'local' });
  assert.equal(
    (await detectCiDiff(resolveConfig({}, { CI: 'true' }), { CI: 'true' })).kind,
    'unavailable'
  );
  assert.equal((await detectCiDiff(resolveConfig({}, ci), ci)).kind, 'unavailable');
});

test('available CI PR and commit text is carried as optional selection hints', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'jev-ci-hints-'));
  const eventPath = join(cwd, 'event.json');

  try {
    await writeFile(
      eventPath,
      JSON.stringify({
        repository: { default_branch: 'main' },
        pull_request: {
          base: { ref: 'main' },
          title: 'Fix checkout redirects',
          body: 'Update mobile checkout coverage'
        }
      })
    );
    const github = {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_BASE_REF: 'main',
      GITHUB_EVENT_PATH: eventPath
    };
    assert.deepEqual(await detectCiDiff(resolveConfig({}, github), github), {
      kind: 'ref',
      provider: 'github',
      baseRef: 'refs/remotes/origin/main',
      source: 'target-branch',
      title: 'Fix checkout redirects',
      description: 'Update mobile checkout coverage'
    });

    const gitlab = {
      GITLAB_CI: 'true',
      CI_MERGE_REQUEST_IID: '2',
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'main',
      CI_MERGE_REQUEST_TITLE: 'Fix billing',
      CI_MERGE_REQUEST_DESCRIPTION: 'Covers refunds'
    };
    assert.deepEqual(await detectCiDiff(resolveConfig({}, gitlab), gitlab), {
      kind: 'ref',
      provider: 'gitlab',
      baseRef: 'refs/remotes/origin/main',
      source: 'target-branch',
      title: 'Fix billing',
      description: 'Covers refunds'
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
