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
    systemOne: (async ({ questions }: { questions: Record<string, unknown> }) => {
      return {
        model: 'jev-test',
        answers: Object.fromEntries(
          Object.keys(questions).map((key, index) => [
            key,
            { type: 'noul', noul: probabilities[index] }
          ])
        )
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
  assert.equal(config.perProject, false);
  assert.equal(config.excludeGeneratedFiles, true);
  assert.equal(
    resolveConfig({}, { JEV_PLAYWRIGHT_EXCLUDE_GENERATED_FILES: 'false' }).excludeGeneratedFiles,
    false
  );
  assert.equal(config.limits.maxConcurrentRequests, 5);
  assert.equal(
    resolveConfig(
      { limits: { maxConcurrentRequests: 1 } },
      {
        JEV_PLAYWRIGHT_LIMITS_MAX_CONCURRENT_REQUESTS: '3'
      }
    ).limits.maxConcurrentRequests,
    3
  );
  assert.throws(
    () => resolveConfig({ limits: { maxConcurrentRequests: 0 } }, {}),
    /limits must be positive/
  );
  assert.equal(
    resolveConfig({ perProject: false }, { JEV_PLAYWRIGHT_PER_PROJECT: 'true' }).perProject,
    true
  );
  assert.equal(config.diff.whitespace, 'all');
  assert.equal(config.diff.contextLines, 3);
  assert.equal(resolveConfig({ diff: { contextLines: 1 } }, {}).diff.contextLines, 1);
  assert.deepEqual(filterPaths(['src/a.ts', 'src/generated/b.ts', 'test/a.ts'], config), [
    'src/a.ts'
  ]);
  assert.deepEqual(
    filterPaths(['.github/workflows/ci.yml', 'src/.settings/file.ts'], resolveConfig({}, {})),
    ['.github/workflows/ci.yml', 'src/.settings/file.ts']
  );
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

test('generated paths are omitted from model context while changed specs still run', async () => {
  let state = '';
  const mock: Pick<TypeSafeClient, 'systemOne'> = {
    systemOne: (async (request: { state: string; questions: Record<string, unknown> }) => {
      state = request.state;
      return {
        model: 'mock',
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [key, { type: 'noul', noul: 0 }])
        )
      };
    }) as unknown as TypeSafeClient['systemOne']
  };
  const result = await selectTests({
    tests,
    changes: {
      files: ['e2e/a.spec.ts', 'pnpm-lock.yaml', 'src/payments.ts'],
      generatedFiles: ['e2e/a.spec.ts', 'pnpm-lock.yaml'],
      statuses: [{ status: 'M', path: 'src/payments.ts' }],
      diff: '+payments updated'
    },
    config: { enabled: true, cwd: '/repo' },
    env: {},
    client: mock
  });

  assert.deepEqual(result.selectedIds, ['a']);
  assert.match(state, /src\/payments\.ts/);
  assert.doesNotMatch(state, /pnpm-lock\.yaml|e2e\/a\.spec\.ts/);

  const generatedOnly = await selectTests({
    tests,
    changes: { files: ['pnpm-lock.yaml'], generatedFiles: ['pnpm-lock.yaml'] },
    config: { enabled: true, cwd: '/repo' },
    env: {},
    client: mock
  });
  assert.equal(generatedOnly.fallbackReason, 'no included changes');
  assert.deepEqual(generatedOnly.selectedIds, ['a', 'b', 'c']);
});

test('forced specs resolve against the git root when Playwright runs in a subdirectory', async () => {
  const tests = [
    { id: 'changed', file: '/repo/e2e/checkout.spec.ts', title: 'checkout' },
    { id: 'other', file: '/repo/e2e/other.spec.ts', title: 'other' }
  ];

  const selected = await selectTests({
    tests,
    changes: { root: '/repo', files: ['e2e/checkout.spec.ts'] },
    config: { enabled: true, cwd: '/repo/e2e' },
    env: {}
  });

  assert.deepEqual(selected.selectedIds, ['changed']);
  assert.equal(selected.fallbackReason, undefined);
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

test('complete low probabilities select no tests while incomplete answers run all', async () => {
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

  const noChanges = await selectTests({
    ...input,
    changes: { files: [] },
    client: client([0, 0, 0])
  });
  assert.deepEqual(noChanges.selectedIds, ['a', 'b', 'c']);
  assert.equal(noChanges.fallbackReason, 'no included changes');
});

test('one relevance decision fans out across projects unless perProject is enabled', async () => {
  const catalog = [
    { id: 'chrome-a', file: '/repo/e2e/a.spec.ts', title: 'flow', line: 10, project: 'chromium' },
    { id: 'firefox-a', file: '/repo/e2e/a.spec.ts', title: 'flow', line: 10, project: 'firefox' },
    { id: 'chrome-b', file: '/repo/e2e/a.spec.ts', title: 'flow', line: 30, project: 'chromium' }
  ];
  const requests: string[][] = [];
  const mock: Pick<TypeSafeClient, 'systemOne'> = {
    systemOne: (async ({ questions }: { questions: Record<string, { instructions?: string }> }) => {
      const descriptions = Object.values(questions).map((question) =>
        String(question.instructions)
      );
      requests.push(descriptions);
      return {
        model: 'mock',
        answers: Object.fromEntries(
          Object.keys(questions).map((key, index) => [
            key,
            { type: 'noul', noul: descriptions[index]?.includes(':10|') ? 0.9 : 0.1 }
          ])
        )
      };
    }) as unknown as TypeSafeClient['systemOne']
  };
  const input = {
    tests: catalog,
    changes: { files: ['src/feature.ts'] },
    env: {},
    client: mock
  };

  const shared = await selectTests({ ...input, config: { cwd: '/repo', enabled: true } });
  assert.deepEqual(shared.selectedIds, ['chrome-a', 'firefox-a']);
  assert.deepEqual(
    shared.assessments.map((assessment) => assessment.probability),
    [0.9, 0.9, 0.1]
  );
  assert.equal(requests[0]?.length, 2);
  assert.doesNotMatch(requests[0]?.[0] ?? '', /chromium|firefox/);

  const separate = await selectTests({
    ...input,
    config: { cwd: '/repo', enabled: true, perProject: true }
  });
  assert.deepEqual(separate.selectedIds, ['chrome-a', 'firefox-a']);
  assert.equal(requests[1]?.length, 3);
  assert.match(requests[1]?.[0] ?? '', /chromium/);
  assert.match(requests[1]?.[1] ?? '', /firefox/);
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
          answers: { test_0: { type: 'noul', noul: 0.8 } }
        };
      }) as unknown as TypeSafeClient['systemOne']
    }
  });
  assert.match(question, /^Does checkout depend on test_0\?/);
  assert.match(question, /Test:test_0\|e2e\/a\.spec\.ts\|checkout/);
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

  assert.doesNotMatch(String(without.questions.test_0?.instructions), /x{60}/);
  assert.match(String(withSource.questions.test_0?.instructions), /x{60}/);
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
    resolveConfig({ cwd: '/repo' }, {})
  );
  const state = String(request.state);
  assert.match(state, /M src\/payments\.ts/);
  assert.doesNotMatch(state, /\/repo\/e2e\/a\.spec\.ts/);
  assert.match(
    String(request.questions.test_0?.instructions),
    /Test:test_0\|chromium\|e2e\/a\.spec\.ts\|checkout/
  );
  assert.match(state, /Patch:\n\+updated payments/);
  assert.ok(state.length < 3_000);
});

