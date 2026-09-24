import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
  const change = `test/fixtures/.jev-change-${randomUUID()}.txt`;
  const file = resolve(change);
  await writeFile(file, 'fixture change\n', { flag: 'wx' });

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
          JEV_PLAYWRIGHT_DEBUG: 'true',
          JEV_PLAYWRIGHT_INCLUDE: JSON.stringify([change]),
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
    assert.match(run.stderr, /\[jev-playwright:debug\] changed paths/);
    assert.match(run.stderr, /\[jev-playwright:debug\] test source\n\{\n {2}"included": false/);
    assert.match(run.stderr, /\[jev-playwright:debug\] request 1 state/);
    assert.match(run.stderr, /\[jev-playwright:debug\] request 1 questions/);
    assert.match(run.stderr, /Test:test_0\|test\/fixtures\/smoke\.spec\.ts:3:1\|first fixture/);
    assert.match(run.stderr, /\[jev-playwright:debug\] request 1 response/);
    assert.match(run.stdout, /2 skipped/);
    assert.doesNotMatch(run.stdout, /2 passed/);
  } finally {
    await rm(file);
  }
});
