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

**Run the Playwright tests relevant to a code change.** Add one reporter; it uses [Jev](https://docs.typesafe.ai/), TypeSafe's model for typed yes/no decisions, to select existing tests before they run.

Package-aware tools such as Turborepo and Nx can scope unit tests using the changed-package graph. E2E tests are harder: a single browser journey can cross many packages, pages, and services. `jev-playwright` compares the change with Playwright's discovered tests to select relevant journeys **before browser execution**, reducing test runtime in large CI suites.

> [!WARNING]
> This is a relevance filter, not a guarantee that every affected test will run. Its goal is to skip many clearly unrelated tests while keeping plausibly affected ones; it can still miss tests. Keep full-suite coverage where completeness matters.

**Requirements:** Node.js 24.16+ (declared by this package) and Playwright 1.62+ (required for reporter `preprocess()`). [Get started](#get-started) · [Choose an AI provider](#choose-an-ai-provider) · [Use it in CI](#use-it-in-ci) · [Configuration reference](#configuration-reference)

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

   **What leaves your machine:** Jev receives changed paths, git patches, test titles, and test callback bodies/comments by default. PR or commit descriptions may also be sent. **Secrets in diffs or test source are not redacted.** Filter sensitive changed paths with `include`/`exclude`; set `includeTestSource: false` if test bodies should stay local.

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

`defineConfigWithJev(jevOptions, playwrightConfig)` keeps your Playwright settings and other reporters. For CI-only selection, use `{ enabled: process.env.CI === 'true' || process.env.CI === '1' }` instead of `enabled: true`.

> **A green run can execute zero E2E tests.** If Jev selects none, Playwright reports them as skipped and can exit successfully. Check the `Selected 0/N tests` message. Compare selections with full-suite results before relying on them for required CI checks. If selection fails or no included changes are found, the reporter runs all tests.

<br />

## How selection works

Playwright discovers tests first, respecting your project and test filters. Then the reporter:

1. Reads staged, unstaged, and untracked changes locally, or [chooses a CI baseline](#use-it-in-ci).
2. Always includes directly changed specs. Jev scores the remaining tests against the change using their titles and file paths.
3. Runs tests at or above `threshold` (default `0.5`). If selection cannot be completed, it runs the full suite.

Each score is Jev's estimated **probability that the change could affect that test's behavior or setup**. TypeSafe describes these probabilities as [calibrated in aggregate](https://docs.typesafe.ai/confidence), but a score is not the probability that a test will fail or a guarantee that other tests cannot be affected. Start with the default threshold, compare selections against full-suite results for your own changes, then tune it. A higher threshold runs fewer tests but increases the chance of missing one.

<br />

## Control what Jev sees

### Include test source (optional)

Test bodies and immediately preceding comments **are sent by default** to help Jev judge assertions and POM calls. Set `includeTestSource: false` to send only test titles and paths. Each excerpt is limited to 5,000 JavaScript lexical tokens (and 15,000 characters). If source is unavailable, the test remains a candidate using its title and path. POM implementations are not included.

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

### Filter changed files

`include` and `exclude` match repository-relative **changed paths**, not test titles. Exclusions win, but a directly changed spec still runs. For example, with `exclude: ['docs/**']`, a change to `docs/README.md` and `e2e/login.spec.ts` still runs the changed login spec. If every changed path is excluded, the full suite runs. Only exclude Markdown when it cannot affect your app; documentation sites may render it.

### Exclude generated files

`excludeGeneratedFiles` defaults to `true`. Mark files whose generated content should not influence test selection in your repository's `.gitattributes`:

```gitattributes
pnpm-lock.yaml    linguist-generated=true
src/generated/**  linguist-generated=true
```

Git reads the attribute, including rules in nested `.gitattributes` files. Marked files remain in the **changed-file inventory**, which the reporter uses to identify directly changed specs and decide whether it has usable changes. Their paths and patches are excluded from the input sent to Jev. A changed spec still runs; if **only** generated files changed, the full suite runs. Set `excludeGeneratedFiles: false` (or `JEV_PLAYWRIGHT_EXCLUDE_GENERATED_FILES=false`) to include their diffs.

The attribute lookup happens when `getGitChanges()` reads the repository. If you supply your own `Changes` object to `selectTests()`, filter its `diff` and `patches` yourself.

The same [`linguist-generated` attribute](https://github.com/github-linguist/linguist/blob/main/docs/overrides.md#generated-code) tells GitHub to hide generated files in diff views. Other Git hosts may present those files differently; selection uses Git's attributes, not a provider API.

### Preserve whitespace changes

Git ignores whitespace-only changes by default. To **preserve whitespace changes** in the patch Jev sees, set `whitespace: 'none'`:

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

<br />

## Smart diff selection

Jev sees changed files, their add/modify/delete/rename status, and the git patch. Each test question includes its title, relative path, and optional source body. Available PR title and description provide additional context; otherwise CI can use the commit message. Set `prTitle` or `prDescription` to override those hints.

Descriptions are converted to plain text and limited to 2,000 characters; titles are limited to 200. This cleanup affects only the hint, not the patch.

| Change                                                                           | Context sent to Jev                                                                           |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Patch fits                                                                       | All changed paths and the full patch are sent together.                                       |
| Patch exceeds the request budget                                                 | Every file's patch is evaluated in chunks. A test runs if any chunk finds it relevant.        |
| Only discovered specs changed                                                    | No Jev call; those specs run directly.                                                        |
| One file's patch cannot fit, a request fails, or `limits.maxRequests` is reached | Full discovered suite runs.                                                                   |

For a large change, the selector takes each test's **highest score across chunks** and compares it with `threshold`. For example, if the checkout chunk finds a test relevant but the billing chunk does not, that test still runs. No tests run only if every required chunk was evaluated successfully and none found a relevant test. Programmatic callers supplying an oversized diff must also supply per-file `patches`; otherwise the full suite runs.

<br />

## Request limits

TypeSafe documents two input budgets: **32k tokens** for the shared change state plus the longest test question, and **64k tokens** for the state plus all questions in one request. The selector sizes requests conservatively using UTF-8 bytes, which can split them earlier than Jev requires.

`limits.requestTokens` controls when tests or file patches are split. `limits.maxRequests` defaults to `100` across the entire selection; exceeding it runs the full suite. At most **five requests** run concurrently by default (`limits.maxConcurrentRequests`). OpenRouter documents a 32k total context, so set `limits.requestTokens: 32000` there. `beforeRequest` hooks may run concurrently.

<br />

## Outcomes and fallbacks

| Outcome | What Playwright does |
| --- | --- |
| Some tests selected | Runs them, plus any directly changed specs. |
| Complete selection finds no relevant tests | Marks tests as skipped; the command can exit **0 without running an E2E test**. |
| No usable changes, missing git baseline, oversized single patch, provider failure, or incomplete answer | Runs the full discovered suite. |

Look for `Selected N/M tests` or `Running all tests: <reason>` in the reporter output. To assess missed coverage, compare selections with full-suite runs before making a reduced run a required CI check.

<br />

## Choose an AI provider

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

With no explicit `baseRef`, the reporter uses CI environment variables and local event data to choose what to compare with `HEAD`. It makes **no CI-provider API calls and never fetches git history**.

| Run | Baseline | If unavailable |
| --- | --- | --- |
| Local | Staged, unstaged, and untracked changes | Full suite when no included changes exist |
| Pull/merge request | Merge-base with the target branch | Full suite |
| Feature branch | Merge-base with the default branch | Full suite |
| Default-branch push on GitHub, Gitea, or GitLab | Previous push SHA, covering all pushed commits | Full suite |
| Default-branch build on Bitbucket or Azure | No previous-push SHA available automatically | Full suite unless `BASE_REF` is set |
| Tag or unrecognized CI run | No baseline | Full suite |

Branch comparisons need the target branch and enough history in the checkout, such as `fetch-depth: 0` with GitHub Actions.

An explicit `baseRef`, `JEV_PLAYWRIGHT_BASE_REF`, or `BASE_REF` overrides detection. For example: `BASE_REF=origin/main pnpm exec playwright test`. Outside CI, no CI-provider detection runs.

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

Use `relevanceGuidance` for a shared rule sent once per request, and `relevanceCriteria` to customize either yes/no outcome on every typed question. Use `createQuestion` to change the per-test instructions, or `beforeRequest` to add project context:

```ts
export default defineConfigWithJev(
  {
    enabled: true,
    prTitle: process.env.PR_TITLE,
    relevanceGuidance: 'Consider indirect changes through shared billing services.',
    relevanceCriteria: {
      true: 'May affect billing test setup, execution, or assertions.',
      false: 'No plausible effect on billing test setup, execution, or assertions.'
    },
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

`relevanceCriteria` accepts partial overrides: omitted outcomes retain their defaults. Keep shared guidance concise because it is sent once per request; criteria are repeated for every test. `beforeRequest` may be async. Keep every `test_N` question or the full suite runs. Test details are appended to `createQuestion` output. Keep `createQuestion` deterministic because request sizing can call it more than once.

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

The inputs and result have these shapes:

- `changes.files` is a list of repository-relative paths. `diff`, `title`, and `description` are optional. Use `getGitChanges(cwd, baseRef?)` to gather git changes; it also returns file statuses and per-file patches for large diffs.
- `tests` is the discovered test catalog. Each entry needs a unique `id`, `file`, and `title`; `project`, `source`, `line`, and `column` are optional.
- `selectedIds` contains tests to run. `assessments` contains each scored test's relevance probability and model ID. `selectedIds: []` **without** `fallbackReason` means a complete decision found no tests; **with** `fallbackReason`, all test IDs are returned.

Pass `client` to reuse a configured TypeSafe SDK client. `detectCiDiff()` and `resolveConfig()` are also exported for custom integrations.

<br />

## Inspect decisions

Run with `DEBUG=jev-playwright:batch,jev-playwright:selection` for compact request and combined selection summaries. Use `DEBUG=jev-playwright:request` to inspect the full state and question list actually sent after `beforeRequest`, `DEBUG=jev-playwright:config` for resolved options (the provider key and configured client are masked), or `DEBUG=jev-playwright:*` for everything. Example (abbreviated):

```text
jev-playwright:batch request 1: candidates=68, contextBytes=8200
jev-playwright:batch request 1 result { model: 'typesafe/jev-1.13', selected: 4, total: 68 }
jev-playwright:selection selection result {
  selected: 4, excluded: 64, threshold: 0.5,
  topSelected: [{ title: 'customer checks out', location: 'e2e/checkout.spec.ts:12:3', probability: 0.91 }],
  topExcluded: [{ title: 'customer signs in', location: 'e2e/login.spec.ts:28:3', probability: 0.49 }]
}
[jev-playwright] Selected 4/68 tests
```

The selection result combines all batches and diff chunks, using each test's highest score across chunks. It samples the highest 10% and lowest 5% of selected tests and the highest and lowest 5% of excluded tests (at least five from each group when available). Locations use clickable `file:line:column` paths relative to the configured `cwd`, or absolute paths for tests outside it; programmatic tests without a line show the file alone. Directly changed specs run without a score and are not included in the samples. Each question uses explicit yes/no relevance criteria. For missing test bodies, use `DEBUG=jev-playwright:source,jev-playwright:test-body`.

<br />

## Configuration reference

Environment variables override the corresponding reporter options. Set JSON arrays for glob variables, for example `JEV_PLAYWRIGHT_INCLUDE='["src/**","e2e/**"]'`.

| Option                                      | Environment variable                                         | Default                                                       |
| ------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `enabled`                                   | `JEV_PLAYWRIGHT_ENABLED` (`true`/`false` or `1`/`0`)         | `false`                                                       |
| `baseRef`                                   | `JEV_PLAYWRIGHT_BASE_REF`, then `BASE_REF`                   | CI baseline or local changes                                  |
| `defaultBranch`                             | `JEV_PLAYWRIGHT_DEFAULT_BRANCH`                              | provider value, then `main`                                   |
| `cwd`                                       | `JEV_PLAYWRIGHT_CWD`                                         | `process.cwd()`                                               |
| `include`                                   | `JEV_PLAYWRIGHT_INCLUDE` (JSON string array)                 | `["**/*"]`                                                    |
| `exclude`                                   | `JEV_PLAYWRIGHT_EXCLUDE` (JSON string array)                 | `[]`                                                          |
| `excludeGeneratedFiles`                     | `JEV_PLAYWRIGHT_EXCLUDE_GENERATED_FILES`                     | `true`                                                        |
| `threshold`                                 | `JEV_PLAYWRIGHT_THRESHOLD`                                   | `0.5`                                                         |
| `diff.whitespace`                           | `JEV_PLAYWRIGHT_DIFF_WHITESPACE`                             | `all` (ignore whitespace-only changes); `none` preserves them |
| `diff.ignoreBlankLines`                     | `JEV_PLAYWRIGHT_DIFF_IGNORE_BLANK_LINES`                     | `false`                                                       |
| `diff.contextLines`                         | `JEV_PLAYWRIGHT_DIFF_CONTEXT_LINES`                          | `3`                                                           |
| `limits.stateAndQuestionTokens`             | `JEV_PLAYWRIGHT_LIMITS_STATE_AND_QUESTION_TOKENS`            | `32000`                                                       |
| `limits.requestTokens`                      | `JEV_PLAYWRIGHT_LIMITS_REQUEST_TOKENS`                       | `64000`                                                       |
| `limits.maxRequests`                        | `JEV_PLAYWRIGHT_LIMITS_MAX_REQUESTS`                         | `100`                                                         |
| `limits.maxConcurrentRequests`              | `JEV_PLAYWRIGHT_LIMITS_MAX_CONCURRENT_REQUESTS`              | `5`                                                           |
| `includeTestSource`                         | `JEV_PLAYWRIGHT_INCLUDE_TEST_SOURCE`                         | `true`                                                        |
| `perProject`                                | `JEV_PLAYWRIGHT_PER_PROJECT`                                 | `false` (share decisions across projects)                     |
| `relevanceGuidance`, `relevanceCriteria`     | Playwright config only                                       | Shared direct/indirect guidance; yes/no test relevance        |
| `maxTestSourceTokens`                       | `JEV_PLAYWRIGHT_MAX_TEST_SOURCE_TOKENS`                      | `5000` (maximum `5000`)                                       |
| `model`                                     | `JEV_PLAYWRIGHT_MODEL`                                       | `jev-latest`                                                  |
| `prTitle`, `prDescription`                  | `JEV_PLAYWRIGHT_PR_TITLE`, `JEV_PLAYWRIGHT_PR_DESCRIPTION`   | unset                                                         |
| `providerUrl`, `providerKey`                | `JEV_PLAYWRIGHT_PROVIDER_URL`, `JEV_PLAYWRIGHT_PROVIDER_KEY` | SDK defaults                                                  |
| `client`, `createQuestion`, `beforeRequest` | Playwright config only                                       | SDK client, built-in question, no hook                        |

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
