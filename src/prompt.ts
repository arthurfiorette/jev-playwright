import type { SystemOneRequest } from '@typesafe-ai/sdk';
import { choice, noul } from '@typesafe-ai/sdk';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import stripMarkdown from 'strip-markdown';
import type { ResolvedConfig } from './config.js';
import type { Changes } from './git.js';
import type { TestDescriptor } from './selection.js';
import { limitTestSource } from './source.js';

const plainText = remark().use(remarkGfm).use(stripMarkdown);

function compactLine(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleHint(value: string | undefined): string | undefined {
  const text = compactLine(value ?? '').slice(0, 200);
  return text || undefined;
}

function descriptionHint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Preserve prose inside PR disclosure tags before remark discards raw HTML nodes.
  const markdown = value
    .replace(/<\/?(?:details|summary)\b[^>]*>/gi, '\n')
    .replace(/!\[[^\]]*\]\([^\n)]*\)/g, ' ');
  const text = compactLine(String(plainText.processSync(markdown))).slice(0, 2_000);
  return text || undefined;
}

function changedPaths(changes: Changes): string[] {
  if (!changes.statuses) return changes.files.map((path) => `? ${compactLine(path)}`);

  return changes.statuses.map((entry) =>
    entry.previousPath
      ? `${entry.status} ${compactLine(entry.previousPath)} -> ${compactLine(entry.path)}`
      : `${entry.status} ${compactLine(entry.path)}`
  );
}

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
  const candidateLines: string[] = [];

  for (const [index, test] of batch.entries()) {
    const key = `test_${index}`;
    questions[key] = noul((config.createQuestion ?? defaultQuestion)(test, key));
    candidateLines.push(
      `${key} | ${compactLine(test.project ?? '')} | ${compactLine(test.file)} | ${compactLine(test.title)}`
    );
    if (config.includeTestSource && test.source) {
      candidateLines.push(limitTestSource(test.source, config.maxTestSourceTokens));
    }
  }

  questions.scope = choice(
    'For the changed behavior, how many of the candidate tests in this batch could have their behavior or setup affected, directly or indirectly?',
    {
      all: 'Every listed candidate test could be affected.',
      none: 'No listed candidate test could be affected.',
      some: 'At least one but not every listed candidate test could be affected.'
    }
  );
  const title = titleHint(config.prTitle ?? changes.title);
  const description = descriptionHint(config.prDescription ?? changes.description);

  return {
    model: config.model,
    state: [
      ...(title ? [`Title: ${title}`] : []),
      ...(description ? [`Description: ${description}`] : []),
      'Changed files (status and path):',
      ...changedPaths(changes),
      ...(changes.diff ? ['Patch:', changes.diff] : []),
      'Candidate tests (id | project | file | title):',
      ...candidateLines
    ].join('\n'),
    questions
  };
}
