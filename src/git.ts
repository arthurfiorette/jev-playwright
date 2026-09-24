import { execFile as execFileCallback } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ResolvedConfig } from './config.js';
import { filterPaths, resolveConfig } from './config.js';

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: string[]): Promise<string> {
  return (await execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })).stdout;
}

function parsePaths(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

async function generatedPaths(
  root: string,
  paths: string[],
  config: ResolvedConfig
): Promise<Set<string>> {
  const generated = new Set<string>();
  if (!config.excludeGeneratedFiles) return generated;

  for (let offset = 0; offset < paths.length; offset += 100) {
    const batch = paths.slice(offset, offset + 100);
    const output = await runGit(root, ['check-attr', '-z', 'linguist-generated', '--', ...batch]);
    const fields = output.split('\0');
    if (fields.pop() !== '' || fields.length !== batch.length * 3) {
      throw new Error('Unexpected git check-attr output');
    }

    for (let index = 0; index < fields.length; index += 3) {
      const path = fields[index];
      const attribute = fields[index + 1];
      const value = fields[index + 2];
      if (!path || attribute !== 'linguist-generated' || !value) {
        throw new Error('Unexpected git check-attr entry');
      }
      if (value === 'set' || value === 'true') generated.add(path);
    }
  }

  return generated;
}

/** Git's status and path pair, including the previous path for renames. */
export interface ChangedFile {
  status: string;
  path: string;
  previousPath?: string;
}

function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split('\0').filter(Boolean);
  const entries: ChangedFile[] = [];

  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    const path = fields[index++];
    if (!status || !path) throw new Error('Unexpected git name-status output');

    if (status.startsWith('R') || status.startsWith('C')) {
      const destination = fields[index++];
      if (!destination) throw new Error('Missing renamed file destination');
      entries.push({ status, previousPath: path, path: destination });
      continue;
    }

    entries.push({ status, path });
  }

  return entries;
}

function relevantPaths(
  paths: string[],
  root: string,
  config?: ResolvedConfig,
  excluded?: Set<string>
): string[] {
  const included = config ? filterPaths(paths, config) : paths;
  return excluded ? included.filter((path) => !excluded.has(resolve(root, path))) : included;
}

function splitGitPatches(diff: string): string[] {
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (!diff.trim()) return [];
  if (!starts.length || starts[0] !== 0) throw new Error('Cannot split git patch safely');

  return starts.map((start, index) => diff.slice(start, starts[index + 1] ?? diff.length));
}

function diffFlags(config?: ResolvedConfig): string[] {
  const whitespace = config?.diff.whitespace ?? 'all';
  const whitespaceFlag = {
    all: '--ignore-all-space',
    change: '--ignore-space-change',
    eol: '--ignore-space-at-eol',
    none: ''
  }[whitespace];

  return [
    '--no-ext-diff',
    '--find-renames',
    `--unified=${config?.diff.contextLines ?? 3}`,
    ...(config?.diff.ignoreBlankLines ? ['--ignore-blank-lines'] : []),
    ...(whitespaceFlag ? [whitespaceFlag] : [])
  ];
}

async function readUntrackedFile(cwd: string, path: string, maxBytes: number): Promise<string> {
  // Follow untracked symlinks intentionally; use include/exclude globs to limit files sent to Jev.
  const content = await readFile(resolve(cwd, path));
  if (content.includes(0) || content.length > maxBytes) {
    throw new Error(`Cannot safely include untracked file: ${path}`);
  }

  return `Untracked file: ${path}\n${content.toString('utf8')}`;
}

async function readUntracked(
  cwd: string,
  paths: string[],
  config?: ResolvedConfig,
  excluded?: Set<string>
): Promise<string[]> {
  const relevant = relevantPaths(paths, cwd, config, excluded);
  const snippets: string[] = [];
  const maxBytes = config?.limits.stateAndQuestionTokens ?? 32_000;
  let length = 0;

  for (let offset = 0; offset < relevant.length; offset += 4) {
    const batch = relevant.slice(offset, offset + 4);
    const loaded = await Promise.all(batch.map((path) => readUntrackedFile(cwd, path, maxBytes)));
    snippets.push(...loaded);
    length += loaded.reduce((size, snippet) => size + Buffer.byteLength(snippet, 'utf8'), 0);
    if (length > 8_000_000) throw new Error('Untracked changes exceed collection budget');
  }

  return snippets;
}

