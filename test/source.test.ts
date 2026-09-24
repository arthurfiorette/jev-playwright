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

test('source extraction reads a shared spec and returns callback bodies without test wrappers', async () => {
  const file = resolve('test/fixtures/smoke.spec.ts');
  const tests = [{ location: { file, line: 3 } }, { location: { file, line: 6 } }] as TestCase[];
  const descriptors = [
    { id: 'first', file, title: 'first fixture' },
    { id: 'second', file, title: 'second fixture' }
  ];

  const excerpts = await withTestSource(tests, descriptors, 50);

  assert.match(excerpts[0]?.source ?? '', /expect\(1\)/);
  assert.doesNotMatch(excerpts[0]?.source ?? '', /expect\(2\)|test\('first fixture'/);
  assert.match(excerpts[1]?.source ?? '', /expect\(2\)/);
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
      '/** description of the second test only */',
      "test('second', () => { expect(2).toBe(2); });"
    ];
    await writeFile(file, lines.join('\n'));

    const tests = [{ location: { file, line: 1 } }, { location: { file, line: 49 } }] as TestCase[];
    const descriptors = [
      { id: 'first', file, title: 'first' },
      { id: 'second', file, title: 'second' }
    ];
    const excerpts = await withTestSource(tests, descriptors, 5000);

    assert.match(excerpts[0]?.source ?? '', /expect\(page\)/);
    assert.doesNotMatch(excerpts[0]?.source ?? '', /description of the second test/);
    assert.match(excerpts[1]?.source ?? '', /description of the second test/);
    assert.match(excerpts[1]?.source ?? '', /expect\(2\)/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('unmatched callbacks and missing or invalid files only lose their own source context', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'jev-optional-source-'));
  const good = join(cwd, 'good.spec.ts');
  const bad = join(cwd, 'bad.spec.ts');
  const missing = join(cwd, 'missing.spec.ts');

  try {
    await writeFile(
      good,
      [
        "test('first', () => { expect(1); });",
        "test('indirect', runScenario);",
        "test('third', () => { expect(3); });"
      ].join('\n')
    );
    await writeFile(bad, "test('broken', () => {");

    const locations = [
      { file: good, line: 1 },
      { file: good, line: 2 },
      { file: good, line: 3 },
      { file: bad, line: 1 },
      { file: missing, line: 1 }
    ];
    const tests = locations.map((location) => ({ location })) as TestCase[];
    const descriptors = locations.map((location, index) => ({
      id: String(index),
      file: location.file,
      title: `scenario ${index}`
    }));
    const excerpts = await withTestSource(tests, descriptors, 500);

    assert.match(excerpts[0]?.source ?? '', /expect\(1\)/);
    assert.equal(excerpts[1]?.source, undefined);
    assert.match(excerpts[2]?.source ?? '', /expect\(3\)/);
    assert.equal(excerpts[3]?.source, undefined);
    assert.equal(excerpts[4]?.source, undefined);
    assert.deepEqual(
      excerpts.map((excerpt) => excerpt.id),
      descriptors.map((descriptor) => descriptor.id)
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
