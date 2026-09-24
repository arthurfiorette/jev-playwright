import type { Reporter, TestCase } from '@playwright/test/reporter';
import type { JevPlaywrightConfig } from './config.js';
import { resolveConfig } from './config.js';
import { getGitChanges } from './git.js';
import { selectTests } from './selection.js';
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
      const changes = await getGitChanges(config.cwd, config.baseRef, config);
      const catalog = tests.map((test) => ({
        id: test.id,
        file: test.location.file,
        title: test.titlePath().join(' › '),
        project: test.parent.project()?.name ?? ''
      }));
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
