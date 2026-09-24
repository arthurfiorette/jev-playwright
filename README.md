# unused18n

Find unused keys in TypeScript and JSON [i18next](https://www.i18next.com/) dictionaries.

`unused18n` understands statically recoverable translation keys, reports unused keys at their dictionary declarations, and can safely remove them. It is ESM-only and requires Node.js 24.16 or newer.

## Install

```sh
npm install --save-dev unused18n
```

## Quick start

Given a JSON dictionary:

```json
{
  "common": {
    "save": "Save",
    "cancel": "Cancel"
  }
}
```

and application code that only uses `common.save`:

```ts
import messages from './i18n/en.json' with { type: 'json' };

messages.common.save;
```

run:

```sh
npx unused18n lint \
  --dictionary=./src/i18n/en.json
```

`unused18n` reports the unused key at its declaration:

```text
src/i18n/en.json:4:5 - error TS95001: Translation key "common.cancel" is unused.
```

### Dictionary formats

| Dictionary                | Export option                                                 |
| ------------------------- | ------------------------------------------------------------- |
| JSON object               | None; JSON always uses its implicit default export            |
| TypeScript default export | None; `default` is used automatically                         |
| TypeScript named export   | The sole export is inferred; otherwise pass `--export=<name>` |

TypeScript exports must resolve statically to an object or array. Application files must be included in the selected TypeScript project. JSON dictionaries work without enabling `resolveJsonModule` in your `tsconfig.json`.

When an entire object subtree is unused, one `TS95001` diagnostic covers the complete property instead of reporting every leaf.

### Multiple locales

Use a glob to analyze every locale dictionary with one TypeScript source pass:

```sh
npx unused18n lint \
  --project=./tsconfig.json \
  --dictionary='./src/i18n/*.json'
```

Matched files are deduplicated and sorted. The filename stem supplies the locale, so `pt-BR.json` uses `pt-BR` plural rules. Dictionaries may have different physical keys: `t('item', { count })` can use `_one` and `_other` in English while using `_zero`, `_two`, `_few`, and `_many` where those categories exist. Literal `context` values compose before plural suffixes, and `ordinal: true` uses `_ordinal_<category>` variants. When a specific variant is absent, analysis follows the existing i18next fallback chain without reinterpreting literal suffix-like keys.

## Supported patterns

### Literals and finite keys

Literal, conditional, concatenated, asserted, and finite template-literal keys are resolved:

```ts
const { t } = useTranslation();

t('common.save');
t(isEditing ? 'form.update' : 'form.create');
t(apiKey as 'errors.notFound' | 'errors.unauthorized');

function statusLabel(status: 'pending' | 'complete') {
  return t(`status.${status}`);
}
```

### Aliases, prefixes, and wrappers

Translator aliases, `keyPrefix`, `<Trans>`, and analyzable custom hooks or typed helpers retain their translation provenance:

```tsx
import i18n, { getFixedT, t as translate } from 'i18next';
import {
  Trans as Message,
  useTranslation as useI18n
} from 'react-i18next';

translate('common.save');
i18n.t('common.cancel');
getFixedT(null, null, 'checkout')('title');

const { t: commonT } = useI18n(undefined, { keyPrefix: 'common' });
commonT('save');

function useCheckoutTranslation() {
  return useI18n(undefined, { keyPrefix: 'checkout' });
}

const { t: checkoutT } = useCheckoutTranslation();
checkoutT('title');

<Message i18nKey='empty.title' />;
```

Application-specific wrappers must have an implementation available in the selected TypeScript project unless the translator value is typed as i18next's `TFunction`.

### Objects and dictionary access

Object-returning translations and direct dictionary access track the properties that are consumed:

```ts
const dashboard = t('dashboard', {
  returnObjects: true
}) as typeof dictionary.dashboard;

dashboard.title;
const { description } = dashboard;

dictionary.common.save;
const { cancel } = dictionary.common;
Object.keys(dictionary.categories);
```

Array and readonly-tuple iteration through standard receiver methods such as `map`, `forEach`, `reduce`, `some`, `every`, and `find` conservatively marks every array element as possibly used. A normal dictionary property named `map` remains ordinary property access.

Dictionary paths use `.` separators. i18next namespaces and custom `keySeparator` behavior are not interpreted. Unbounded runtime keys produce source-located warnings; they do not mark unrelated dictionary keys as used, and warnings alone do not fail the command.

Calls with `returnObjects: true` should use the dictionary type inferred by i18next. Wrapping the returned object in `as SomeType` or a type assertion emits `TS95006`; casts remain transparent to usage analysis but can hide dictionary drift from the application type checker. Run `--remove` to delete these assertions automatically.

## Remove unused keys

```sh
npx unused18n lint \
  --project=./tsconfig.json \
  --dictionary=./src/i18n/en.json \
  --remove
```

Removal preserves unrelated formatting and comments. It is all-or-nothing across dictionary keys and `TS95006` cast fixes: if any edit cannot be applied safely, every source remains unchanged. A wholly unused array-valued object property is removed as one unit; individual array elements, computed properties, shared or imported objects, unresolved spreads, and ambiguous overwrites must be removed manually.

Before using `--remove`, ensure every dictionary is tracked by Git or another version-control system and that you can restore its previous revision. Successful removal does not retain a long-lived backup after the atomic replacement completes.

The CLI summarizes unused and removed key counts instead of printing one diagnostic per key. Unresolved references and removal failures remain source-located. Programmatic `lint()` consumers still receive every detailed diagnostic.

## Configuration

Create `.unused18nrc` in the directory where the CLI runs:

```json
{
  "$schema": "./node_modules/unused18n/schema.json",
  "project": "./tsconfig.json",
  "dictionaries": "./src/i18n/*.json",
  "maxExpansions": 1000,
  "cache": true,
  "logLevel": "info"
}
```

The bundled schema documents every option and provides editor validation and completion. Relative `project`, `dictionaries`, and `cacheDir` paths resolve from the config file directory. `dictionaries` accepts one path/glob or an array. CLI flags override config values.

Use `--config=<path>` to load a different JSON file. Without it, `unused18n` looks for `.unused18nrc` in the current working directory. A missing default config is ignored.

## CLI options

| Option                    | Description                                                               |
| ------------------------- | ------------------------------------------------------------------------- |
| `--config <path>`         | Load JSON options from this file instead of `.unused18nrc`                |
| `-p, --project <path>`    | `tsconfig.json` path or directory; defaults to `./tsconfig.json`          |
| `-d, --dictionary <path>` | Required by flag or config. Repeatable dictionary path/glob               |
| `-e, --export <name>`     | TypeScript export name; omission prefers `default`, then one value export |
| `--[no-]remove`           | Enable or override config-file removal                                    |
| `--max-expansions <n>`    | Maximum number of finite key combinations; defaults to `1000`             |
| `--no-cache`              | Disable persistent caching                                                |
| `--cache-dir <path>`      | Override the cache directory                                              |
| `--[no-]cache-stats`      | Enable or override config-file cache statistics                           |
| `--log-level <level>`     | Operational output: `silent`, `info`, or `debug`                          |

Caching is enabled by default under `<tsconfig-directory>/node_modules/.cache/unused18n`. The directory can be safely deleted. Cache failures fall back to a normal analysis without changing diagnostics or exit status.

Run `npx unused18n help` for command help or `npx unused18n autocomplete` to configure shell completion.

## Exit codes

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| `0`  | No unused keys remain, or every requested removal succeeded |
| `1`  | Unused keys remain, or analysis/removal failed              |
| `2`  | CLI arguments or flags are invalid                          |

## Programmatic API

`lint()` returns a lazy generator of standard TypeScript diagnostics:

```ts
import { DiagnosticCode, lint } from 'unused18n';

for (const diagnostic of lint({
  project: './tsconfig.json',
  dictionaries: './src/i18n/*.json'
})) {
  if (diagnostic.code === DiagnosticCode.UnusedKey) {
    console.log(diagnostic.file?.fileName, diagnostic.messageText);
  }
}
```

### `LintOptions`

| Option             | Type                          | Default                                              |
| ------------------ | ----------------------------- | ---------------------------------------------------- |
| `project`          | `string`                      | `'./tsconfig.json'`                                  |
| `dictionaries`     | `string \| string[]`          | Required                                             |
| `dictionary`       | `string`                      | Deprecated single-dictionary alias                   |
| `dictionaryExport` | `string`                      | Prefer `default`, then infer the sole export         |
| `maxExpansions`    | `number`                      | `1000`                                               |
| `remove`           | `boolean`                     | `false`                                              |
| `cache`            | `boolean`                     | `true`                                               |
| `cacheDir`         | `string`                      | `<tsconfig-directory>/node_modules/.cache/unused18n` |
| `onCacheEvent`     | `(event: CacheEvent) => void` | No callback                                          |
| `onEvent`          | `(event: LintEvent) => void`  | No callback                                          |
| `now`              | `() => number`                | `performance.now`                                    |

The package exports `lint`, `DiagnosticCode`, and the `LintOptions`, `Unused18nConfig`, `LintEvent`, `LogLevel`, and `CacheEvent` types. Iteration performs project loading and analysis; with `remove: true`, it may also update the dictionary. `LintEvent` includes final key statistics plus start/end timestamps for the `project`, `dictionary`, `discovery`, `usage`, `replay`, and `removal` stages; the CLI prints stage durations only at debug level.

## Performance benchmarks

Maintainers benchmark direct `lint()` calls with mitata so CLI parsing and rendering do not affect results. See the [benchmark guide](https://github.com/arthurfiorette/unused18n/blob/main/bench/README.md) in the source repository.
