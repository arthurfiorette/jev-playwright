import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import createDebug from 'debug';
import { runBatches } from './batch.js';
import type { JevPlaywrightConfig, ResolvedConfig } from './config.js';
import { filterPaths, resolveConfig } from './config.js';
import type { Changes } from './git.js';
import { createRequest } from './prompt.js';
import { fitsRequestLimits } from './request-limits.js';

const debug = createDebug('jev-playwright:selection');

/** A discovered Playwright test. IDs must be unique within a selection call. */
export interface TestDescriptor {
  id: string;
  file: string;
  title: string;
  project?: string;
  /** Playwright source line for distinguishing tests with the same title. */
  line?: number;
  /** Playwright source column for distinguishing tests on the same line. */
  column?: number;
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

interface CandidateGroup {
  representative: TestDescriptor;
  members: TestDescriptor[];
}

function groupCandidates(candidates: TestDescriptor[], config: ResolvedConfig): CandidateGroup[] {
  const groups: CandidateGroup[] = [];
  const byTest = new Map<string, CandidateGroup>();

  for (const test of candidates) {
    const key = JSON.stringify([
      resolve(config.cwd, test.file),
      test.title,
      test.line ?? null,
      test.column ?? null
    ]);
    const group = byTest.get(key);
    if (
      !config.perProject &&
      group &&
      !group.members.some((member) => member.project === test.project)
    ) {
      group.members.push(test);
      continue;
    }

    // The shared decision intentionally has no browser label when projects are grouped.
    const { project, ...shared } = test;
    const created: CandidateGroup = {
      representative: config.perProject ? test : shared,
      members: [test]
    };
    groups.push(created);
    if (!config.perProject && !group) byTest.set(key, created);
  }

  return groups;
}

function expandAssessments(groups: CandidateGroup[], assessments: Assessment[]): Assessment[] {
  const byId = new Map(assessments.map((assessment) => [assessment.id, assessment]));
  return groups.flatMap((group) => {
    const assessment = byId.get(group.representative.id);
    if (!assessment) throw new Error(`Missing Jev answer for ${group.representative.id}`);
    return group.members.map((member) => ({ ...assessment, id: member.id }));
  });
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
  debug(
    'diff chunks %O',
    contexts.map((context, index) => ({
      index: index + 1,
      total: contexts.length,
      patchBytes: Buffer.byteLength(context.diff ?? '', 'utf8')
    }))
  );
  const byId = new Map<string, Assessment>();

  for (const assessment of await runBatches(contexts, candidates, config, client)) {
    const previous = byId.get(assessment.id);
    if (!previous || assessment.probability > previous.probability) {
      byId.set(assessment.id, assessment);
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
  const generated = new Set(config.excludeGeneratedFiles ? input.changes.generatedFiles : []);
  const changedSpecs = input.tests.filter((test) => forced.has(test.id));
  const modelFiles = files.filter(
    (file) => !generated.has(file) && !changedSpecs.some((test) => sameFile(file, test.file, root))
  );
  debug('model paths %O', modelFiles);
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
    const groups = groupCandidates(candidates, config);
    debug('candidate groups %O', {
      discovered: candidates.length,
      questions: groups.length,
      perProject: config.perProject
    });
    const changes = {
      ...input.changes,
      files: modelFiles,
      ...(input.changes.statuses
        ? { statuses: input.changes.statuses.filter((entry) => modelFiles.includes(entry.path)) }
        : {})
    };
    const assessments = await assessEveryChange(
      groups.map((group) => group.representative),
      changes,
      config,
      sdkClient(input, config)
    );
    return buildSelection(input.tests, forced, expandAssessments(groups, assessments), config);
  } catch (error) {
    // A partial batch cannot safely exclude candidates that were never evaluated.
    return allTests(input.tests, String(error));
  }
}
