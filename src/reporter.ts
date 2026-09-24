import type { Reporter, TestCase } from '@playwright/test/reporter';
import { detectCiDiff } from './ci.js';
import type { JevPlaywrightConfig } from './config.js';
import { filterPaths, resolveConfig } from './config.js';
import { debugLog } from './debug.js';
import { getCommitMessage, getGitChanges } from './git.js';
import { sameFile, selectTests } from './selection.js';
import { withTestSource } from './source.js';

/** Playwright 1.62+ reporter that excludes irrelevant tests before execution. */
export class JevReporter implements Reporter {
  private readonly options: JevPlaywrightConfig;

  /** Options are kept lazy so normal and discovery runs never need an API key. */
  constructor(options: JevPlaywrightConfig = {}) {
    this.options = options;
  }

  /** Exclude only after a complete, non-fallback selection. */
  async preprocess({
    config: playwrightConfig,
    suite,
    testRun
  }: Parameters<NonNullable<Reporter['preprocess']>>[0]): Promise<void> {
    try {
      const config = resolveConfig(this.options);
      if (!config.enabled) return;
      const readOnly = new Set(
        playwrightConfig.projects.flatMap((project) => [
          ...project.dependencies,
          ...(project.teardown ? [project.teardown] : [])
        ])
      );
      const tests = suite
        .allTests()
        .filter((test) => !readOnly.has(test.parent.project()?.name ?? ''));
      if (!tests.length) return;

      const ciDiff = await detectCiDiff(config);
      debugLog(config.debug, 'git baseline', ciDiff);
      if (ciDiff.kind === 'unavailable') {
        process.stderr.write(
          `[jev-playwright] Running all tests: ${ciDiff.provider}: ${ciDiff.reason}\n`
        );
        return;
      }

      const changes = await getGitChanges(
        config.cwd,
        ciDiff.kind === 'ref' ? ciDiff.baseRef : undefined,
        config,
        tests.map((test) => test.location.file)
      );
      if (ciDiff.kind === 'ref') {
        const commit =
          ciDiff.title && ciDiff.description ? undefined : await getCommitMessage(config.cwd);
        const title = ciDiff.title ?? commit?.title;
        const description = ciDiff.description ?? commit?.description;
        if (title) changes.title = title;
        if (description) changes.description = description;
      }
      const root = changes.root ?? config.cwd;
      debugLog(config.debug, 'changed paths', changes.files);
      debugLog(config.debug, 'included paths', filterPaths(changes.files, config));
      debugLog(
        config.debug,
        'forced spec paths',
        tests
          .filter((test) => changes.files.some((file) => sameFile(file, test.location.file, root)))
          .map((test) => test.location.file)
      );
      debugLog(config.debug, 'model name-status', changes.statuses);
      const catalog = tests.map((test) => ({
        id: test.id,
        file: test.location.file,
        line: test.location.line,
        column: test.location.column,
        title: test.titlePath().slice(3).join('›') || test.title,
        project: test.parent.project()?.name ?? ''
      }));
      debugLog(config.debug, 'test source', {
        included: config.includeTestSource,
        ...(config.includeTestSource ? { maxLexicalTokensPerTest: config.maxTestSourceTokens } : {})
      });
      const descriptors = config.includeTestSource
        ? await withTestSource(tests, catalog, config.maxTestSourceTokens)
        : catalog;
      const result = await selectTests({
        tests: descriptors,
        changes,
        config: this.options
      });
      if (result.fallbackReason) {
        process.stderr.write(`[jev-playwright] Running all tests: ${result.fallbackReason}\n`);
        return;
      }
      const selected = new Set(result.selectedIds);
      if (!selected.size) {
        // Playwright treats an entirely excluded suite as an error; skipped tests keep the deliberate no-op successful.
        for (const test of tests) testRun.skip(test, 'Jev found no relevant tests');
        process.stderr.write(
          `[jev-playwright] Selected 0/${tests.length} tests (complete Jev decision: no relevant tests; skipped)\n`
        );
        return;
      }

      for (const test of tests) {
        if (!selected.has(test.id)) testRun.exclude(test as TestCase);
      }
      process.stderr.write(`[jev-playwright] Selected ${selected.size}/${tests.length} tests\n`);
    } catch (error) {
      // Playwright swallows reporter exceptions; preserve coverage and make the failure visible.
      process.stderr.write(`[jev-playwright] Running all tests: ${String(error)}\n`);
    }
  }

  /** Let Playwright add its regular terminal reporter. */
  printsToStdio(): boolean {
    return false;
  }
}

export default JevReporter;
