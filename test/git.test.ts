import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveConfig } from '../src/config.js';
import { getCommitTitle, getGitChanges } from '../src/git.js';

function runGit(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd });
}

function commit(cwd: string, message: string): void {
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
    message
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
    assert.equal(await getCommitTitle(cwd), 'initial');
    assert.deepEqual(changes.files, ['new.ts']);
    assert.deepEqual(changes.statuses, [
      { status: 'R100', previousPath: 'old.ts', path: 'new.ts' }
    ]);
    assert.equal(changes.patches?.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
