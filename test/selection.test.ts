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

function client(
  probabilities: number[],
  chosenScope?: 'all' | 'none' | 'some'
): Pick<TypeSafeClient, 'systemOne'> {
  return {
    systemOne: (async ({ questions }: { questions: Record<string, unknown> }) => {
      const keys = Object.keys(questions).filter((key) => key !== 'scope');
      const scope =
        chosenScope ??
        (keys.every((_, index) => (probabilities[index] ?? 0) >= 0.5)
          ? 'all'
          : keys.every((_, index) => (probabilities[index] ?? 0) < 0.5)
            ? 'none'
            : 'some');
      return {
        model: 'jev-test',
        answers: {
          scope: { type: 'choice', choice: scope, confidence: 0.9 },
          ...Object.fromEntries(
            keys.map((key, index) => [
              key,
              {
                type: 'noul',
                noul: probabilities[index]
              }
            ])
          )
        }
      };
    }) as unknown as TypeSafeClient['systemOne']
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
  assert.equal(config.diff.whitespace, 'all');
  assert.deepEqual(filterPaths(['src/a.ts', 'src/generated/b.ts', 'test/a.ts'], config), [
    'src/a.ts'
  ]);
  assert.throws(() => resolveConfig({}, { JEV_PLAYWRIGHT_THRESHOLD: 'nope' }), /must be a number/);
  assert.throws(() => resolveConfig({ limits: { requestTokens: 0 } }), /limits/);
  assert.equal(
    resolveConfig(
      { limits: { requestTokens: 64_000 } },
      {
        JEV_PLAYWRIGHT_LIMITS_REQUEST_TOKENS: '12000'
      }
    ).limits.requestTokens,
    12_000
  );
  assert.equal(
    resolveConfig(
      { diff: { whitespace: 'none' } },
      {
        JEV_PLAYWRIGHT_DIFF_WHITESPACE: 'eol'
      }
    ).diff.whitespace,
    'eol'
  );
  assert.throws(
    () => resolveConfig({}, { JEV_PLAYWRIGHT_DIFF_CONTEXT_LINES: '-1' }),
    /contextLines/
  );
  assert.throws(
    () => resolveConfig({}, { JEV_PLAYWRIGHT_DIFF_WHITESPACE: 'ignore' }),
    /DIFF_WHITESPACE/
  );
});

test('forces directly changed specs and selects multiple relevant tests', async () => {
  const result = await selectTests({
    tests,
    changes: { files: ['e2e/a.spec.ts', 'src/payments.ts'], diff: '+change' },
    config: { enabled: true, cwd: '/repo', threshold: 0.6 },
    client: client([0.9, 0.9])
  });
  assert.deepEqual(result.selectedIds, ['a', 'b', 'c']);
  assert.equal(result.assessments.length, 2);
  assert.equal(result.assessments[0]?.model, 'jev-test');
});

test('a change only to a discovered spec runs that spec without calling Jev', async () => {
  const result = await selectTests({
    tests,
    changes: { files: ['e2e/a.spec.ts'], diff: '+changed test code' },
    config: { enabled: true, cwd: '/repo' },
    env: {}
  });

  assert.deepEqual(result.selectedIds, ['a']);
  assert.deepEqual(result.assessments, []);
  assert.equal(result.fallbackReason, undefined);
});

test('excludes low probability tests but fails open for incomplete answers', async () => {
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
});

test('Jev can choose no tests, while incomplete or contradictory decisions run all', async () => {
  const input = {
    tests,
    changes: { files: ['src/login.ts'] },
    config: { enabled: true, cwd: '/repo' }
  };

  const empty = await selectTests({ ...input, client: client([0, 0, 0]) });
  assert.deepEqual(empty.selectedIds, []);
  assert.equal(empty.fallbackReason, undefined);
  assert.equal(empty.assessments.length, 3);

  const incomplete = await selectTests({ ...input, client: client([0]) });
  assert.deepEqual(incomplete.selectedIds, ['a', 'b', 'c']);
  assert.match(incomplete.fallbackReason ?? '', /Invalid Jev answer/);

  const contradictory = await selectTests({ ...input, client: client([0.9, 0.1, 0.2], 'none') });
  assert.deepEqual(contradictory.selectedIds, ['a', 'b', 'c']);
  assert.match(contradictory.fallbackReason ?? '', /scope conflicts/);

  const noChanges = await selectTests({
    ...input,
    changes: { files: [] },
    client: client([0, 0, 0])
  });
  assert.deepEqual(noChanges.selectedIds, ['a', 'b', 'c']);
  assert.equal(noChanges.fallbackReason, 'no included changes');
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
        return {
          model: 'mock',
          answers: {
            scope: { type: 'choice', choice: 'all', confidence: 1 },
            test_0: { type: 'noul', noul: 0.8 }
          }
        };
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

  assert.doesNotMatch(String(without.state), /x{60}/);
  assert.match(String(withSource.state), /x{60}/);
});

