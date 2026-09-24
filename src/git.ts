import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ResolvedConfig } from './config.js';
import { filterPaths } from './config.js';

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: string[]): Promise<string> {
  return (await execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })).stdout;
}

function parsePaths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function relevantPaths(paths: string[], config?: ResolvedConfig): string[] {
  return config ? filterPaths(paths, config) : paths;
}

async function readUntrackedFile(cwd: string, path: string): Promise<string> {
  const content = await readFile(resolve(cwd, path));
  if (content.includes(0) || content.length > 60_000) {
    throw new Error(`Cannot safely include untracked file: ${path}`);
  }

  return `Untracked file: ${path}\n${content.toString('utf8')}`;
}

async function readUntracked(
  cwd: string,
  paths: string[],
  config?: ResolvedConfig
): Promise<string> {
  const relevant = relevantPaths(paths, config);
  const snippets: string[] = [];
  let length = 0;

  for (let offset = 0; offset < relevant.length; offset += 4) {
    const batch = relevant.slice(offset, offset + 4);
    const loaded = await Promise.all(batch.map((path) => readUntrackedFile(cwd, path)));
    snippets.push(...loaded);
    length += loaded.reduce((size, snippet) => size + snippet.length, 0);
    if (length > 60_000) throw new Error('Untracked changes exceed context budget');
  }

  return snippets.join('\n');
}

/** Changed paths and a bounded patch for test relevance decisions. */
export interface Changes {
  files: string[];
  diff?: string;
  title?: string;
  description?: string;
}

/** Read committed changes against merge-base, or local staged, unstaged and untracked changes. */
export async function getGitChanges(
  cwd: string,
  baseRef?: string,
  config?: ResolvedConfig
): Promise<Changes> {
  if (baseRef) {
    const base = (await runGit(cwd, ['merge-base', baseRef, 'HEAD'])).trim();
    const files = parsePaths(await runGit(cwd, ['diff', '--name-only', '-z', base, 'HEAD']));
    const included = relevantPaths(files, config);
    const diff = included.length
      ? await runGit(cwd, ['diff', '--no-ext-diff', '--unified=1', base, 'HEAD', '--', ...included])
      : '';

    return { files, diff };
  }

  const [staged, unstaged, untracked] = await Promise.all([
    runGit(cwd, ['diff', '--cached', '--name-only', '-z']),
    runGit(cwd, ['diff', '--name-only', '-z']),
    runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  ]);
  const files = [
    ...new Set([...parsePaths(staged), ...parsePaths(unstaged), ...parsePaths(untracked)])
  ];
  const included = relevantPaths(files, config);

  const [stagedDiff, unstagedDiff] = included.length
    ? await Promise.all([
        runGit(cwd, ['diff', '--cached', '--no-ext-diff', '--unified=1', '--', ...included]),
        runGit(cwd, ['diff', '--no-ext-diff', '--unified=1', '--', ...included])
      ])
    : ['', ''];
  const diff = `${stagedDiff}\n${unstagedDiff}\n${await readUntracked(cwd, parsePaths(untracked), config)}`;

  return { files, diff };
}
