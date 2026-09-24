import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractTestBodies } from '../src/test-body.js';

function location(source: string, marker: string, index: number) {
  const position = source.indexOf(marker);
  assert.notEqual(position, -1);
  const before = source.slice(0, position);
  return {
    index,
    line: before.split('\n').length,
    column: position - before.lastIndexOf('\n')
  };
}

test('TSX tests include their callback code and own leading comments, not adjacent JSDoc', () => {
  const source = [
    "import { test } from '@playwright/test';",
    "test.describe('suite', () => {",
    '  /** Describes the first test only. */',
    "  test('first', async ({ page }: { page: Page }) => {",
    "    const node = <span>{'Olá 😀'}</span>;",
    "    expect(node.props.children).toBe('Olá 😀');",
    '  });',
    '  // Describes the second test only.',
    '  // Also belongs to the second test.',
    "  test.only('second', function () { expect(2).toBe(2); });",
    '  /** Belongs to the following declaration, not the second test. */',
    '});'
  ].join('\n');
  const bodies = extractTestBodies('scenario.spec.tsx', source, [
    location(source, "test('first'", 0),
    location(source, "test.only('second'", 1)
  ]);

  assert.match(bodies.get(0) ?? '', /Describes the first test only/);
  assert.match(bodies.get(0) ?? '', /Olá 😀/);
  assert.doesNotMatch(bodies.get(0) ?? '', /second test|test\('first'/);
  assert.match(bodies.get(1) ?? '', /Describes the second test only/);
  assert.match(bodies.get(1) ?? '', /Also belongs to the second test/);
  assert.match(bodies.get(1) ?? '', /expect\(2\)/);
  assert.doesNotMatch(bodies.get(1) ?? '', /following declaration|test\.only\('second'/);
});

test('same-line tests use their source columns and expression callbacks', () => {
  const source = "test('first', () => 1); test('second', () => 2);";
  const bodies = extractTestBodies('scenario.spec.ts', source, [
    location(source, "test('first'", 0),
    location(source, "test('second'", 1)
  ]);

  assert.equal(bodies.get(0), '1');
  assert.equal(bodies.get(1), '2');
  assert.equal(extractTestBodies('scenario.spec.ts', source, [{ index: 0, line: 1 }]).size, 0);
});

test('Playwright member-call columns match fixme, only, and skip without adjacent comments', () => {
  const source = [
    '/** A quarantined download test. */',
    "test.fixme('download', async ({ app }) => { await app.download(); });",
    "test.only('focused', () => { expect(true); });",
    "test.skip('disabled', () => { expect(false); });"
  ].join('\n');
  const locations = [
    { index: 0, line: 2, column: 6 },
    { index: 1, line: 3, column: 6 },
    { index: 2, line: 4, column: 6 }
  ];
  const bodies = extractTestBodies('scenario.spec.ts', source, locations);

  assert.match(bodies.get(0) ?? '', /quarantined download test/);
  assert.match(bodies.get(0) ?? '', /await app\.download\(\)/);
  assert.doesNotMatch(bodies.get(0) ?? '', /test\.fixme\('download'/);
  assert.match(bodies.get(1) ?? '', /expect\(true\)/);
  assert.match(bodies.get(2) ?? '', /expect\(false\)/);
  assert.doesNotMatch(bodies.get(1) ?? '', /quarantined download test/);
});

test('leading comments stop at blank lines and previous test trailing comments', () => {
  const source = [
    '/** Unrelated comment. */',
    '',
    "test('first', () => { expect(1); }); // previous trailing comment",
    "test('second', () => { expect(2); });"
  ].join('\n');
  const bodies = extractTestBodies('scenario.spec.ts', source, [
    location(source, "test('first'", 0),
    location(source, "test('second'", 1)
  ]);

  assert.doesNotMatch(bodies.get(0) ?? '', /Unrelated comment|previous trailing comment/);
  assert.doesNotMatch(bodies.get(1) ?? '', /previous trailing comment|expect\(1\)/);
  assert.match(bodies.get(1) ?? '', /expect\(2\)/);
});

test('project instances at the same location share the same extracted body', () => {
  const source = "test('first', () => { expect(true).toBe(true); });";
  const first = location(source, "test('first'", 0);
  const bodies = extractTestBodies('scenario.spec.ts', source, [first, { ...first, index: 1 }]);

  assert.equal(bodies.get(0), bodies.get(1));
  assert.match(bodies.get(0) ?? '', /expect\(true\)/);
});

test('a callback without an unambiguous match is omitted without leaking neighboring code', () => {
  const broken = "test('broken', () => {";
  assert.throws(
    () => extractTestBodies('broken.spec.ts', broken, [location(broken, 'test(', 0)]),
    /Cannot parse/
  );

  const source = [
    "test('first', () => { expect(1); });",
    "test('indirect', runScenario);",
    "test('third', () => { expect(3); });"
  ].join('\n');
  const bodies = extractTestBodies('indirect.spec.ts', source, [
    location(source, "test('first'", 0),
    location(source, "test('indirect'", 1),
    location(source, "test('third'", 2)
  ]);

  assert.match(bodies.get(0) ?? '', /expect\(1\)/);
  assert.equal(bodies.has(1), false);
  assert.match(bodies.get(2) ?? '', /expect\(3\)/);
});
