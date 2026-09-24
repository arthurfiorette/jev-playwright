import type { TypeSafeClient } from '@typesafe-ai/sdk';
import type { ResolvedConfig } from './config.js';
import { selectionDebug } from './debug.js';
import type { Changes } from './git.js';
import { createRequest } from './prompt.js';
import { fitsRequestLimits } from './request-limits.js';
import type { Assessment, TestDescriptor } from './selection.js';

interface PlannedBatch {
  tests: TestDescriptor[];
  changes: Changes;
}

interface BatchQueue {
  next: number;
  stopped: boolean;
  results: Assessment[][];
}

function nextCandidateBatch(
  candidates: TestDescriptor[],
  start: number,
  changes: Changes,
  config: ResolvedConfig
): TestDescriptor[] {
  const batch: TestDescriptor[] = [];

  for (let index = start; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (!candidate) break;

    const proposed = [...batch, candidate];
    if (!fitsRequestLimits(createRequest(proposed, changes, config), config.limits)) {
      if (!batch.length) throw new Error('Jev state or a single test exceeds configured limits');
      break;
    }

    batch.push(candidate);
  }

  return batch;
}

function candidateBatches(
  candidates: TestDescriptor[],
  changes: Changes,
  config: ResolvedConfig
): TestDescriptor[][] {
  const batches: TestDescriptor[][] = [];

  for (let offset = 0; offset < candidates.length; ) {
    const batch = nextCandidateBatch(candidates, offset, changes, config);
    batches.push(batch);
    offset += batch.length;
  }

  return batches;
}

function planRequests(
  contexts: Changes[],
  candidates: TestDescriptor[],
  config: ResolvedConfig
): PlannedBatch[] {
  const plan: PlannedBatch[] = [];

  for (const changes of contexts) {
    for (const tests of candidateBatches(candidates, changes, config)) {
      if (plan.length >= config.limits.maxRequests) {
        throw new Error('Jev request count exceeds configured limits');
      }
      plan.push({ tests, changes });
    }
  }

  return plan;
}

async function assessBatch(
  batch: PlannedBatch,
  config: ResolvedConfig,
  client: Pick<TypeSafeClient, 'systemOne'>,
  requestNumber: number
): Promise<Assessment[]> {
  const { tests, changes } = batch;
  const request = createRequest(tests, changes, config);
  const prepared = config.beforeRequest
    ? await config.beforeRequest(request, { changes, tests })
    : request;
  if (
    !prepared?.questions ||
    tests.some((_, index) => prepared.questions[`test_${index}`]?.type !== 'noul')
  ) {
    throw new Error('beforeRequest must retain each typed relevance question');
  }
  if (!fitsRequestLimits(prepared, config.limits)) {
    throw new Error('Jev request exceeds configured limits after beforeRequest');
  }

  selectionDebug(`request ${requestNumber} state %O`, prepared.state);
  selectionDebug(`request ${requestNumber} questions %O`, prepared.questions);
  const response = await client.systemOne(prepared);
  selectionDebug(`request ${requestNumber} response %O`, response);

  const assessments: Assessment[] = [];
  for (const [index, test] of tests.entries()) {
    const answer = response.answers?.[`test_${index}`];
    if (
      answer?.type !== 'noul' ||
      !Number.isFinite(answer.noul) ||
      answer.noul < 0 ||
      answer.noul > 1
    ) {
      throw new Error(`Invalid Jev answer for ${test.id}`);
    }
    assessments.push({ id: test.id, probability: answer.noul, model: response.model });
  }

  return assessments;
}

async function processBatchQueue(
  queue: BatchQueue,
  plan: PlannedBatch[],
  config: ResolvedConfig,
  client: Pick<TypeSafeClient, 'systemOne'>
): Promise<void> {
  while (!queue.stopped) {
    const index = queue.next++;
    const batch = plan[index];
    if (!batch) return;

    try {
      queue.results[index] = await assessBatch(batch, config, client, index + 1);
    } catch (error) {
      // Wait for already-started requests, but do not launch more after a failed batch.
      queue.stopped = true;
      throw error;
    }
  }
}

/** Evaluate all planned batches with bounded concurrency, or reject the complete selection. */
export async function runBatches(
  contexts: Changes[],
  candidates: TestDescriptor[],
  config: ResolvedConfig,
  client: Pick<TypeSafeClient, 'systemOne'>
): Promise<Assessment[]> {
  const plan = planRequests(contexts, candidates, config);
  const count = Math.min(config.limits.maxConcurrentRequests, plan.length);
  selectionDebug('request plan %O', { batches: plan.length, concurrency: count });

  const queue: BatchQueue = { next: 0, stopped: false, results: [] };
  const workers = Array.from({ length: count }, () =>
    processBatchQueue(queue, plan, config, client)
  );
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;

  return queue.results.flat();
}
