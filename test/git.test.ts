import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveConfig } from '../src/config.js';
import { getGitChanges } from '../src/git.js';

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
