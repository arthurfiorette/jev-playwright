import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { JevPlaywrightConfig, ResolvedConfig } from './config.js';
import { filterPaths, resolveConfig } from './config.js';
import { debugLog } from './debug.js';
import type { Changes } from './git.js';
import { createRequest } from './prompt.js';
import { fitsRequestLimits } from './request-limits.js';

/** A discovered Playwright test. IDs must be unique within a selection call. */
export interface TestDescriptor {
  id: string;
  file: string;
  title: string;
  project?: string;
  /** Optional source context supplied by Playwright or the caller. */
  source?: string;
}

/** Probability returned by Jev for a candidate. */
export interface Assessment {
  id: string;
  probability: number;
  model: string;
}

/** Selected IDs and evidence for inspecting a decision. */
export interface Selection {
  /** Empty only after complete, consistent Jev answers select no tests. */
  selectedIds: string[];
  assessments: Assessment[];
  /** Set when selection is unavailable or inconsistent; selectedIds then contains every test. */
  fallbackReason?: string;
}

/** Explicit inputs allow use without git or a Playwright process. */
export interface SelectionInput {
  tests: TestDescriptor[];
  changes: Changes;
  config?: JevPlaywrightConfig;
  /** Environment snapshot for isolated library calls. */
  env?: NodeJS.ProcessEnv;
  /** Per-call override for the configured SDK client. */
  client?: Pick<TypeSafeClient, 'systemOne'>;
}

function allTests(tests: TestDescriptor[], reason: string): Selection {
  return { selectedIds: tests.map((test) => test.id), assessments: [], fallbackReason: reason };
}

/** Match repo-relative git paths to Playwright paths, including symlinked checkouts. */
export function sameFile(changed: string, file: string, cwd: string): boolean {
  const path = resolve(cwd, changed);
  if (path === resolve(cwd, file)) return true;
  if (basename(path) !== basename(file)) return false;

  // Git resolves symlinked checkouts while Playwright can report their original paths.
  try {
    return realpathSync(path) === realpathSync(file);
  } catch {
    return false;
  }
}

function forcedIds(tests: TestDescriptor[], files: string[], cwd: string): Set<string> {
  const ids = new Set<string>();
  for (const test of tests) {
    if (files.some((file) => sameFile(file, test.file, cwd))) ids.add(test.id);
  }
  return ids;
}

function sdkClient(
  input: SelectionInput,
  config: ResolvedConfig
): Pick<TypeSafeClient, 'systemOne'> {
  return (
    input.client ??
    config.client ??
    new TypeSafeClient({
      ...(config.providerKey ? { apiKey: config.providerKey } : {}),
      ...(config.providerUrl ? { baseURL: config.providerUrl } : {})
    })
  );
}