test('empty hints are omitted and generated PR markup is compacted before capping', () => {
  const config = resolveConfig({}, {});
  const blank = String(createRequest([tests[0]!], { files: ['src/payments.ts'] }, config).state);
  assert.doesNotMatch(blank, /^Title:|^Description:/m);

  const marked = String(
    createRequest(
      [tests[0]!],
      {
        files: ['src/payments.ts'],
        title: '  Fix   payments  ',
        description:
          `<!-- ${'generated '.repeat(500)} -->\n<details><summary>Notes</summary>\n` +
          `![Screenshot](https://example.com/screenshot.png)\n[Checkout](https://example.com/checkout) now works.`
      },
      config
    ).state
  );
  assert.match(marked, /Title: Fix payments/);
  assert.match(marked, /Description: Notes Checkout now works\./);
  assert.doesNotMatch(marked, /generated|screenshot\.png|<details>|example\.com/);
});

test('PR hints handle GitHub-flavored tables and task lists without raw markup', () => {
  const request = createRequest(
    [tests[0]!],
    {
      files: ['src/payments.ts'],
      description: '- [x] Checkout covered\n\n| Area | Result |\n| --- | --- |\n| Billing | Done |'
    },
    resolveConfig({}, {})
  );

  const state = String(request.state);
  assert.match(state, /Checkout covered/);
  assert.doesNotMatch(state, /\[x\]|\| Area \||\| Billing \|/);
});

