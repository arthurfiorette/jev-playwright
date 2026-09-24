import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { filterPaths, resolveConfig } from '../src/config.js';
import { createRequest } from '../src/prompt.js';
import { selectTests } from '../src/selection.js';

const tests = [
  { id: 'a', file: '/repo/e2e/a.spec.ts', title: 'checkout', project: 'chromium' },
  { id: 'b', file: '/repo/e2e/b.spec.ts', title: 'login', project: 'chromium' },
  { id: 'c', file: '/repo/e2e/c.spec.ts', title: 'account', project: 'chromium' }
];

function client(probabilities: number[]): Pick<TypeSafeClient, 'systemOne'> {
  return {
    systemOne: (async ({ questions }: { questions: Record<string, unknown> }) => ({
      model: 'jev-test',
      answers: Object.fromEntries(
        Object.keys(questions).map((key, index) => [
          key,
          {
            type: 'noul',
            noul: probabilities[index]
          }
        ])
      )
    })) as unknown as TypeSafeClient['systemOne']
  };
}

test('config precedence, glob filtering, and validation', () => {
  const config = resolveConfig(
    { enabled: true, threshold: 0.7 },
    {
      BASE_REF: 'main',
      JEV_PLAYWRIGHT_THRESHOLD: '0.4',
      JEV_PLAYWRIGHT_INCLUDE: '["src/**"]',
      JEV_PLAYWRIGHT_EXCLUDE: '["src/generated/**"]'
    }
  );
  assert.equal(config.baseRef, 'main');
  assert.equal(config.threshold, 0.4);
  assert.deepEqual(filterPaths(['src/a.ts', 'src/generated/b.ts', 'test/a.ts'], config), [
    'src/a.ts'
  ]);
  assert.throws(() => resolveConfig({}, { JEV_PLAYWRIGHT_THRESHOLD: 'nope' }), /must be a number/);
  assert.throws(() => resolveConfig({ batchSize: 0 }), /batchSize/);
});

test('forces directly changed specs and selects multiple relevant tests', async () => {
  const result = await selectTests({
    tests,
    changes: { files: ['e2e/a.spec.ts', 'src/payments.ts'], diff: '+change' },
    config: { enabled: true, cwd: '/repo', batchSize: 1, threshold: 0.6 },
    client: client([0.9])
  });
  assert.deepEqual(result.selectedIds, ['a', 'b', 'c']);
  assert.equal(result.assessments.length, 2);
  assert.equal(result.assessments[0]?.model, 'jev-test');
});

test('excludes low probability tests but fails open for incomplete answers and empty selections', async () => {
  const input = {
    tests,
    changes: { files: ['src/login.ts'] },
    config: { enabled: true, cwd: '/repo' }
  };
  const selected = await selectTests({ ...input, client: client([0.8, 0.1, 0.2]) });
  assert.deepEqual(selected.selectedIds, ['a']);
  const incomplete = await selectTests({ ...input, client: client([0.9]) });
  assert.deepEqual(incomplete.selectedIds, ['a', 'b', 'c']);
  assert.match(incomplete.fallbackReason ?? '', /Invalid Jev answer/);
  const empty = await selectTests({ ...input, client: client([0, 0, 0]) });
  assert.equal(empty.fallbackReason, 'Error: No tests selected');
});

test('no included files runs all without contacting Jev', async () => {
  const result = await selectTests({
    tests,
    changes: { files: ['docs/readme.md'] },
    config: { enabled: true, cwd: '/repo', include: ['src/**'] }
  });
  assert.equal(result.fallbackReason, 'no included changes');
  assert.deepEqual(
    result.selectedIds,
    tests.map((item) => item.id)
  );
});

test('custom question and beforeRequest hook customize the SDK request', async () => {
  let question = '';
  let state = '';
  const response = await selectTests({
    tests: tests.slice(0, 1),
    changes: { files: ['src/login.ts'], diff: '+login' },
    env: {},
    config: {
      enabled: true,
      cwd: '/repo',
      createQuestion: (test, key) => `Does ${test.title} depend on ${key}?`,
      beforeRequest: (request) => ({ ...request, state: { feature: 'login' } })
    },
    client: {
      systemOne: (async (request: {
        questions: Record<string, { instructions: string }>;
        state: unknown;
      }) => {
        question = request.questions.test_0?.instructions ?? '';
        state = JSON.stringify(request.state);
        return { model: 'mock', answers: { test_0: { type: 'noul', noul: 0.8 } } };
      }) as unknown as TypeSafeClient['systemOne']
    }
  });
  assert.equal(question, 'Does checkout depend on test_0?');
  assert.equal(state, '{"feature":"login"}');
  assert.deepEqual(response.selectedIds, ['a']);
});

test('environment overrides config for provider and selection options', () => {
  const config = resolveConfig(
    { providerUrl: 'https://direct.example', enabled: false },
    {
      JEV_PLAYWRIGHT_PROVIDER_URL: 'https://provider.example',
      JEV_PLAYWRIGHT_PROVIDER_KEY: 'fake-key',
      JEV_PLAYWRIGHT_ENABLED: '1'
    }
  );
  assert.equal(config.providerUrl, 'https://provider.example');
  assert.equal(config.providerKey, 'fake-key');
  assert.equal(config.enabled, true);
});

test('source context is opt-in and bounded per candidate', () => {
  const candidate = { ...tests[0]!, source: 'x'.repeat(2_000) };
  const changes = { files: ['src/login.ts'] };
  const without = createRequest([candidate], changes, resolveConfig({}, {}));
  const withSource = createRequest(
    [candidate],
    changes,
    resolveConfig({ includeTestSource: true, maxTestSourceTokens: 10 }, {})
  );

  assert.equal(
    (without.state as { candidates: { test_0: { source: string } } }).candidates.test_0.source,
    ''
  );
  assert.equal(
    (withSource.state as { candidates: { test_0: { source: string } } }).candidates.test_0.source
      .length,
    120
  );
});