test('string state keeps compact statuses and bounded human hints', () => {
  const request = createRequest(
    [tests[0]!],
    {
      files: ['src/payments.ts'],
      statuses: [{ status: 'M', path: 'src/payments.ts' }],
      diff: '+updated payments',
      title: 'Payment fix',
      description: `<details>${'context '.repeat(500)}</details>`
    },
    resolveConfig({}, {})
  );
  const state = String(request.state);
  assert.match(state, /M src\/payments\.ts/);
  assert.match(state, /test_0 \| chromium \| \/repo\/e2e\/a\.spec\.ts \| checkout/);
  assert.match(state, /Patch:\n\+updated payments/);
  assert.ok(state.length < 3_000);
});

test('source-aware batching uses actual excerpt sizes', async () => {
  const batchSizes: number[] = [];
  const mockedClient: Pick<TypeSafeClient, 'systemOne'> = {
    systemOne: (async ({ questions }: { questions: Record<string, unknown> }) => {
      const keys = Object.keys(questions);
      batchSizes.push(keys.length - 1);
      return {
        model: 'mock',
        answers: Object.fromEntries(
          keys.map((key) => [
            key,
            key === 'scope'
              ? { type: 'choice', choice: 'all', confidence: 1 }
              : { type: 'noul', noul: 1 }
          ])
        )
      };
    }) as unknown as TypeSafeClient['systemOne']
  };

  const selection = await selectTests({
    tests: tests.map((candidate) => ({ ...candidate, source: 'x'.repeat(15_000) })),
    changes: { files: ['src/feature.ts'] },
    config: { enabled: true, includeTestSource: true, cwd: '/repo' },
    client: mockedClient
  });

  assert.deepEqual(batchSizes, [2, 1]);
  assert.deepEqual(selection.selectedIds, ['a', 'b', 'c']);
});

test('default limits fit more than fifty small candidates in one request', async () => {
  const catalog = Array.from({ length: 60 }, (_, index) => ({
    id: `test-${index}`,
    file: `/repo/e2e/${index}.spec.ts`,
    title: `test ${index}`
  }));
  let calls = 0;
  const mockedClient: Pick<TypeSafeClient, 'systemOne'> = {
    systemOne: (async ({ questions }: { questions: Record<string, unknown> }) => {
      calls++;
      return {
        model: 'mock',
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [
            key,
            key === 'scope'
              ? { type: 'choice', choice: 'all', confidence: 1 }
              : { type: 'noul', noul: 1 }
          ])
        )
      };
    }) as unknown as TypeSafeClient['systemOne']
  };

  const result = await selectTests({
    tests: catalog,
    changes: { files: ['src/feature.ts'] },
    config: { enabled: true, cwd: '/repo' },
    env: {},
    client: mockedClient
  });

  assert.equal(calls, 1);
  assert.equal(result.selectedIds.length, 60);
});

