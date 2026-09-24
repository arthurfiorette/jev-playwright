import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestCase } from '@playwright/test/reporter';
import { limitTestSource, withTestSource } from '../src/source.js';

test('source limit counts JavaScript tokens and bounds long literals', () => {
  assert.equal(limitTestSource('alpha + beta + gamma', 3).trim(), 'alpha + beta');
  assert.equal(limitTestSource(`'${'x'.repeat(10_000)}'`, 5).length, 30);
});

test('source compression preserves comments, newlines, and literal whitespace', () => {
  const source = '  const value   =  "a  b";\n\n  // keep  this\n   expect(value);';
  assert.equal(
    limitTestSource(source, 100),
    'const value = "a  b";\n// keep  this\nexpect(value);'
  );
  assert.equal(limitTestSource('return\n  value', 100), 'return\nvalue');
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

test('source extraction reaches past 40 lines without including the next test', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'jev-source-'));
  const file = join(cwd, 'long.spec.ts');

  try {
    const lines = [
      "test('first', async () => {",
      ...Array.from({ length: 44 }, () => '  await page.waitForTimeout(1);'),
      '  expect(page).toBeDefined();',
      '});',
      "test('second', () => {});"
    ];
    await writeFile(file, lines.join('\n'));

    const tests = [{ location: { file, line: 1 } }, { location: { file, line: 48 } }] as TestCase[];
    const descriptors = [
      { id: 'first', file, title: 'first' },
      { id: 'second', file, title: 'second' }
    ];
    const excerpts = await withTestSource(tests, descriptors, 5000);

    assert.match(excerpts[0]?.source ?? '', /expect\(page\)/);
    assert.doesNotMatch(excerpts[0]?.source ?? '', /second/);
    assert.match(excerpts[1]?.source ?? '', /second/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
