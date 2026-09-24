import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defineConfigWithJev } from '../src/define-config.js';

const reporter = fileURLToPath(new URL('../src/reporter.js', import.meta.url));

test('adds typed Jev options after existing reporters without changing Playwright options', () => {
  const jev = { enabled: true, include: ['src/**'] };
  const playwright = { reporter: [['list']] as ['list'][], testDir: './e2e' };
  const config = defineConfigWithJev(jev, playwright);

  assert.deepEqual(config.reporter, [['list'], [reporter, jev]]);
  assert.equal(config.testDir, './e2e');
  assert.deepEqual(playwright.reporter, [['list']]);
});

test('preserves a single Playwright reporter name', () => {
  const config = defineConfigWithJev({ enabled: false }, { reporter: 'dot' });
  assert.deepEqual(config.reporter, [['dot'], [reporter, { enabled: false }]]);
});