/** Changed paths and a bounded patch for test relevance decisions. */
export interface Changes {
  /** Absolute git root for repo-relative paths in `files`, when collected by getGitChanges. */
  root?: string;
  files: string[];
  /** Changed paths excluded from Jev context by the `linguist-generated` git attribute. */
  generatedFiles?: string[];
  /** Changed-file statuses from git; absent for caller-provided changes. */
  statuses?: ChangedFile[];
  /** Complete per-file patches, when available for lossless chunking. */
  patches?: string[];
  diff?: string;
  title?: string;
  description?: string;
}

/** Use the checked-out commit message when provider PR metadata is unavailable. */
export async function getCommitMessage(
  cwd: string
): Promise<Pick<Changes, 'title' | 'description'>> {
  try {
    const message = await runGit(cwd, ['log', '-1', '--format=%s%n%b']);
    const [title, ...body] = message.split('\n');
    const description = body.join('\n').trim();
    return {
      ...(title?.trim() ? { title: title.trim() } : {}),
      ...(description ? { description } : {})
    };
  } catch {
    return {};
  }
}

/** Read committed changes against merge-base, or local staged, unstaged and untracked changes. */
export async function getGitChanges(
  cwd: string,
  baseRef?: string,
  config?: ResolvedConfig,
  excludedSpecs: string[] = []
): Promise<Changes> {
  // Git reports names relative to its root, even when invoked inside a workspace package.
  const root = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const options = config ?? resolveConfig({ cwd });
  const canonicalCwd = await realpath(cwd);
  const excluded = new Set(
    excludedSpecs.map((file) => resolve(canonicalCwd, relative(cwd, resolve(cwd, file))))
  );

  if (baseRef) {
    const base = (await runGit(root, ['merge-base', baseRef, 'HEAD'])).trim();
    const statuses = parseNameStatus(
      await runGit(root, ['diff', '--find-renames', '--name-status', '-z', base, 'HEAD'])
    );
    const files = statuses.map((entry) => entry.path);
    const generated = await generatedPaths(root, files, options);
    const included = relevantPaths(files, root, options, excluded).filter(
      (file) => !generated.has(file)
    );
    const modelStatuses = statuses.filter((entry) => included.includes(entry.path));
    const diff = included.length
      ? await runGit(root, ['diff', ...diffFlags(options), base, 'HEAD', '--', ...included])
      : '';

    return {
      root,
      files,
      generatedFiles: [...generated],
      statuses: modelStatuses,
      diff,
      patches: splitGitPatches(diff)
    };
  }

  const [staged, unstaged, untracked] = await Promise.all([
    runGit(root, ['diff', '--cached', '--find-renames', '--name-status', '-z']),
    runGit(root, ['diff', '--find-renames', '--name-status', '-z']),
    runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  ]);
  const trackedStatuses = [...parseNameStatus(staged), ...parseNameStatus(unstaged)];
  const untrackedPaths = parsePaths(untracked);
  const files = [...new Set([...trackedStatuses.map((entry) => entry.path), ...untrackedPaths])];
  const generated = await generatedPaths(root, files, options);
  const included = relevantPaths(files, root, options, excluded).filter(
    (file) => !generated.has(file)
  );
  const modelStatuses = [
    ...trackedStatuses.filter((entry) => included.includes(entry.path)),
    ...untrackedPaths
      .filter((path) => included.includes(path))
      .map((path) => ({ status: 'A', path }))
  ];

  const [stagedDiff, unstagedDiff] = included.length
    ? await Promise.all([
        runGit(root, ['diff', '--cached', ...diffFlags(options), '--', ...included]),
        runGit(root, ['diff', ...diffFlags(options), '--', ...included])
      ])
    : ['', ''];
  const patches = [
    ...splitGitPatches(stagedDiff),
    ...splitGitPatches(unstagedDiff),
    ...(await readUntracked(
      root,
      untrackedPaths,
      options,
      new Set([...excluded, ...[...generated].map((path) => resolve(root, path))])
    ))
  ];
  const diff = patches.join('\n');

  return { root, files, generatedFiles: [...generated], statuses: modelStatuses, diff, patches };
}
