import { resolve } from 'node:path';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { JevPlaywrightConfig, ResolvedConfig } from './config.js';
import { filterPaths, resolveConfig } from './config.js';
import type { Changes } from './git.js';
import { createRequest } from './prompt.js';

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
  selectedIds: string[];
  assessments: Assessment[];
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

function sameFile(changed: string, file: string, cwd: string): boolean {
  return resolve(cwd, changed) === resolve(cwd, file);
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
  client: Pick<TypeSafeClient, 'systemOne'>
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
  const response = await client.systemOne(prepared);
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

async function assessCandidates(
  candidates: TestDescriptor[],
  changes: Changes,
  config: ResolvedConfig,
  client: Pick<TypeSafeClient, 'systemOne'>
): Promise<Assessment[]> {
  const assessments: Assessment[] = [];
  // Leave room for the diff and questions when source excerpts are enabled.
  const size = config.includeTestSource
    ? Math.min(
        config.batchSize,
        Math.max(1, Math.floor(40_000 / Math.min(25_000, config.maxTestSourceTokens * 12)))
      )
    : config.batchSize;
  for (let offset = 0; offset < candidates.length; offset += size) {
    const batch = candidates.slice(offset, offset + size);
    assessments.push(...(await assessBatch(batch, changes, config, client)));
  }
  return assessments;
}

function buildSelection(
  tests: TestDescriptor[],
  forced: Set<string>,
  assessments: Assessment[],
  threshold: number
): Selection {
  const selected = new Set(forced);
  for (const assessment of assessments) {
    if (assessment.probability >= threshold) selected.add(assessment.id);
  }
  if (!selected.size) throw new Error('No tests selected');
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
  const files = filterPaths(input.changes.files, config);
  if (!files.length) return allTests(input.tests, 'no included changes');
  if ((input.changes.diff?.length ?? 0) > 60_000)
    return allTests(input.tests, 'diff exceeds context budget');

  // A spec edit is always executed even when its path is excluded from model context.
  const forced = forcedIds(input.tests, input.changes.files, config.cwd);
  const candidates = input.tests.filter((test) => !forced.has(test.id));
  if (!candidates.length)
    return { selectedIds: input.tests.map((test) => test.id), assessments: [] };
  try {
    const assessments = await assessCandidates(
      candidates,
      { ...input.changes, files },
      config,
      sdkClient(input, config)
    );
    return buildSelection(input.tests, forced, assessments, config.threshold);
  } catch (error) {
    // A partial batch cannot safely exclude candidates that were never evaluated.
    return allTests(input.tests, String(error));
  }
}
