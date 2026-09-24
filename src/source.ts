import { readFile, stat } from 'node:fs/promises';
import type { TestCase } from '@playwright/test/reporter';
import createDebug from 'debug';
import jsTokens from 'js-tokens';
import type { TestDescriptor } from './selection.js';
import type { TestLocation } from './test-body.js';
import { extractTestBodies } from './test-body.js';

const debug = createDebug('jev-playwright:source');

interface FileGroup {
  file: string;
  tests: TestLocation[];
}

interface Excerpt {
  index: number;
  source: string;
}

/** Bound unusually long literals without truncating ordinary short-token expressions too aggressively. */
export function sourceCharLimit(maxTokens: number): number {
  return Math.min(15_000, maxTokens * 6);
}

/** Compact insignificant whitespace while bounding lexical tokens and unusually long literals. */
export function limitTestSource(source: string, maxTokens: number): string {
  const maxChars = sourceCharLimit(maxTokens);
  let result = '';
  let counted = 0;
  let pendingSpace = false;
  let pendingNewline = false;

  for (const token of jsTokens(source, { jsx: true })) {
    if (token.type === 'WhiteSpace') {
      if (result && !pendingNewline) pendingSpace = true;
      continue;
    }

    if (token.type === 'LineTerminatorSequence') {
      pendingNewline = true;
      pendingSpace = false;
      continue;
    }

    if (counted >= maxTokens) break;
    const separator = pendingNewline && result ? '\n' : pendingSpace ? ' ' : '';
    const remaining = maxChars - result.length;
    if (remaining <= 0) break;

    // Keep line breaks for comments and automatic semicolon insertion; tokens stay untouched until the cap.
    result += `${separator}${token.value}`.slice(0, remaining);
    counted++;
    pendingSpace = false;
    pendingNewline = false;
  }

  return result;
}

function groupTests(tests: TestCase[]): FileGroup[] {
  const groups = new Map<string, TestLocation[]>();

  for (const [index, test] of tests.entries()) {
    const file = test.location.file;
    const group = groups.get(file) ?? [];
    group.push({ index, line: test.location.line, column: test.location.column });
    groups.set(file, group);
  }

  return [...groups].map(([file, group]) => ({ file, tests: group }));
}

async function extractFileSources(group: FileGroup, maxTokens: number): Promise<Excerpt[]> {
  try {
    const info = await stat(group.file);
    if (info.size > 2_000_000) throw new Error('spec exceeds the 2 MB source-extraction limit');

    const contents = await readFile(group.file, 'utf8');
    const bodies = extractTestBodies(group.file, contents, group.tests);
    return group.tests.flatMap((test) => {
      const body = bodies.get(test.index);
      return body === undefined
        ? []
        : [{ index: test.index, source: limitTestSource(body, maxTokens) }];
    });
  } catch (error) {
    // Source context is optional; keep the test available for title/path-based selection.
    debug('source omitted for %s: %O', group.file, error);
    return [];
  }
}

/** Parse up to four specs at once, retaining only bounded test bodies after each read. */
export async function withTestSource(
  tests: TestCase[],
  descriptors: TestDescriptor[],
  maxTokens: number
): Promise<TestDescriptor[]> {
  if (tests.length !== descriptors.length)
    throw new Error('Test catalog and source locations differ');

  const result = [...descriptors];
  const groups = groupTests(tests);

  for (let offset = 0; offset < groups.length; offset += 4) {
    const batch = groups.slice(offset, offset + 4);
    const excerpts = await Promise.all(batch.map((group) => extractFileSources(group, maxTokens)));

    for (const fileExcerpts of excerpts) {
      for (const excerpt of fileExcerpts) {
        const descriptor = result[excerpt.index];
        if (!descriptor) throw new Error('Missing test descriptor for source excerpt');
        result[excerpt.index] = { ...descriptor, source: excerpt.source };
      }
    }
  }

  return result;
}
