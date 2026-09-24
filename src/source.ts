import { readFile, stat } from 'node:fs/promises';
import type { TestCase } from '@playwright/test/reporter';
import jsTokens from 'js-tokens';
import type { TestDescriptor } from './selection.js';

interface LocatedTest {
  index: number;
  line: number;
}

interface FileGroup {
  file: string;
  tests: LocatedTest[];
}

interface Excerpt {
  index: number;
  source: string;
}

/** Bound lexical code tokens while keeping a hard size cap for long literals and comments. */
export function limitTestSource(source: string, maxTokens: number): string {
  const maxChars = Math.min(25_000, maxTokens * 12);
  let result = '';
  let counted = 0;

  for (const token of jsTokens(source, { jsx: true })) {
    if (token.type !== 'WhiteSpace' && token.type !== 'LineTerminatorSequence') {
      if (counted >= maxTokens) break;
      counted++;
    }

    const remaining = maxChars - result.length;
    if (remaining <= 0) break;
    result += token.value.slice(0, remaining);
  }

  return result;
}

function groupTests(tests: TestCase[]): FileGroup[] {
  const groups = new Map<string, LocatedTest[]>();

  for (const [index, test] of tests.entries()) {
    const file = test.location.file;
    const group = groups.get(file) ?? [];
    group.push({ index, line: test.location.line });
    groups.set(file, group);
  }

  return [...groups].map(([file, group]) => ({ file, tests: group }));
}

async function extractFileSources(group: FileGroup, maxTokens: number): Promise<Excerpt[]> {
  const info = await stat(group.file);
  if (info.size > 2_000_000)
    throw new Error(`Spec too large to read for source context: ${group.file}`);

  const lines = (await readFile(group.file, 'utf8')).split('\n');
  const ordered = group.tests.toSorted((a, b) => a.line - b.line);
  const excerpts: Excerpt[] = [];
  const nextLine = new Map<number, number>();

  let next = lines.length + 1;
  for (let index = ordered.length - 1; index >= 0; index--) {
    const line = ordered[index]?.line;
    if (line === undefined || nextLine.has(line)) continue;

    nextLine.set(line, next);
    next = line;
  }

  for (const test of ordered) {
    const start = Math.max(0, test.line - 1);
    const end = Math.min(start + 40, (nextLine.get(test.line) ?? lines.length + 1) - 1);
    excerpts.push({
      index: test.index,
      source: limitTestSource(lines.slice(start, end).join('\n'), maxTokens)
    });
  }

  return excerpts;
}

/** Read up to four specs at once, retaining only bounded excerpts after each read. */
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
