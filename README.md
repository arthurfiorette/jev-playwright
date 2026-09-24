<p align="center">
   <b>Using this package?</b> Please consider <a href="https://github.com/sponsors/arthurfiorette" target="_blank">donating</a> to support my open source work ❤️
  <br />
  <sup>
   Help jev-playwright grow! Star and share this amazing repository with your friends and co-workers!
  </sup>
</p>

<br />

<p align="center" title="jev-playwright logo">
  <a href="https://github.com/arthurfiorette/jev-playwright">
    <img src="https://raw.githubusercontent.com/arthurfiorette/jev-playwright/main/assets/logo.png" width="500" alt="Jev Playwright logo: code changes flowing to selected browser tests" />
  </a>
</p>

# Jev Playwright

**Run the Playwright tests relevant to a code change.** Add one reporter; it uses [Jev](https://docs.typesafe.ai/) to select existing tests before they run. If selection cannot be completed, Playwright runs the full suite.

Package-aware tools such as Turborepo and Nx can scope unit tests using the changed-package graph. E2E tests are harder: a single browser journey can cross many packages, pages, and services. `jev-playwright` compares the change with Playwright's discovered tests to select relevant journeys **before browser execution**, reducing test runtime in large CI suites. It does not eliminate the time spent provisioning the E2E stack.

Requires **Node.js 24.16+** and **Playwright 1.62+**. [Get started](#get-started) · [Smart diff selection](#smart-diff-selection) · [Choose a provider](#choose-a-jev-provider) · [Use it in CI](#use-it-in-ci) · [Configuration reference](#configuration-reference)

<br />

## Get started

1. Install the package in a project that uses Playwright:

   ```sh
   pnpm add -D jev-playwright @playwright/test
   ```

2. Set a TypeSafe API key:

   ```sh
   export JEV_PLAYWRIGHT_PROVIDER_KEY="your-typesafe-key"
   ```

   Using OpenRouter instead? See [OpenRouter setup](#openrouter).

3. Add the reporter to `playwright.config.ts`:

   ```ts
   import { defineConfigWithJev } from 'jev-playwright';

   export default defineConfigWithJev(
     { enabled: true },
     {
       testDir: './e2e',
       reporter: [['list']]
     }
   );
   ```

4. Change a file and run your usual command:

   ```sh
   pnpm exec playwright test
   ```

`defineConfigWithJev(jevOptions, playwrightConfig)` preserves your Playwright settings and existing reporters, then adds the Jev reporter. It accepts `reporter: 'list'` as well as a reporter array. **With no included changes, it runs all tests.** For CI-only selection, use `{ enabled: Boolean(process.env.CI) }` instead.

<br />

## How selection works

Playwright discovers tests first, respecting your project and test filters. Then the reporter:

1. Reads staged, unstaged, and untracked changes locally, or [chooses a CI baseline](#use-it-in-ci).
2. Always includes directly changed specs. Jev scores the remaining tests against the change using their titles and file paths.
3. Runs tests at or above `threshold` (default `0.5`). If selection cannot be completed, it runs the full suite.

### Include test source (optional)

Test bodies are **not sent by default**. Set `includeTestSource: true` to send each test's body and immediately preceding comments, which can help when a title alone doesn't describe its assertions or POM calls. The excerpt is limited to 5,000 JavaScript lexical tokens (and 15,000 characters) per test. If the source is unavailable, Jev can still judge that test by its title and path. It does not read POM implementations.

By default, the same test in multiple Playwright projects shares one decision. Set `perProject: true` when Chromium, Firefox, or WebKit could need different selections.

```ts
export default defineConfigWithJev(
  {
    enabled: true,
    include: ['src/**', 'e2e/**'],
    exclude: ['src/generated/**'],
    includeTestSource: true,
    threshold: 0.6
  },
  { reporter: [['list']] }
);
```

Globs match repository-relative changed paths, not test titles. Exclusions take precedence, but a directly changed spec still runs. Source excerpts and diffs go to your configured provider. For example, if documentation cannot affect your app, add `exclude: ['**/*.md', '**/*.mdx']`. If every changed path is excluded, the full suite runs.

Git uses `--unified=3` and ignores whitespace-only changes by default. To **preserve whitespace changes** in the patch Jev sees, set `whitespace: 'none'`:

```ts
export default defineConfigWithJev(
  {
    enabled: true,
    diff: {
      whitespace: 'none',
      ignoreBlankLines: false,
      contextLines: 3
    }
  },
  { reporter: 'list' }
);
```

`diff.whitespace` controls what Git **ignores**. The default `'all'` ignores whitespace-only changes; `'change'` ignores differences in the amount of whitespace; `'eol'` ignores end-of-line whitespace; `'none'` preserves all whitespace changes. Use `'none'` for CSS, HTML, or templates where spacing can matter. Changed-file detection and directly changed specs are unaffected.

TypeSafe documents **32k tokens for state plus the longest question** and **64k per request**. The selector fits tests within those limits and makes up to **five requests concurrently** by default. Set `limits.maxConcurrentRequests` for your provider; OpenRouter users should set `limits.requestTokens: 32000` for its documented 32k context. `beforeRequest` hooks may run concurrently.

If no test meets the threshold, Playwright marks the tests as skipped and exits successfully if nothing else fails. Directly changed specs still run. A missing git ref, provider error, or incomplete answer runs the **full suite** instead. The reporter prints either `Selected N/M tests` or `Running all tests: <reason>`. Compare selections with full-suite results before relying on reduced CI runs.

### Smart diff selection

Jev sees changed files, their add/modify/delete/rename status, and the git patch. Each test question includes its title, relative path, and optional source body. Available PR title and description provide additional context; otherwise CI can use the commit message. Set `prTitle` or `prDescription` to override those hints.

Descriptions are converted to plain text and limited to 2,000 characters; titles are limited to 200. This cleanup affects only the hint, not the patch.

| Change | Context sent to Jev |
| --- | --- |
| Patch fits | All changed paths and the full patch are sent together. |
| Patch exceeds the request budget | Every file's patch is evaluated in chunks. A test is selected if any chunk finds it relevant. |
| Only discovered specs changed | No Jev call; those specs run directly. |
| One file's patch cannot fit, a request fails, or `limits.maxRequests` is reached | Full discovered suite runs. |

The reporter skips all tests only after **every** required chunk is evaluated. Programmatic callers supplying an oversized diff must also supply per-file `patches`; otherwise the full suite runs.

To inspect selection, run with `DEBUG=jev-playwright:*`. Logs show changed paths, forced specs, request contents, and Jev's responses. They can contain source code and PR text.

<br />

## Choose a Jev provider

### TypeSafe (default)

Only the key is required. The package uses `@typesafe-ai/sdk` directly, with its default API URL and the `jev-latest` model:

```sh
export JEV_PLAYWRIGHT_PROVIDER_KEY="your-typesafe-key"
```

The SDK's native `TYPESAFE_API_KEY` and `TYPESAFE_BASE_URL` variables also work when the corresponding `JEV_PLAYWRIGHT_*` values are unset.

### OpenRouter

Point the same TypeSafe SDK at OpenRouter's System One endpoint:

```sh
export JEV_PLAYWRIGHT_PROVIDER_URL="https://openrouter.ai/api"
export JEV_PLAYWRIGHT_PROVIDER_KEY="your-openrouter-key"
export JEV_PLAYWRIGHT_MODEL="jev-1.13"
export JEV_PLAYWRIGHT_LIMITS_REQUEST_TOKENS=32000
```

The SDK appends `/v1/systemone` to the URL. `jev-1.13` is a documented OpenRouter-supported model ID. The SDK default `jev-latest` also works on OpenRouter but can move between releases, so pin the model if you tune `threshold`. OpenRouter documents a 32k total context, which is why the example lowers `limits.requestTokens`; adjust it if your provider has a different budget. See [OpenRouter's TypeSafe SDK guide](https://openrouter.ai/docs/guides/community/typesafe-sdk).

### Custom authentication or transport

Pass a configured SDK client if your provider needs custom headers, a fetch implementation, or other SDK settings:

```ts
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { defineConfigWithJev } from 'jev-playwright';

export default defineConfigWithJev(
  {
    enabled: true,
    client: new TypeSafeClient({
      apiKey: process.env.MY_JEV_KEY,
      baseURL: process.env.MY_JEV_URL
    })
  },
  { reporter: 'list' }
);
```

`client` takes precedence over `providerKey` and `providerUrl`. The client must implement the TypeSafe SDK's `systemOne()` method.

<br />

## Use it in CI

With no explicit `baseRef`, the reporter inspects the CI runner's environment and local event payload. It makes **no provider API calls and never fetches git history**. A PR or feature branch compares `HEAD` with the merge-base of its target/default branch. On a default-branch push, a previous-push SHA, when available, covers _every commit in that push_, including squash and merge commits.

The checkout must contain `refs/remotes/origin/<target>` and sufficient history for branch comparisons. For example, configure a GitHub Actions checkout with `fetch-depth: 0`. If the baseline is missing, the full suite runs.

An explicit `baseRef`, `JEV_PLAYWRIGHT_BASE_REF`, or `BASE_REF` overrides detection. For example, `BASE_REF=origin/main pnpm exec playwright test` compares their merge-base with `HEAD`. Outside CI, no provider detection runs.

<details>
<summary><strong>GitHub Actions</strong></summary>

`GITHUB_ACTIONS` identifies the runner. PRs use `GITHUB_BASE_REF`; feature branches use the repository's `default_branch` from `GITHUB_EVENT_PATH`. A default-branch `push` uses the event payload's `before` SHA. Without a valid previous SHA, it runs all tests.

</details>

<details>
<summary><strong>Gitea Actions</strong></summary>

`GITEA_ACTIONS` takes precedence over GitHub's compatibility variables. PRs use `GITHUB_BASE_REF`; feature branches use the payload's `repository.default_branch`; default-branch pushes use `before` from `GITHUB_EVENT_PATH`.

</details>

<details>
<summary><strong>GitLab CI</strong></summary>

Merge requests use `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`; feature branches use `CI_DEFAULT_BRANCH`. Default-branch push pipelines use `CI_COMMIT_BEFORE_SHA`. An all-zero SHA, such as on a first or manual pipeline, triggers a full run.

</details>

<details>
<summary><strong>Bitbucket Pipelines</strong></summary>

PRs use `BITBUCKET_PR_DESTINATION_BRANCH`; feature branches compare against the configured default branch. Bitbucket does not provide a reliable previous-push SHA as a built-in variable, so default-branch builds run all tests unless you set `BASE_REF`.

</details>

<details>
<summary><strong>Azure Pipelines</strong></summary>

PRs use `SYSTEM_PULLREQUEST_TARGETBRANCH`; feature branches compare against the configured default branch. Azure does not provide a reliable previous-push SHA as a built-in variable, so default-branch builds run all tests unless you set `BASE_REF`.

</details>

If a provider cannot supply the default branch, `main` is assumed. Set `defaultBranch` or `JEV_PLAYWRIGHT_DEFAULT_BRANCH` for a different branch name. Unknown CI providers, tag builds, and incomplete CI context run all tests. You can inspect the chosen baseline with `await detectCiDiff(resolveConfig(options))`.

<br />

## Customize the decision

Use `createQuestion` to change the relevance instructions. Use `beforeRequest` to add project context to each typed SDK request:

```ts
export default defineConfigWithJev(
  {
    enabled: true,
    prTitle: process.env.PR_TITLE,
    createQuestion(test, key) {
      return `Could this change affect the behavior tested by ${key} (${test.title})?`;
    },
    beforeRequest(request) {
      // Include the product area when test titles alone are ambiguous.
      return {
        ...request,
        state: { selection: request.state, product: 'billing' }
      };
    }
  },
  { reporter: [['list']] }
);
```

`beforeRequest` may be async. Keep every `test_N` question or the full suite runs. Test details are appended to `createQuestion` output. Keep `createQuestion` deterministic because request sizing can call it more than once.

<br />

## Use the library programmatically

When you already know the changed files and test catalog, call `selectTests()` without starting Playwright:

```ts
import { selectTests } from 'jev-playwright';

const selection = await selectTests({
  changes: {
    files: ['src/checkout.ts'],
    diff: '+ updated checkout behavior',
    title: 'Fix checkout'
  },
  tests: [
    {
      id: 'checkout',
      file: 'e2e/checkout.spec.ts',
      title: 'customer checks out'
    },
    {
      id: 'login',
      file: 'e2e/login.spec.ts',
      title: 'customer signs in'
    }
  ],
  config: { enabled: true }
});

console.log(
  selection.selectedIds,
  selection.assessments,
  selection.fallbackReason
);
```

`id` must be unique in the supplied catalog. `assessments` contains each judged test's probability and resolved model. `selectedIds: []` with no `fallbackReason` means a complete Jev decision selected no tests; a `fallbackReason` means all tests were retained. You can pass `client` to `selectTests()` to reuse a configured SDK client. `getGitChanges(cwd, baseRef?)` reads git changes for you; `detectCiDiff()` and `resolveConfig()` are available if your application owns the CI integration.

<br />

## Configuration reference

Environment variables override the corresponding reporter options. Set JSON arrays for glob variables, for example `JEV_PLAYWRIGHT_INCLUDE='["src/**","e2e/**"]'`.

| Option                                      | Environment variable                                         | Default                                 |
| ------------------------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| `enabled`                                   | `JEV_PLAYWRIGHT_ENABLED` (`true`/`false` or `1`/`0`)         | `false`                                 |
| `baseRef`                                   | `JEV_PLAYWRIGHT_BASE_REF`, then `BASE_REF`                   | CI baseline or local changes            |
| `defaultBranch`                             | `JEV_PLAYWRIGHT_DEFAULT_BRANCH`                              | provider value, then `main`             |
| `cwd`                                       | `JEV_PLAYWRIGHT_CWD`                                         | `process.cwd()`                         |
| `include`                                   | `JEV_PLAYWRIGHT_INCLUDE` (JSON string array)                 | `["**/*"]`                              |
| `exclude`                                   | `JEV_PLAYWRIGHT_EXCLUDE` (JSON string array)                 | `[]`                                    |
| `threshold`                                 | `JEV_PLAYWRIGHT_THRESHOLD`                                   | `0.5`                                   |
| `diff.whitespace`                           | `JEV_PLAYWRIGHT_DIFF_WHITESPACE`                             | `all` (ignore whitespace-only changes); `none` preserves them |
| `diff.ignoreBlankLines`                     | `JEV_PLAYWRIGHT_DIFF_IGNORE_BLANK_LINES`                    | `false`                                 |
| `diff.contextLines`                         | `JEV_PLAYWRIGHT_DIFF_CONTEXT_LINES`                          | `3`                                     |
| `limits.stateAndQuestionTokens`             | `JEV_PLAYWRIGHT_LIMITS_STATE_AND_QUESTION_TOKENS`           | `32000`                                 |
| `limits.requestTokens`                      | `JEV_PLAYWRIGHT_LIMITS_REQUEST_TOKENS`                      | `64000`                                 |
| `limits.maxRequests`                        | `JEV_PLAYWRIGHT_LIMITS_MAX_REQUESTS`                        | `100`                                   |
| `limits.maxConcurrentRequests`              | `JEV_PLAYWRIGHT_LIMITS_MAX_CONCURRENT_REQUESTS`             | `5`                                     |
| `includeTestSource`                         | `JEV_PLAYWRIGHT_INCLUDE_TEST_SOURCE`                         | `false`                                 |
| `perProject`                                | `JEV_PLAYWRIGHT_PER_PROJECT`                                 | `false` (share decisions across projects) |
| `maxTestSourceTokens`                       | `JEV_PLAYWRIGHT_MAX_TEST_SOURCE_TOKENS`                      | `5000` (maximum `5000`)                 |
| `model`                                     | `JEV_PLAYWRIGHT_MODEL`                                       | `jev-latest`                            |
| `prTitle`, `prDescription`                  | `JEV_PLAYWRIGHT_PR_TITLE`, `JEV_PLAYWRIGHT_PR_DESCRIPTION`   | unset                                   |
| `providerUrl`, `providerKey`                | `JEV_PLAYWRIGHT_PROVIDER_URL`, `JEV_PLAYWRIGHT_PROVIDER_KEY` | SDK defaults                            |
| `client`, `createQuestion`, `beforeRequest` | Playwright config only                                       | SDK client, built-in question, no hook  |

<br />

## Contributing

To work on **this package** rather than install it in a Playwright project:

1. Use Node.js 24.16+ and pnpm 12.6.0, then install dependencies with `pnpm install`.
2. Copy the [`.env.example` template](https://github.com/arthurfiorette/jev-playwright/blob/main/.env.example) to `.env` and set a TypeSafe or OpenRouter key if you want to try a real Jev request. `.env` is gitignored. Load it explicitly with `node --env-file=.env ...` or your shell; the library does not automatically load dotenv files. Unit and Playwright fixture tests do not need a key.
3. Run `pnpm build` first. The Playwright integration fixture imports the built reporter from `dist/`.
4. Run `pnpm test-types`, `pnpm test`, and `pnpm lint-ci`.

<br />

## License

[MIT](LICENSE).
