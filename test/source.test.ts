import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { TestCase } from '@playwright/test/reporter';
import { limitTestSource, withTestSource } from '../src/source.js';

test('source limit counts JavaScript tokens and bounds long literals', () => {
  assert.equal(limitTestSource('alpha + beta + gamma', 3).trim(), 'alpha + beta');
  assert.equal(limitTestSource(`'${'x'.repeat(10_000)}'`, 5).length, 60);
});

test('source extraction reads a shared spec and bounds excerpts at the next declaration', async () => {
  const file = resolve('test/fixtures/smoke.spec.ts');
  const tests = [{ location: { file, line: 3 } }, { location: { file, line: 4 } }] as TestCase[];
  const descriptors = [
    { id: 'first', file, title: 'first fixture' },
    { id: 'second', file, title: 'second fixture' }
  ];

  const excerpts = await withTestSource(tests, descriptors, 50);

  assert.match(excerpts[0]?.source ?? '', /first fixture/);
  assert.doesNotMatch(excerpts[0]?.source ?? '', /second fixture/);
  assert.match(excerpts[1]?.source ?? '', /second fixture/);
  assert.ok((excerpts[1]?.source?.length ?? 0) <= 50);
});