test('source-aware batching uses actual excerpt sizes', async () => {
  const batchSizes: number[] = [];
  const candidates = tests.map((candidate) => ({ ...candidate, source: 'x'.repeat(15_000) }));
  const context = { files: ['src/feature.ts'] };
  const resolved = resolveConfig({ includeTestSource: true, cwd: '/repo' }, {});
  const two = Buffer.byteLength(
    JSON.stringify(createRequest(candidates.slice(0, 2), context, resolved))
  );
  const three = Buffer.byteLength(JSON.stringify(createRequest(candidates, context, resolved)));
  const mockedClient: Pick<TypeSafeClient, 'systemOne'> = {
    systemOne: (async ({ questions }: { questions: Record<string, unknown> }) => {
      const keys = Object.keys(questions);
      batchSizes.push(keys.length);
      return {
        model: 'mock',
        answers: Object.fromEntries(keys.map((key) => [key, { type: 'noul', noul: 1 }]))
      };
    }) as unknown as TypeSafeClient['systemOne']
  };

  const selection = await selectTests({
    tests: candidates,
    changes: context,
    config: {
      enabled: true,
      includeTestSource: true,
      cwd: '/repo',
      limits: { requestTokens: Math.floor((two + three) / 2) }
    },
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
          Object.keys(questions).map((key) => [key, { type: 'noul', noul: 1 }])
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
    return Buffer.byteLength(JSON.stringify(request));
  };
  const one = estimate(createRequest(tests.slice(0, 1), changes, config));
  const two = estimate(createRequest(tests.slice(0, 2), changes, config));
  const limit = Math.floor((one + two) / 2);
  const calls: number[] = [];
  const mockedClient: Pick<TypeSafeClient, 'systemOne'> = {
    systemOne: (async ({ questions }: { questions: Record<string, unknown> }) => {
      calls.push(Object.keys(questions).length);
      return {
        model: 'mock',
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul', noul: 1 }])
        )
      };
    }) as unknown as TypeSafeClient['systemOne']
  };

  const options = { enabled: true, cwd: '/repo', limits: { requestTokens: limit } };
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

test('independent request batches run concurrently within the configured limit', async () => {
  const changes = { files: ['src/feature.ts'] };
  const resolved = resolveConfig({ cwd: '/repo' }, {});
  const single = Buffer.byteLength(
    JSON.stringify(createRequest(tests.slice(0, 1), changes, resolved))
  );
  const pair = Buffer.byteLength(
    JSON.stringify(createRequest(tests.slice(0, 2), changes, resolved))
  );
  const requestTokens = Math.floor((single + pair) / 2);
  const gate = Promise.withResolvers<void>();
  let inFlight = 0;
  let peak = 0;
  let started = 0;
  const mock: Pick<TypeSafeClient, 'systemOne'> = {
    systemOne: (async ({ questions }: { questions: Record<string, unknown> }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (++started === 2) gate.resolve();
      await Promise.race([gate.promise, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
      inFlight--;
      return {
        model: 'mock',
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul', noul: 0.9 }])
        )
      };
    }) as unknown as TypeSafeClient['systemOne']
  };

  const selected = await selectTests({
    tests,
    changes,
    env: {},
    client: mock,
    config: { enabled: true, cwd: '/repo', limits: { requestTokens, maxConcurrentRequests: 2 } }
  });

  assert.equal(started, 3);
  assert.equal(peak, 2);
  assert.deepEqual(selected.selectedIds, ['a', 'b', 'c']);
  assert.equal(selected.fallbackReason, undefined);
});

test('one failed concurrent batch stops scheduling and falls back after in-flight calls settle', async () => {
  const changes = { files: ['src/feature.ts'] };
  const resolved = resolveConfig({ cwd: '/repo' }, {});
  const single = Buffer.byteLength(
    JSON.stringify(createRequest(tests.slice(0, 1), changes, resolved))
  );
  const pair = Buffer.byteLength(
    JSON.stringify(createRequest(tests.slice(0, 2), changes, resolved))
  );
  const requestTokens = Math.floor((single + pair) / 2);
  let started = 0;
  let settled = 0;
  const mock: Pick<TypeSafeClient, 'systemOne'> = {
    systemOne: (async ({ questions }: { questions: Record<string, unknown> }) => {
      const number = ++started;
      if (number === 1) throw new Error('provider unavailable');
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      settled++;
      return {
        model: 'mock',
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul', noul: 0.9 }])
        )
      };
    }) as unknown as TypeSafeClient['systemOne']
  };

  const selected = await selectTests({
    tests,
    changes,
    env: {},
    client: mock,
    config: { enabled: true, cwd: '/repo', limits: { requestTokens, maxConcurrentRequests: 2 } }
  });

  assert.equal(started, 2);
  assert.equal(settled, 1);
  assert.deepEqual(selected.selectedIds, ['a', 'b', 'c']);
  assert.match(selected.fallbackReason ?? '', /provider unavailable/);
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
      const keys = Object.keys(request.questions);
      const probabilities = keys.map((key) => {
        const line = String((request.questions[key] as { instructions?: string })?.instructions);
        return (request.state.includes('ALPHA_PATCH') && line.includes('checkout')) ||
          (request.state.includes('BETA_PATCH') && line.includes('login'))
          ? 1
          : 0;
      });
      return {
        model: 'mock',
        answers: Object.fromEntries(
          keys.map((key, index) => [key, { type: 'noul', noul: probabilities[index] }])
        )
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
