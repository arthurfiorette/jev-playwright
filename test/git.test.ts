import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveConfig } from '../src/config.js';
import { getCommitMessage, getGitChanges } from '../src/git.js';

function runGit(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd });
}

function commit(cwd: string, message: string, body?: string): void {
  runGit(cwd, 'add', '.');
  runGit(
    cwd,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qm',
    message,
    ...(body ? ['-m', body] : [])
  );
}

test('git adapter reads local changes and filters model diff without losing file inventory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'jev-playwright-'));

  try {
    runGit(cwd, 'init', '-q');
    await writeFile(join(cwd, 'included.ts'), 'before\n');
    await writeFile(join(cwd, 'ignored.txt'), 'before\n');
    commit(cwd, 'initial');

    await writeFile(join(cwd, 'included.ts'), 'after\n');
    await writeFile(join(cwd, 'ignored.txt'), 'private-data\n');
    const changes = await getGitChanges(
      cwd,
      undefined,
      resolveConfig({ cwd, include: ['*.ts'] }, {})
    );

    assert.deepEqual(changes.files.sort(), ['ignored.txt', 'included.ts']);
    assert.match(changes.diff ?? '', /after/);
    assert.doesNotMatch(changes.diff ?? '', /private-data/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('CI baseline includes every commit in a multi-commit push or branch', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'jev-ci-diff-'));

  try {
    runGit(cwd, 'init', '-q');
    await writeFile(join(cwd, 'initial.ts'), 'before\n');
    commit(cwd, 'initial');
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    runGit(cwd, 'update-ref', 'refs/remotes/origin/main', before);

    await writeFile(join(cwd, 'first.ts'), 'first\n');
    commit(cwd, 'first');
    await writeFile(join(cwd, 'second.ts'), 'second\n');
    commit(cwd, 'second');

    const config = resolveConfig({ cwd }, {});
    const push = await getGitChanges(cwd, before, config);
    const branch = await getGitChanges(cwd, 'refs/remotes/origin/main', config);
    assert.deepEqual(push.files.sort(), ['first.ts', 'second.ts']);
    assert.deepEqual(branch.files.sort(), push.files);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('diff presentation can hide whitespace and blank lines without hiding changed files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'jev-whitespace-'));

  try {
    runGit(cwd, 'init', '-q');
    await writeFile(join(cwd, 'style.ts'), 'const value=1;\n');
    commit(cwd, 'initial');
    await writeFile(join(cwd, 'style.ts'), 'const value = 1;\n\n');

    const compact = await getGitChanges(
      cwd,
      undefined,
      resolveConfig({ cwd, diff: { ignoreBlankLines: true } }, {})
    );
    assert.deepEqual(compact.files, ['style.ts']);
    assert.equal(compact.diff?.trim(), '');

    const full = await getGitChanges(
      cwd,
      undefined,
      resolveConfig({ cwd, diff: { whitespace: 'none', contextLines: 0 } }, {})
    );
    assert.match(full.diff ?? '', /const value = 1/);
    assert.match(full.diff ?? '', /@@/);
    assert.match(full.patches?.[0] ?? '', /\+\n$/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('untracked file budget follows configured provider limits', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'jev-untracked-'));

  try {
    runGit(cwd, 'init', '-q');
    await writeFile(join(cwd, 'large.ts'), 'x'.repeat(33_000));

    await assert.rejects(
      getGitChanges(cwd, undefined, resolveConfig({ cwd }, {})),
      /Cannot safely include untracked file/
    );

    const config = resolveConfig(
      {
        cwd,
        limits: { stateAndQuestionTokens: 50_000, requestTokens: 100_000 }
      },
      {}
    );
    const changes = await getGitChanges(cwd, undefined, config);
    assert.deepEqual(changes.files, ['large.ts']);
    assert.ok((changes.diff?.length ?? 0) > 33_000);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('changed spec remains in the inventory but is excluded from model patches and statuses', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'jev-spec-change-'));

  try {
    runGit(cwd, 'init', '-q');
    await writeFile(join(cwd, 'checkout.spec.ts'), 'test("checkout", () => {});\n');
    await writeFile(join(cwd, 'app.ts'), 'export const value = 1;\n');
    commit(cwd, 'initial');

    await writeFile(join(cwd, 'checkout.spec.ts'), 'test("updated checkout", () => {});\n');
    await writeFile(join(cwd, 'app.ts'), 'export const value = 2;\n');
    const changes = await getGitChanges(cwd, undefined, resolveConfig({ cwd }, {}), [
      join(cwd, 'checkout.spec.ts')
    ]);

    assert.deepEqual(changes.files.sort(), ['app.ts', 'checkout.spec.ts']);
    assert.deepEqual(
      changes.statuses?.map((entry) => `${entry.status} ${entry.path}`),
      ['M app.ts']
    );
    assert.equal(changes.patches?.length, 1);
    assert.doesNotMatch(changes.diff ?? '', /updated checkout/);
    assert.match(changes.diff ?? '', /value = 2/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('git name-status retains the source and destination of renamed files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'jev-renamed-'));

  try {
    runGit(cwd, 'init', '-q');
    await writeFile(join(cwd, 'old.ts'), 'export const checkout = true;\n');
    commit(cwd, 'initial');
    await rename(join(cwd, 'old.ts'), join(cwd, 'new.ts'));
    runGit(cwd, 'add', '-A');

    const changes = await getGitChanges(cwd, undefined, resolveConfig({ cwd }, {}));
    assert.deepEqual(await getCommitMessage(cwd), { title: 'initial' });
    assert.deepEqual(changes.files, ['new.ts']);
    assert.deepEqual(changes.statuses, [
      { status: 'R100', previousPath: 'old.ts', path: 'new.ts' }
    ]);
    assert.equal(changes.patches?.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('git paths and patch pathspecs stay root-relative from a nested Playwright cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-nested-'));
  const cwd = join(root, 'e2e');

  try {
    await mkdir(cwd);
    runGit(root, 'init', '-q');
    await writeFile(join(root, 'app.ts'), 'export const value = 1;\n');
    await writeFile(join(cwd, 'checkout.spec.ts'), 'test("checkout", () => {});\n');
    commit(root, 'initial');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    await writeFile(join(root, 'app.ts'), 'export const value = 2;\n');
    await writeFile(join(cwd, 'checkout.spec.ts'), 'test("updated checkout", () => {});\n');
    const local = await getGitChanges(cwd, undefined, resolveConfig({ cwd }, {}), [
      join(cwd, 'checkout.spec.ts')
    ]);

    assert.equal(local.root, await realpath(root));
    assert.deepEqual(local.files.sort(), ['app.ts', 'e2e/checkout.spec.ts']);
    assert.deepEqual(
      local.statuses?.map((entry) => entry.path),
      ['app.ts']
    );
    assert.match(local.diff ?? '', /value = 2/);
    assert.doesNotMatch(local.diff ?? '', /updated checkout/);

    commit(root, 'change', 'Checkout now uses the updated value.');
    assert.deepEqual(await getCommitMessage(cwd), {
      title: 'change',
      description: 'Checkout now uses the updated value.'
    });
    const committed = await getGitChanges(cwd, base, resolveConfig({ cwd }, {}), [
      join(cwd, 'checkout.spec.ts')
    ]);
    assert.deepEqual(committed.files.sort(), local.files);
    assert.match(committed.diff ?? '', /value = 2/);
    assert.deepEqual(
      committed.statuses?.map((entry) => entry.path),
      ['app.ts']
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('linguist-generated paths stay in the inventory but not the local or committed model patch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-generated-'));
  const nested = join(root, 'e2e');

  try {
    await mkdir(nested);
    runGit(root, 'init', '-q');
    await writeFile(join(root, '.gitattributes'), 'pnpm-lock.yaml linguist-generated=true\n');
    await writeFile(
      join(nested, '.gitattributes'),
      '*.snap linguist-generated\nvisible.snap -linguist-generated\n'
    );
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lock before\n');
    await writeFile(join(root, 'app.ts'), 'app before\n');
    await writeFile(join(nested, 'capture.snap'), 'generated before\n');
    await writeFile(join(nested, 'visible.snap'), 'visible before\n');
    commit(root, 'baseline');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    await writeFile(join(root, 'pnpm-lock.yaml'), 'lock after\n');
    await writeFile(join(root, 'app.ts'), 'app after\n');
    await writeFile(join(nested, 'capture.snap'), 'generated after\n');
    await writeFile(join(nested, 'visible.snap'), 'visible after\n');
    await writeFile(join(nested, 'new.snap'), 'new generated\n');

    const config = resolveConfig({ cwd: nested }, {});
    const local = await getGitChanges(nested, undefined, config);
    assert.deepEqual(local.generatedFiles?.sort(), [
      'e2e/capture.snap',
      'e2e/new.snap',
      'pnpm-lock.yaml'
    ]);
    assert.deepEqual(local.files.sort(), [
      'app.ts',
      'e2e/capture.snap',
      'e2e/new.snap',
      'e2e/visible.snap',
      'pnpm-lock.yaml'
    ]);
    assert.deepEqual(local.statuses?.map((entry) => entry.path).sort(), [
      'app.ts',
      'e2e/visible.snap'
    ]);
    assert.match(local.diff ?? '', /app after|visible after/);
    assert.doesNotMatch(local.diff ?? '', /lock after|generated after|new generated/);

    const unfiltered = await getGitChanges(
      nested,
      undefined,
      resolveConfig({ cwd: nested, excludeGeneratedFiles: false }, {})
    );
    assert.match(unfiltered.diff ?? '', /lock after|generated after|new generated/);

    commit(root, 'changed');
    const committed = await getGitChanges(nested, base, config);
    assert.deepEqual(committed.generatedFiles?.sort(), local.generatedFiles);
    assert.doesNotMatch(committed.diff ?? '', /lock after|generated after|new generated/);
    assert.match(committed.diff ?? '', /app after|visible after/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
