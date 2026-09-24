import { isAbsolute, relative, resolve } from 'node:path';
import type { SystemOneRequest } from '@typesafe-ai/sdk';
import { noul } from '@typesafe-ai/sdk';
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

function testPath(file: string, cwd: string): string {
  const path = isAbsolute(file) ? file : resolve(cwd, file);
  return relative(cwd, path).replaceAll('\\', '/');
}

/** Identify the test within instructions because question keys are not model context. */
export function defaultQuestion(_test: TestDescriptor, key: string): string {
  return `Could the change affect the assertions or setup of ${key} described below, directly or indirectly?`;
}

function testQuestion(test: TestDescriptor, key: string, config: ResolvedConfig): string {
  return [
    (config.createQuestion ?? defaultQuestion)(test, key),
    `Test: ${key} | ${compactLine(test.project ?? '')} | ${compactLine(testPath(test.file, config.cwd))} | ${compactLine(test.title)}`,
    ...(config.includeTestSource && test.source
      ? [`Test source:\n${limitTestSource(test.source, config.maxTestSourceTokens)}`]
      : [])
  ].join('\n');
}

/** Build one typed yes/no question per candidate in a bounded batch. */
export function createRequest(
  batch: TestDescriptor[],
  changes: Changes,
  config: ResolvedConfig
): SystemOneRequest {
  const questions: SystemOneRequest['questions'] = {};

  for (const [index, test] of batch.entries()) {
    const key = `test_${index}`;
    questions[key] = noul(testQuestion(test, key, config));
  }

  const title = titleHint(config.prTitle ?? changes.title);
  const description = descriptionHint(config.prDescription ?? changes.description);

  return {
    model: config.model,
    state: [
      ...(title ? [`Title: ${title}`] : []),
      ...(description ? [`Description: ${description}`] : []),
      'Changed files (status and path):',
      ...changedPaths(changes),
      ...(changes.diff ? ['Patch:', changes.diff] : [])
    ].join('\n'),
    questions
  };
}
