# jev-playwright

Select existing Playwright tests relevant to a code change with [Jev](https://docs.typesafe.ai/). Requires Node.js 24.16+ and Playwright 1.62+. The reporter selects tests in Playwright's `preprocess()` phase, before execution and sharding. Selection is opt-in. On missing changes, incomplete answers, errors, or an empty selection, it runs the entire discovered suite.

## Install and run

```sh
pnpm add -D jev-playwright @playwright/test
```

Set `JEV_PLAYWRIGHT_PROVIDER_KEY` to your TypeSafe API key. To use OpenRouter, set `JEV_PLAYWRIGHT_PROVIDER_URL=https://openrouter.ai/api` and use an OpenRouter key. The package calls `@typesafe-ai/sdk` directly. The SDK appends `/v1/systemone` to the provider URL. `jev-latest` is the default model; set `JEV_PLAYWRIGHT_MODEL=jev-1.13` to pin an OpenRouter version. See [OpenRouter's TypeSafe SDK guide](https://openrouter.ai/docs/guides/community/typesafe-sdk).

```ts
// playwright.config.ts
import { defineConfigWithJev } from 'jev-playwright';

export default defineConfigWithJev(
  {
    enabled: !!process.env.CI,
    include: ['src/**', 'e2e/**'],
    exclude: ['src/generated/**'],
    includeTestSource: true,
  },
  {
    reporter: [['list']],
    testDir: './e2e',
  },
);
```

```sh
BASE_REF=origin/main JEV_PLAYWRIGHT_PROVIDER_KEY=... pnpm playwright test
```

`BASE_REF` compares the merge-base with `HEAD`. Without a base ref, git supplies staged, unstaged and untracked changes. Directly changed test files always run. Changes without an included path and changes too large for the model fall back to the full suite. Ordinary runs with `enabled: false` do not make an API call.

`includeTestSource` optionally sends an excerpt starting at each test declaration (up to 40 lines, capped at 5,000 JavaScript lexical tokens by default). This exposes assertions and POM call sites without repeatedly sending entire spec files. `js-tokens` counts code tokens, not Jev's model tokens, so excerpts also have a 25,000-character hard cap and large excerpts reduce batch size. It does not follow imports into POM implementations. The source is sent to the configured provider, so only enable it for tests you intend to share.

## Customize provider and questions

Reporter options live in `playwright.config.ts`. They can include a configured SDK client and request hooks:

```ts
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { defineConfigWithJev } from 'jev-playwright';

export default defineConfigWithJev(
  {
    enabled: true,
    client: new TypeSafeClient({
      apiKey: process.env.MY_JEV_KEY,
      baseURL: process.env.MY_JEV_URL,
    }),
    createQuestion(test, key) {
      return `Could the code change alter ${key} (${test.title}) or its setup?`;
    },
    beforeRequest(request, { changes, tests }) {
      // Add project context when similar tests otherwise look indistinguishable.
      return { ...request, state: { ...request.state as object, product: 'my-app' } };
    },
  },
  { reporter: [['list']] },
);
```

`createQuestion` supplies the instructions for each typed Noul question. `beforeRequest` may change the SDK request before each batch; it must retain all `test_N` Noul questions so every candidate gets a result. `changes` and `tests` are available for context. Jev does not generate missing tests or a written explanation.

`defineConfigWithJev(jevConfig, playwrightConfig)` adds the Jev reporter to the configured reporters and returns a Playwright config. It also accepts a single reporter name such as `reporter: 'list'` and preserves the rest of Playwright's configuration.

Copy `.env.example` to `.env` for local variables and load it with Node (`node --env-file=.env ...`) or your shell. The package does not automatically load dotenv files.

## Programmatic API

```ts
import { selectTests, getGitChanges } from 'jev-playwright';

const changes = await getGitChanges(process.cwd(), 'origin/main');
const selection = await selectTests({
  changes,
  tests: [{ id: 'checkout', file: 'e2e/checkout.spec.ts', title: 'checkout' }],
  config: { enabled: true, threshold: 0.6 },
});
console.log(selection.selectedIds, selection.assessments, selection.fallbackReason);
```

`selectTests` takes explicit changes and test descriptors, plus an optional SDK-compatible `client` to customize authentication or test without network access. `getGitChanges` is a convenience adapter; callers can supply their own `{ files, diff, title, description }` instead. `JevReporter` is also exported from the package root.

## Configuration reference

| Option | Environment variable | Default |
| --- | --- | --- |
| `enabled` | `JEV_PLAYWRIGHT_ENABLED` (`true`/`false` or `1`/`0`) | `false` |
| `baseRef` | `JEV_PLAYWRIGHT_BASE_REF`, then `BASE_REF` | local changes |
| `cwd` | `JEV_PLAYWRIGHT_CWD` | `process.cwd()` |
| `include` | `JEV_PLAYWRIGHT_INCLUDE` (JSON string array) | `["**/*"]` |
| `exclude` | `JEV_PLAYWRIGHT_EXCLUDE` (JSON string array) | `[]` |
| `threshold` | `JEV_PLAYWRIGHT_THRESHOLD` | `0.5` |
| `batchSize` | `JEV_PLAYWRIGHT_BATCH_SIZE` | `50` |
| `includeTestSource` | `JEV_PLAYWRIGHT_INCLUDE_TEST_SOURCE` | `false` |
| `maxTestSourceTokens` | `JEV_PLAYWRIGHT_MAX_TEST_SOURCE_TOKENS` | `5000` (maximum `5000`) |
| `model` | `JEV_PLAYWRIGHT_MODEL` | `jev-latest` |
| `prTitle`, `prDescription` | `JEV_PLAYWRIGHT_PR_TITLE`, `JEV_PLAYWRIGHT_PR_DESCRIPTION` | unset |
| `providerUrl`, `providerKey` | `JEV_PLAYWRIGHT_PROVIDER_URL`, `JEV_PLAYWRIGHT_PROVIDER_KEY` | SDK defaults |
| `client`, `createQuestion`, `beforeRequest` | reporter options only | SDK client, built-in question, no hook |

Environment variables override reporter options. Glob patterns match repository-relative changed paths using Node's `path.matchesGlob()`. The SDK also accepts its native `TYPESAFE_API_KEY` and `TYPESAFE_BASE_URL` when no provider options are set. Pin the model and evaluate selections against full-suite results before relying on skipped tests in CI.