async function assessBatch(
  tests: TestDescriptor[],
  changes: Changes,
  config: ResolvedConfig,
  client: Pick<TypeSafeClient, 'systemOne'>,
  counter: { requests: number }
): Promise<Assessment[]> {
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

  if (++counter.requests > config.limits.maxRequests) {
    throw new Error('Jev request count exceeds configured limits');
  }
  debugLog(config.debug, `request ${counter.requests} state`, prepared.state);
  debugLog(config.debug, `request ${counter.requests} questions`, prepared.questions);
  const response = await client.systemOne(prepared);
  debugLog(config.debug, `request ${counter.requests} response`, response);

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

async function assessCandidates(
  candidates: TestDescriptor[],
  changes: Changes,
  config: ResolvedConfig,
  client: Pick<TypeSafeClient, 'systemOne'>,
  counter: { requests: number }
): Promise<Assessment[]> {
  const assessments: Assessment[] = [];

  for (let offset = 0; offset < candidates.length; ) {
    const batch = nextCandidateBatch(candidates, offset, changes, config);
    assessments.push(...(await assessBatch(batch, changes, config, client, counter)));
    offset += batch.length;
  }
  return assessments;
}

function chunkChanges(
  changes: Changes,
  candidate: TestDescriptor,
  config: ResolvedConfig
): Changes[] {
  if (!changes.patches?.length) {
    throw new Error('Oversized change has no complete per-file patches to split');
  }

  const chunks: Changes[] = [];
  let patches: string[] = [];

  for (const patch of changes.patches) {
    const proposed = [...patches, patch];
    const proposedChanges = { ...changes, diff: proposed.join('\n') };
    if (fitsRequestLimits(createRequest([candidate], proposedChanges, config), config.limits)) {
      patches = proposed;
      continue;
    }

    if (!patches.length) throw new Error('A single file patch exceeds configured limits');
    chunks.push({ ...changes, diff: patches.join('\n') });
    patches = [patch];
    if (
      !fitsRequestLimits(
        createRequest([candidate], { ...changes, diff: patch }, config),
        config.limits
      )
    ) {
      throw new Error('A single file patch exceeds configured limits');
    }
  }

  if (patches.length) chunks.push({ ...changes, diff: patches.join('\n') });
  return chunks;
}

async function assessEveryChange(
  candidates: TestDescriptor[],
  changes: Changes,
  config: ResolvedConfig,
  client: Pick<TypeSafeClient, 'systemOne'>
): Promise<Assessment[]> {
  const first = candidates[0];
  if (!first) return [];

  // Reuse the complete patch when it fits; only split after this preflight fails.
  const contexts = fitsRequestLimits(createRequest([first], changes, config), config.limits)
    ? [changes]
    : chunkChanges(changes, first, config);
  debugLog(
    config.debug,
    'diff chunks',
    contexts.map((context, index) => ({
      index: index + 1,
      total: contexts.length,
      patchBytes: Buffer.byteLength(context.diff ?? '', 'utf8')
    }))
  );
  const counter = { requests: 0 };
  const byId = new Map<string, Assessment>();

  for (const context of contexts) {
    const assessments = await assessCandidates(candidates, context, config, client, counter);
    for (const assessment of assessments) {
      const previous = byId.get(assessment.id);
      if (!previous || assessment.probability > previous.probability) {
        byId.set(assessment.id, assessment);
      }
    }
  }

  return candidates.map((candidate) => {
    const assessment = byId.get(candidate.id);
    if (!assessment) throw new Error(`Missing Jev answer for ${candidate.id}`);
    return assessment;
  });
}

function buildSelection(
  tests: TestDescriptor[],
  forced: Set<string>,
  assessments: Assessment[],
  config: ResolvedConfig
): Selection {
  const selected = new Set(forced);
  for (const assessment of assessments) {
    if (assessment.probability >= config.threshold) selected.add(assessment.id);
  }
  return {
    selectedIds: tests.filter((test) => selected.has(test.id)).map((test) => test.id),
    assessments
  };
}

/** Select relevant tests, retaining changed specs and falling back to all on incomplete context or answers. */
export async function selectTests(input: SelectionInput): Promise<Selection> {
  const config = resolveConfig(input.config, input.env);
  if (!config.enabled) return allTests(input.tests, 'disabled');
  if (new Set(input.tests.map((test) => test.id)).size !== input.tests.length)
    throw new Error('Test IDs must be unique');

  const root = input.changes.root ?? config.cwd;
  const forced = forcedIds(input.tests, input.changes.files, root);
  const files = filterPaths(input.changes.files, config);
  const changedSpecs = input.tests.filter((test) => forced.has(test.id));
  const modelFiles = files.filter(
    (file) => !changedSpecs.some((test) => sameFile(file, test.file, root))
  );
  debugLog(config.debug, 'model paths', modelFiles);
  if (!modelFiles.length) {
    return forced.size
      ? {
          selectedIds: input.tests.filter((test) => forced.has(test.id)).map((test) => test.id),
          assessments: []
        }
      : allTests(input.tests, 'no included changes');
  }

  // A spec edit is always executed even when its path is excluded from model context.
  const candidates = input.tests.filter((test) => !forced.has(test.id));
  if (!candidates.length)
    return { selectedIds: input.tests.map((test) => test.id), assessments: [] };
  try {
    const changes = {
      ...input.changes,
      files: modelFiles,
      ...(input.changes.statuses
        ? { statuses: input.changes.statuses.filter((entry) => modelFiles.includes(entry.path)) }
        : {})
    };
    const assessments = await assessEveryChange(
      candidates,
      changes,
      config,
      sdkClient(input, config)
    );
    return buildSelection(input.tests, forced, assessments, config);
  } catch (error) {
    // A partial batch cannot safely exclude candidates that were never evaluated.
    return allTests(input.tests, String(error));
  }
}
