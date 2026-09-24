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

Playwright discovers tests first, applying its usual project, grep, and `.only` filters. The reporter then:

1. Reads the git change set. Locally, this includes staged, unstaged, and untracked files. In CI, it [detects a baseline](#use-it-in-ci).
2. Always runs directly changed specs. It omits those specs from Jev's candidate tests and git patch context. Other changed files, including shared E2E fixtures, remain in context.
3. Packs as many candidates as fit into each Jev request. One Choice question judges whether **all, none, or some tests in that batch** are relevant; independent yes/no questions score each test in the same request. Tests meeting `threshold` (default `0.5`) run after Playwright applies sharding.

Set `includeTestSource: true` to also send an excerpt from each test declaration through the next discovered test (or the end of the file). This can reveal assertions and page-object-model (POM) calls that a title misses. It does **not** follow imports into POM implementations. The excerpt is capped at 5,000 JavaScript lexical tokens by default. Insignificant indentation and repeated blank lines are compacted while strings, comments, and meaningful line breaks are preserved. Long literals and comments are additionally bounded by a character cap (at most 15,000 characters at the default token limit). Lexical tokens are not Jev model tokens; batches adapt to the actual excerpt sizes.

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

Globs match repository-relative **changed paths**, not test titles. Exclusions take precedence. A directly changed spec still runs even if its path is excluded from model context. Source excerpts and diffs are sent to your configured provider, so use the filters before enabling source context for sensitive tests. There is no universal safe extension-based exclusion: Markdown can be rendered application content. If your repository's docs cannot affect E2E behavior, add `exclude: ['**/*.md', '**/*.mdx']` explicitly. Exclusions reduce model context for mixed changes; if every changed path is excluded, the selector currently runs the full suite.

Git uses `--unified=1` and ignores whitespace-only changes by default. To **preserve whitespace changes** in the patch Jev sees, set `whitespace: 'none'`:

```ts
export default defineConfigWithJev(
  {
    enabled: true,
    diff: {
      whitespace: 'none',
      ignoreBlankLines: false,
      contextLines: 1
    }
  },
  { reporter: 'list' }
);
```

`diff.whitespace` controls **what Git ignores when comparing lines**, not whether whitespace is included in the displayed patch. The default `'all'` uses `--ignore-all-space` (`-w`), so a change consisting only of whitespace can be omitted from the patch. `'change'` uses `-b` (ignores changes in the amount of whitespace), `'eol'` ignores end-of-line whitespace, and `'none'` ignores nothing. The option never changes the changed-file inventory or forced spec selection. Use `'none'` when whitespace can affect behavior, such as CSS, HTML, templates, or literal-sensitive files. Newly added, untracked files are included as text and are not processed by Git's whitespace flags.

Jev currently documents **32k tokens for state plus the longest question**, and **64k for the full request**. The selector batches by these budgets, not a fixed number of tests. Configure different provider limits with `limits: { stateAndQuestionTokens: 32000, requestTokens: 64000, maxRequests: 100 }`. Because the SDK does not expose Jev's tokenizer, sizing uses serialized UTF-8 bytes as a conservative proxy and may split earlier than the model requires. For OpenRouter's documented 32k total context, set `limits.requestTokens` to `32000`.

**All, none, or some:** When Jev consistently chooses `none` for every batch, the reporter marks the discovered tests as skipped and Playwright exits successfully if nothing else fails. `all` keeps every candidate; `some` uses the per-test probabilities. Directly changed specs still run. An unavailable git ref, missing credentials, oversized change, invalid answer, or contradictory batch decision instead runs the **full discovered suite**. The reporter prints either `Selected N/M tests` or `Running all tests: <reason>` to stderr. Jev returns probabilities, not written explanations, and cannot invent tests that aren't in your suite. Evaluate selections against full-suite results before relying on reduced CI runs.

### Smart diff selection

The model receives a compact **string state** with bounded PR/commit title and description hints, git name-status entries (`A`, `M`, `D`, renames), patch text, and keyed test descriptions. GitHub/Gitea event payloads and GitLab CI variables provide PR hints when available. When a CI title or description is unavailable, the checked-out commit subject or body fills the missing field. Explicit `prTitle` and `prDescription` override these hints. Empty fields are omitted. Titles and descriptions are context, not a substitute for code changes.

PR/commit descriptions are converted from GitHub-flavored Markdown to plain text with `remark`, `remark-gfm`, and `strip-markdown`, then whitespace is collapsed and the result is capped at 2,000 characters (titles at 200). This removes HTML comments, formatting, fenced code, and tables from **the hint only**; it does not change the git patch. If the description contains important code or tabular context, put that information in the changed files or provide a custom `beforeRequest` hook.

| Change | Context sent to Jev |
| --- | --- |
| Patch fits | Complete name-status inventory and patch; tests are split into requests only when necessary. |
| Patch exceeds the request budget | Complete name-status inventory and **every per-file patch**, grouped into chunks. Test probabilities are combined by taking the highest relevance per test across chunks. |
| Only discovered specs changed | No Jev call; those specs run directly. |
| A patch cannot fit even alone, a chunk fails, or `limits.maxRequests` is reached | Full discovered suite runs. Nothing is silently truncated after the configured git filters. |

“No tests” is accepted only after **every** required patch chunk has been evaluated consistently. The file inventory is repeated across chunks; a very large inventory can itself force a full run. Caller-provided changes without complete per-file `patches` can be evaluated when their full diff fits, but cannot be split safely when it does not.

For an exact view of the selection, set `debug: true` or run with `JEV_PLAYWRIGHT_DEBUG=true`. The stderr output lists the git baseline, changed and included paths, forced specs, name-status entries, chunk sizes, and the **full state, questions, and Jev response** for each request. Debug output can contain source code and PR text, so enable it only where those logs are appropriate.

If the log says `Jev scope conflicts with per-test answers`, the batch-level all/none/some choice disagreed with the thresholded per-test probabilities. The reporter runs all tests in this case. Inspect the response in debug output before changing the threshold or question wording.

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

`beforeRequest` may be async. Keep the `scope` Choice and every `test_N` Noul question; otherwise selection falls back to all tests. Keep `createQuestion` deterministic because request packing may call it while sizing candidates. `prDescription` can be supplied alongside `prTitle`.

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
| `debug`                                     | `JEV_PLAYWRIGHT_DEBUG`                                      | `false`                                 |
| `baseRef`                                   | `JEV_PLAYWRIGHT_BASE_REF`, then `BASE_REF`                   | CI baseline or local changes            |
| `defaultBranch`                             | `JEV_PLAYWRIGHT_DEFAULT_BRANCH`                              | provider value, then `main`             |
| `cwd`                                       | `JEV_PLAYWRIGHT_CWD`                                         | `process.cwd()`                         |
| `include`                                   | `JEV_PLAYWRIGHT_INCLUDE` (JSON string array)                 | `["**/*"]`                              |
| `exclude`                                   | `JEV_PLAYWRIGHT_EXCLUDE` (JSON string array)                 | `[]`                                    |
| `threshold`                                 | `JEV_PLAYWRIGHT_THRESHOLD`                                   | `0.5`                                   |
| `diff.whitespace`                           | `JEV_PLAYWRIGHT_DIFF_WHITESPACE`                             | `all` (ignore whitespace-only changes); `none` preserves them |
| `diff.ignoreBlankLines`                     | `JEV_PLAYWRIGHT_DIFF_IGNORE_BLANK_LINES`                    | `false`                                 |
| `diff.contextLines`                         | `JEV_PLAYWRIGHT_DIFF_CONTEXT_LINES`                          | `1`                                     |
| `limits.stateAndQuestionTokens`             | `JEV_PLAYWRIGHT_LIMITS_STATE_AND_QUESTION_TOKENS`           | `32000`                                 |
| `limits.requestTokens`                      | `JEV_PLAYWRIGHT_LIMITS_REQUEST_TOKENS`                      | `64000`                                 |
| `limits.maxRequests`                        | `JEV_PLAYWRIGHT_LIMITS_MAX_REQUESTS`                        | `100`                                   |
| `includeTestSource`                         | `JEV_PLAYWRIGHT_INCLUDE_TEST_SOURCE`                         | `false`                                 |
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
