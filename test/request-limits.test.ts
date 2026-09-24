import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfig } from '../src/config.js';
import { createRequest } from '../src/prompt.js';
import { fitsRequestLimits } from '../src/request-limits.js';

test('request sizing enforces both state-and-question and total-request budgets', () => {
  const config = resolveConfig({}, {});
  const request = createRequest(
    [{ id: 'checkout', file: 'e2e/checkout.spec.ts', title: 'checkout' }],
    { files: ['src/checkout.ts'], diff: '+change' },
    config
  );
  const stateBytes = Buffer.byteLength(JSON.stringify(request.state));
  const longestQuestionBytes = Math.max(
    ...Object.values(request.questions).map((question) =>
      Buffer.byteLength(JSON.stringify(question))
    )
  );
  const requestBytes = Buffer.byteLength(JSON.stringify(request));

  assert.equal(
    fitsRequestLimits(request, {
      stateAndQuestionTokens: stateBytes + longestQuestionBytes,
      requestTokens: requestBytes
    }),
    true
  );
  assert.equal(
    fitsRequestLimits(request, {
      stateAndQuestionTokens: stateBytes + longestQuestionBytes - 1,
      requestTokens: requestBytes
    }),
    false
  );
  assert.equal(
    fitsRequestLimits(request, {
      stateAndQuestionTokens: stateBytes + longestQuestionBytes,
      requestTokens: requestBytes - 1
    }),
    false
  );
});
