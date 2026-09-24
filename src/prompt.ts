import type { SystemOneRequest } from '@typesafe-ai/sdk';
import { noul } from '@typesafe-ai/sdk';
import type { ResolvedConfig } from './config.js';
import type { Changes } from './git.js';
import type { TestDescriptor } from './selection.js';
import { limitTestSource } from './source.js';

/** Default question includes the full candidate key because question identifiers are not model instructions. */
export function defaultQuestion(_test: TestDescriptor, key: string): string {
  return `Could the changed behavior affect the assertions or setup of ${key}, directly or indirectly?`;
}

/** Build one typed yes/no question per candidate in a bounded batch. */
export function createRequest(
  batch: TestDescriptor[],
  changes: Changes,
  config: ResolvedConfig
): SystemOneRequest {
  const questions: SystemOneRequest['questions'] = {};
  const candidates: Record<
    string,
    { file: string; title: string; project: string; source: string }
  > = {};
  for (const [index, test] of batch.entries()) {
    const key = `test_${index}`;
    questions[key] = noul((config.createQuestion ?? defaultQuestion)(test, key));
    candidates[key] = {
      file: test.file,
      title: test.title,
      project: test.project ?? '',
      source: config.includeTestSource
        ? limitTestSource(test.source ?? '', config.maxTestSourceTokens)
        : ''
    };
  }
  return {
    model: config.model,
    state: {
      change: {
        files: changes.files,
        diff: changes.diff ?? '',
        title: changes.title ?? config.prTitle ?? '',
        description: changes.description ?? config.prDescription ?? ''
      },
      candidates
    },
    questions
  };
}
