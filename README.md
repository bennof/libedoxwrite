# libedoxwrite

A TypeScript library and command-line tool for converting edox TeX documents, JSON document trees, and edox Markdown. It supports all nine combinations of these three formats, with diagnostics and partial recovery for malformed input.

This is an experimental converter for edox documents, not a general-purpose LaTeX converter. It does not compile PDFs or render HTML. Generated TeX uses the external edox document classes.

## Requirements and setup

Node.js 20 or later and npm are required. From the repository root:

```sh
npm ci
npm run check
npm test
npm run build
node dist/cli.js --help
```

There are no runtime npm dependencies. TypeScript and tsx are development dependencies. Build output is generated in `dist/` and is not committed.

## CLI

```sh
node dist/cli.js input.tex --to json -o output.json
node dist/cli.js json-to-md input.json output.md
node dist/cli.js input.md --to tex --format exam_q-phase
node dist/cli.js input.json --to tex --template-dir ./my-templates
cat input.md | node dist/cli.js - --from md --to tex
```

To use the `edoxwrite` command locally, run `npm link` after building.

Input format is inferred from the extension unless `--from` is provided. Use `-` for stdin or stdout. Output defaults to stdout; diagnostics go to stderr. `--diagnostics report.json` also writes a JSON diagnostic report. `--strict` treats warnings as failures.

Exit codes:

- `0`: success, possibly with warnings.
- `1`: conversion errors, or warnings in strict mode.
- `2`: usage or I/O error.

Output is written even when conversion reports errors. Inspect diagnostics before replacing an original document.

## Library

After building, use the local module:

```js
import { createConverter } from "./dist/lib/index.js";

const converter = createConverter();
const result = converter.convert(source, { from: "tex", to: "json" });
if (!result.ok) {
  console.error(result.diagnostics);
} else {
  console.log(result.output);
}
```

When installed as a package, import from `libedoxwrite`. This README does not imply that the package has been published to npm.

`from` and `to` accept `tex`, `json`, or `md`. Results contain `output`, `doc`, `diagnostics`, and `ok`. Warnings alone do not set `ok` to false. Reuse a converter for multiple documents; `convert(source, options)` is also exported for one-off conversions.

Custom templates can be supplied with `createConverter(overrides, { templateDirectory: "./templates" })`. Directory templates override bundled files by relative path; direct overrides take precedence over both. Missing templates fall back to the bundled set. Output options include `format` and an explicit `template` name.

## Development and verification

```sh
npm run check
npm test
npm run build
npm pack --dry-run
```

The standalone suite covers the template engine, conversions, malformed input recovery, template overrides, and CLI behavior. When this directory is inside the original workspace and a sibling `test/` directory exists, it also runs the local TeX/JSON corpus tests. Those private/local documents are not required for standalone tests and are not included in this project.

GitHub Actions runs checks, tests, builds, and package inspection on Node.js 20, 22, and 24. The workflow assumes this directory is the repository root.

`npm pack` runs validation and builds the package. Published package contents are limited to `dist/` plus npm's standard README, license, and package metadata. Neither GitHub nor npm publishing is automatic.

## Known limitations

- Only the first document in a TeX file is imported.
- Unsupported preamble commands may be discarded with warnings, including `\renewcommand\sign`.
- Unknown TeX constructs may remain as raw TeX.
- Markdown is an edox-specific format, not full CommonMark or YAML.
- Successful structural roundtrips do not guarantee identical TeX layout.
- Tests do not compile PDFs or inspect rendered pages.
- Document templates retain German exam text; the parser recognizes some German exercise-selection instructions.

See [the architecture notes](docs/architecture.md) for the original workspace analysis and implementation details. References to `src/` and audit logs in those notes describe the original workspace, not dependencies of this standalone package.

## License

[MIT](LICENSE), copyright Benjamin Benno Falkner.

## Publishing

See [the GitHub publishing steps](docs/publishing.md) to create a standalone repository from this directory.

## Third-party licenses

Run `npm ci`, then `npm run licenses` to generate `THIRD-PARTY-LICENSES.txt`
and a machine-readable `THIRD-PARTY-LICENSES.json`. From the parent workspace,
use `npm run licenses --prefix experiment`.

The command uses [license-checker-rseidelsohn](https://github.com/RSeidelsohn/license-checker-rseidelsohn)
to collect installed direct and transitive dependencies, including development
tools. It preserves license texts and additional top-level NOTICE/copyright files,
and fails on missing texts or unresolved license identifiers. Reports omit local
absolute paths. Platform-specific optional dependencies are covered only when
installed; generate reports on the platform whose dependencies you distribute.

`npm pack` regenerates the reports through `prepack` and includes both in the
package. CI also checks generation. The project MIT license remains in `LICENSE`.
The reports document npm dependencies; external TeX classes, fonts, and manually
copied code require their own attribution where applicable. Collecting notices
does not by itself verify every obligation of every license.
