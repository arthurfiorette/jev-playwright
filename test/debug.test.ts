import assert from 'node:assert/strict';
import { test } from 'node:test';
import { format } from 'node:util';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import createDebug from 'debug';
import { resolveConfig } from '../src/config.js';
import { createRequest } from '../src/prompt.js';
import { selectTests } from '../src/selection.js';

test('debug logs full requests, masked config, and one combined selection with locations', async () => {
  const catalog = [
    { id: 'a', file: '/repo/e2e/a.spec.ts', line: 12, column: 3, title: 'checkout' },
    { id: 'b', file: '/repo/e2e/b.spec.ts', line: 28, column: 5, title: 'login' },
    { id: 'c', file: '/repo/e2e/c.spec.ts', line: 31, column: 1, title: 'account' }
  ];
  const changes = { files: ['src/feature.ts'], diff: '+useful patch' };
  const base = resolveConfig({ cwd: '/repo' }, {});
  const one = Buffer.byteLength(JSON.stringify(createRequest(catalog.slice(0, 1), changes, base)));
  const two = Buffer.byteLength(JSON.stringify(createRequest(catalog.slice(0, 2), changes, base)));
  const logs: string[] = [];
  const previousNamespaces = createDebug.disable();
  const previousLog = createDebug.log;
  createDebug.log = (...args) => logs.push(format(...args));
  createDebug.enable(
    'jev-playwright:request,jev-playwright:batch,jev-playwright:selection,jev-playwright:config'
  );

  try {
    const mock: Pick<TypeSafeClient, 'systemOne'> = {
      systemOne: (async ({
        questions
      }: {
        questions: Record<string, { instructions: string }>;
      }) => ({
        model: 'mock',
        answers: Object.fromEntries(
          Object.entries(questions).map(([key, question]) => [
            key,
            {
              type: 'noul',
              noul: question.instructions.includes('checkout')
                ? 0.9
                : question.instructions.includes('login')
                  ? 0.5
                  : 0.1
            }
          ])
        )
      })) as unknown as TypeSafeClient['systemOne']
    };
    const result = await selectTests({
      tests: catalog,
      changes,
      env: {},
      client: mock,
      config: {
        enabled: true,
        cwd: '/repo',
        providerKey: 'sensitive-token',
        limits: { requestTokens: Math.floor((one + two) / 2) }
      }
    });

    assert.deepEqual(result.selectedIds, ['a']);
    assert.equal(
      logs.filter((line) => line.includes('request ') && line.includes(' state')).length,
      3
    );
    assert.equal(
      logs.filter((line) => line.includes('request ') && line.includes(' questions')).length,
      3
    );
    assert.ok(logs.some((line) => line.includes('+useful patch')));
    assert.ok(logs.some((line) => line.includes('e2e/a.spec.ts:12:3|checkout')));
    assert.ok(logs.some((line) => line.includes("providerKey: '[redacted]'")));
    assert.ok(!logs.some((line) => line.includes('sensitive-token')));
    const summaries = logs.filter((line) => line.includes('selection result'));
    assert.equal(summaries.length, 1);
    assert.match(summaries[0]!, /selected: 1,\s*excluded: 2/);
    assert.match(summaries[0]!, /e2e\/a\.spec\.ts:12:3/);
    assert.match(summaries[0]!, /e2e\/b\.spec\.ts:28:5/);
    assert.match(summaries[0]!, /e2e\/c\.spec\.ts:31:1/);
    assert.ok(
      logs.every((line) => !line.includes('topSelected') || line.includes('selection result'))
    );
  } finally {
    createDebug.disable();
    createDebug.enable(previousNamespaces);
    createDebug.log = previousLog;
  }
});
