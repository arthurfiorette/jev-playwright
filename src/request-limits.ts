import type { SystemOneRequest } from '@typesafe-ai/sdk';
import type { JevRequestLimits } from './config.js';

function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(json, 'utf8');
}

/** Bound requests conservatively when the provider's model tokenizer is unavailable. */
export function fitsRequestLimits(
  request: SystemOneRequest,
  limits: Pick<Required<JevRequestLimits>, 'stateAndQuestionTokens' | 'requestTokens'>
): boolean {
  const stateBytes = jsonBytes(request.state);
  let longestQuestionBytes = 0;

  for (const question of Object.values(request.questions)) {
    longestQuestionBytes = Math.max(longestQuestionBytes, jsonBytes(question));
  }

  return (
    stateBytes + longestQuestionBytes <= limits.stateAndQuestionTokens &&
    jsonBytes(request) <= limits.requestTokens
  );
}
