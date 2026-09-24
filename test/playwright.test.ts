import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

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
        ...process.env,
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
