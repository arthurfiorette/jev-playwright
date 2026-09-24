import { fileURLToPath } from 'node:url';
import type { PlaywrightTestConfig, ReporterDescription } from '@playwright/test';
import { defineConfig } from '@playwright/test';
import type { JevPlaywrightConfig } from './config.js';

function existingReporters(reporter: PlaywrightTestConfig['reporter']): ReporterDescription[] {
  if (!reporter) return [];
  if (typeof reporter === 'string') return [[reporter]];
  return reporter;
}

function jevReporterPath(): string {
  // Playwright resolves reporter IDs from testDir, which may be below the package root.
  return fileURLToPath(new URL('./reporter.js', import.meta.url));
}

/** Add the typed Jev reporter to an otherwise standard Playwright configuration. */
export function defineConfigWithJev<
  TestArgs = Record<string, unknown>,
  WorkerArgs = Record<string, unknown>
>(
  jevConfig: JevPlaywrightConfig,
  playwrightConfig: PlaywrightTestConfig<TestArgs, WorkerArgs>
): PlaywrightTestConfig<TestArgs, WorkerArgs> {
  return defineConfig<TestArgs, WorkerArgs>({
    ...playwrightConfig,
    reporter: [...existingReporters(playwrightConfig.reporter), [jevReporterPath(), jevConfig]]
  });
}