test('configurable limits split candidate requests, but do not drop an oversized change', async () => {
  const changes = { files: ['src/feature.ts'], diff: '+change' };
  const config = resolveConfig({ cwd: '/repo' }, {});
  const estimate = (request: ReturnType<typeof createRequest>) => {
    const questions = Object.values(request.questions).map((question) =>
      Buffer.byteLength(JSON.stringify(question))
    );
    return Buffer.byteLength(JSON.stringify(request.state)) + Math.max(...questions);
  };
  const one = estimate(createRequest(tests.slice(0, 1), changes, config));
  const two = estimate(createRequest(tests.slice(0, 2), changes, config));
  const limit = Math.floor((one + two) / 2);
  const calls: number[] = [];
  const mockedClient: Pick<TypeSafeClient, 'systemOne'> = {
    systemOne: (async ({ questions }: { questions: Record<string, unknown> }) => {
      calls.push(Object.keys(questions).length - 1);
      return {
        model: 'mock',
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [
            key,
            key === 'scope'
              ? { type: 'choice', choice: 'all', confidence: 1 }
              : { type: 'noul', noul: 1 }
          ])
        )
      };
    }) as unknown as TypeSafeClient['systemOne']
  };

  const options = { enabled: true, cwd: '/repo', limits: { stateAndQuestionTokens: limit } };
  const result = await selectTests({
    tests,
    changes,
    config: options,
    env: {},
    client: mockedClient
  });
  assert.deepEqual(calls, [1, 1, 1]);
  assert.deepEqual(result.selectedIds, ['a', 'b', 'c']);

  const oversized = await selectTests({
    tests,
    changes: { files: ['src/feature.ts'], diff: 'x'.repeat(40_000) },
    config: options,
    env: {},
    client: mockedClient
  });
  assert.deepEqual(oversized.selectedIds, ['a', 'b', 'c']);
  assert.match(oversized.fallbackReason ?? '', /no complete per-file patches/);
  assert.deepEqual(calls, [1, 1, 1]);
});

test('oversized patches are evaluated in chunks and their selected tests are united', async () => {
  const firstPatch = `diff --git a/src/alpha.ts b/src/alpha.ts\n+ALPHA_PATCH ${'x'.repeat(500)}`;
  const secondPatch = `diff --git a/src/beta.ts b/src/beta.ts\n+BETA_PATCH ${'y'.repeat(500)}`;
  const changes = {
    files: ['src/alpha.ts', 'src/beta.ts'],
    statuses: [
      { status: 'M', path: 'src/alpha.ts' },
      { status: 'M', path: 'src/beta.ts' }
    ],
    diff: `${firstPatch}\n${secondPatch}`,
    patches: [firstPatch, secondPatch]
  };
  const base = resolveConfig({ cwd: '/repo' }, {});
  const size = (diff: string) => {
    const request = createRequest([tests[0]!], { ...changes, diff }, base);
    const state = Buffer.byteLength(JSON.stringify(request.state));
    const longest = Math.max(
      ...Object.values(request.questions).map((question) =>
        Buffer.byteLength(JSON.stringify(question))
      )
    );
    return state + longest;
  };
  const limit = Math.floor((size(firstPatch) + size(changes.diff)) / 2);
  const requests: string[] = [];
  const mockedClient: Pick<TypeSafeClient, 'systemOne'> = {
    systemOne: (async (request: { state: string; questions: Record<string, unknown> }) => {
      requests.push(request.state);
      const keys = Object.keys(request.questions).filter((key) => key !== 'scope');
      const probabilities = keys.map((key) => {
        const line = request.state.split('\n').find((entry) => entry.startsWith(`${key} |`)) ?? '';
        return (request.state.includes('ALPHA_PATCH') && line.includes('checkout')) ||
          (request.state.includes('BETA_PATCH') && line.includes('login'))
          ? 1
          : 0;
      });
      const scope = probabilities.every((probability) => probability === 1)
        ? 'all'
        : probabilities.every((probability) => probability === 0)
          ? 'none'
          : 'some';
      return {
        model: 'mock',
        answers: {
          scope: { type: 'choice', choice: scope, confidence: 1 },
          ...Object.fromEntries(
            keys.map((key, index) => [
              key,
              {
                type: 'noul',
                noul: probabilities[index]
              }
            ])
          )
        }
      };
    }) as unknown as TypeSafeClient['systemOne']
  };
  const config = { enabled: true, cwd: '/repo', limits: { stateAndQuestionTokens: limit } };
  const selected = await selectTests({ tests, changes, config, env: {}, client: mockedClient });

  assert.deepEqual(selected.selectedIds, ['a', 'b']);
  assert.ok(requests.length >= 2);
  assert.ok(
    requests.every((state) => !(state.includes('ALPHA_PATCH') && state.includes('BETA_PATCH')))
  );

  const limited = await selectTests({
    tests,
    changes,
    config: { ...config, limits: { ...config.limits, maxRequests: 1 } },
    env: {},
    client: mockedClient
  });
  assert.deepEqual(limited.selectedIds, ['a', 'b', 'c']);
  assert.match(limited.fallbackReason ?? '', /request count exceeds/);
});
