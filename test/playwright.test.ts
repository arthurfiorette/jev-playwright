import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function localGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'BASE_REF',
    'JEV_PLAYWRIGHT_BASE_REF',
    'CI',
    'GITHUB_ACTIONS',
    'GITEA_ACTIONS',
    'GITLAB_CI',
    'BITBUCKET_BUILD_NUMBER',
    'TF_BUILD'
  ]) {
    delete env[key];
  }
  return env;
}

test('Playwright loads the reporter and discovers tests without a model request', () => {
  const output = execFileSync(
    process.execPath,
    [
      'node_modules/@playwright/test/cli.js',
      'test',
      '--list',
      '-c',
      'test/fixtures/playwright.config.ts'
    ],
    { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' } }
  );
  assert.match(output, /first fixture/);
  assert.match(output, /second fixture/);
});

test('reporter runs actual Playwright tests and handles a missing provider by running all', () => {
  const output = execFileSync(
    process.execPath,
    [
      'node_modules/@playwright/test/cli.js',
      'test',
      '-c',
      'test/fixtures/playwright.config.ts',
      '--workers=1'
    ],
    {
      encoding: 'utf8',
      env: {
        ...localGitEnv(),
        JEV_PLAYWRIGHT_ENABLED: 'true',
        JEV_PLAYWRIGHT_INCLUDE: '["src/config.ts"]',
        JEV_PLAYWRIGHT_INCLUDE_TEST_SOURCE: 'true',
        JEV_PLAYWRIGHT_PROVIDER_KEY: '',
        TYPESAFE_API_KEY: ''
      }
    }
  );
  assert.match(output, /2 passed/);
});

test('reporter can exclude every test after a complete empty Jev decision', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'jev-reporter-'));
  execFileSync('git', ['init', '-q'], { cwd });
  await writeFile(join(cwd, 'change.txt'), 'fixture change\n');

  try {
    const run = spawnSync(
      process.execPath,
      [
        'node_modules/@playwright/test/cli.js',
        'test',
        '-c',
        'test/fixtures/empty.config.ts',
        '--workers=1'
      ],
      {
        encoding: 'utf8',
        env: {
          ...localGitEnv(),
          JEV_PLAYWRIGHT_ENABLED: 'true',
          JEV_PLAYWRIGHT_CWD: cwd,
          DEBUG: 'jev-playwright:*',
          JEV_PLAYWRIGHT_INCLUDE: '["change.txt"]',
          JEV_PLAYWRIGHT_PROVIDER_KEY: '',
          TYPESAFE_API_KEY: ''
        }
      }
    );

    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(
      run.stderr,
      /Selected 0\/2 tests \(complete Jev decision: no relevant tests; skipped\)/
    );
    assert.match(run.stderr, /jev-playwright:reporter changed paths/);
    assert.match(run.stderr, /jev-playwright:reporter test source .*included: true/s);
    assert.match(run.stderr, /jev-playwright:batch request 1: candidates=2, contextBytes=\d+/);
    assert.match(run.stderr, /jev-playwright:batch request 1 result/);
    assert.match(run.stderr, /selected: 0,\s+total: 2/);
    assert.match(run.stderr, /topExcluded:/);
    assert.match(run.stderr, /bottomExcluded:/);
    assert.match(run.stderr, /bottomSelected:/);
    assert.doesNotMatch(run.stderr, /fixture change\n|Test:test_0|"instructions":/);
    assert.match(run.stdout, /2 skipped/);
    assert.doesNotMatch(run.stdout, /2 passed/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
