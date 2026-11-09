# Document and template system analysis

Original analysis: November 8, 2026. The analysis covered the working tree, including existing uncommitted changes. Existing files were not modified during that analysis; its new files were created exclusively in `experiment/`. The `.env` file was not read. No server requests or PDF compilation were performed.

## Data flow and entry points

```text
TeX → parser → internal typed ExamDoc → generic Node tree
         ↑ importTex: additional import checks and format detection
JSON → normalizeNode → Node → compactNode → stored JSON
                        ↕
                  edox Markdown
                        ↓
         TeX templates / HTML templates / HTML handlers
                        ↓
                 TeX / HTML output
                        ↓ (TeX through an external service)
                       PDF
```

| Area | Files / functions |
| --- | --- |
| Read TeX | src/shared/edox/parser/texparser.ts: texToExam, texToFlap |
| Import with diagnostics | src/shared/edox/import.ts: importTex |
| Intermediate representation | src/shared/edox/node.ts; document.schema.json |
| Read/write Markdown | src/shared/edox/markdown/index.ts: parseMarkdown, toMarkdown |
| General template engine | src/shared/template/index.ts, tokenize.ts, defaults.ts |
| Document template integration | src/shared/edox/renderer/rendertemplate.ts |
| Second HTML renderer | src/shared/edox/renderer/renderhtml.ts; renderer.ts |
| Table layout | src/shared/edox/table.ts |
| Points and TeX helpers | src/shared/edox/tex.ts |
| CLI | src/cli/edo-ws.ts |
| App templates / KaTeX | src/ui/templates.js |
| Text editor | src/apps/edit/routes/doc/[...path]/+page.svelte |
| PDF generation | src/ui/pdf.js; compileOnServer in auth.svelte.js |
| Edit existing PDFs | src/shared/pdf/index.ts |

## Intermediate representation

At runtime, every Node has `type: string`, `args: Record<string, any>`, and `children: Node[]`. Empty args/children are omitted when saving (`compactNode`); `normalizeNode` restores them when loading. The root type is `exam`, including worksheets, tests, and flaps; `args.kind` distinguishes these variants. The schema documents the compact storage format using JSON Schema 2020-12. The inspected loading/editor paths do not perform automatic schema validation.

Key types: section, exercise, task, paragraph, solution, hint, text, math, displaymath, bold, emph, underline, list, item, figure, tikz, table, points, answerspace, vspace, raw, linebreak, ctrlspace. Not every renderer handles every type explicitly.

Table cells are stored outside `children`: `args.rows[row][cell]` contains lists of inline nodes. `mapCells` and `tableCells` account for this second tree structure during normalization, compaction, point calculation, and form field assignment. New tree operations must visit these cells as well.

Text values (`text.args.value`, `title`) and TeX source (`math.args.tex`, `raw.args.tex`, `titleTex`, `tikz.args.code`) have different escaping rules. `args.points` is derived; `totalPoints` is an explicit override from `setpoints`. For optional exercises, `maxPoints` counts only the highest-scoring exercises that may be selected.

## TeX parser and import

The handwritten parser reads commands, groups, optional/required arguments, environments, comments, and mathematics. Signature tables `SIG`/`ENV_SIG` control known constructs. Parsing produces typed block/inline structures, followed by postprocessing and conversion to the generic Node tree. This parser is tailored to edox documents; it does not execute arbitrary TeX.

- `exam`, `test`, and `worksheet` use `texToExam`; `flap` has `texToFlap` and a separate import path.
- `exercise` → `exercise`; `subexercise` → `task`; `solve` → `solution`; `pp` → `points`. Sections collect subsequent content, and points are calculated. Exercise selection instructions are partly detected from German task text.
- Mathematics and TikZ remain TeX. Constructs that cannot be modeled may be preserved as `raw`.
- Tables recognize column types, fixed widths, grid lines, arraystretch, repeated columns, multicolumn, and row spacing. Unsupported table forms may fall back to `raw`.
- Preamble: documentclass, selected metadata, and newcommand/providecommand are imported. Other preamble commands are discarded and may be reported as ignored; the class/template would need to supply them.
- `importTex` checks JSON → TeX → JSON, reports raw constructs and multiple documents per file. For `exam_q-phase`, a recognized cover page may be replaced by `args.format` and timing arguments if the comparison succeeds. `timePartB` initially defaults to 55.
- This check is structural and partly whitespace-tolerant. It does not guarantee byte-identical TeX, identical layout, or preservation of the entire preamble. The final roundtrip check during normal import primarily compares `children`.

## Markdown-like format

This is a custom editable text representation of the JSON tree, not a complete CommonMark or YAML parser. Frontmatter between `---` markers contains one `key: value` per line; values are read as JSON where possible, otherwise as text. `parseMarkdown` always creates an `exam` root and returns `{ doc, errors }` with line numbers. Errors do not necessarily stop parsing.

```text
---
examName: Example
---
:::exercise title="An exercise"
Text with **bold**, *italic*, $x^2$, and ::points 2::.
:::
```

Block nodes: `:::type args … :::`. Inline/leaf nodes: `::type args::`; inline content: `::type args | content::`. Arguments use `key=value`, JSON strings/objects/arrays, or flags. `points`, `vspace`, and `raw` support a primary value without a key. `$$` blocks contain display mathematics; tex/Tikz code fences contain raw code; simple lists use `-` or `1.`; tables use `:::table` with pipe-separated rows. Unknown node types can generally be represented generically.

Derived points fields on exam/section/exercise/task are omitted when writing and recalculated when reading. Roundtrip preservation applies to supported forms, not arbitrary manually constructed Nodes. For example, the paragraph shorthand does not serialize arbitrary paragraph arguments; generic inline syntax searches for the next closing `::`, so nested edge cases require further investigation.

Editor flow: load JSON → generate Markdown → parse after 400 ms without input → save compact JSON only when there are no parser errors. Preview uses HTML templates and KaTeX. CodeMirror displays parser errors. Successful Markdown parsing does not replace schema or semantic validation.

## Template system and output

The custom Tera-like engine tokenizes once and uses an explicit execution stack; expressions have their own parser. It supports conditions, loops, set, include, extends/block/super, typed components with defaults, call/body, filters, and functions. Components have their own parameter scope. Template whitespace is normalized by default; inserted values/raw content are preserved. The default maximum stack depth is 256. Errors include template names and positions; rendering may continue after errors, so output alone does not indicate success.

TeX delimiters: `<< expression >>`, `<% statement %>`, `<# comment #>`. No automatic escaping; plain text uses the `text` filter/`escapeTex`. `texGlue` prevents TeX control words from consuming following characters. `render(node=...)` selects `components.<type>`, falling back to `components.command`. Block spacing depends on node type and task width.

Template selection: explicit argument > `args.format + .tex` > `worksheet.tex` for worksheet/test > `flap.tex` for flap > `base.tex`. Other bundled formats include `exam_ef.tex` and `exam_q-phase.tex`. New formats can read additional args; a new node type may require parser, Markdown, schema, and output support.

HTML uses `{{ expression }}`, `{% statement %}`, and automatic HTML escaping. `base.html` is a fragment with controls, `app.html` is the app variant, and `page.html` is a standalone page. CSS and grading.js provide presentation and grading behavior. KaTeX renders mathematics. TikZ currently produces a “missing tikz” placeholder; raw TeX is not generally converted to HTML.

The apps use HTML templates (`src/ui/templates.js`). The CLI `html` command instead uses `renderHtmlDocument` from the separate handler renderer. Type coverage differs: for example, the handler renderer lacks explicit table handling, while an HTML table template exists. Rendering without errors therefore does not prove equivalent content.

Form field names match the PDFs: `points-<exercise>-<subexercise>-<position>`, `Sum-Points-<exercise>`, Name, SumPointsTotal, Grade, CheckDate, Signature. `assignFieldNames` includes table cells in TeX order. Up to three integer points are rendered as checkboxes; larger values use a text field.

App PDF generation: JSON → examTex → compileOnServer with assets → PDF. `src/shared/pdf/index.ts` edits existing PDFs using pdf-lib/fontkit (form fields, font handling, etc.); it is not the TeX compiler.

## CLI

- `npm run edo-ws -- parse <file.tex> [out.json]`: basic parser with roundtrip feedback; stdout when no output path is supplied.
- `npm run edo-ws -- import <dir> <outdir> [--format <name>]`: batch import with diagnostics and optional format detection.
- `npm run edo-ws -- tex <exam.json> [out.tex]`: template-based TeX.
- `npm run edo-ws -- html <exam.json> [out.html]`: handler-based HTML; also writes CSS/JS when an output file is supplied.

The existing `src/cli/edo-ws.ts` CLI has no Markdown command; Markdown is available through the module and editor. The NewDocumentDialog UI imports through `texToExam` directly, without the more comprehensive `importTex` diagnostics.

## Experiment: converter library and CLI

`experiment/lib/` contains a standalone TypeScript subset of the existing document model, TeX parser, Markdown, and template modules. It imports no files from `src/`, allowing independent testing and later packaging. The template engine is under `experiment/lib/template/`; TeX components and the JSON schema are under `experiment/lib/edox/`. HTML renderers are intentionally excluded.

Public API from `experiment/lib/index.ts`:

```ts
import { createConverter, convert } from "./lib/index.ts";

const converter = createConverter();
const result = converter.convert(source, { from: "tex", to: "md" });
if (!result.ok) {
  console.error(result.diagnostics);
}
const json = convert(result.output, { from: "md", to: "json" });
```

`from` and `to` each accept `tex`, `json`, or `md`, supporting all nine combinations. `createConverter()` is reusable and accepts optional TeX template overrides. A custom template directory can be passed as the second argument: `createConverter({}, { templateDirectory: "./templates" })`. It is read recursively; its files override bundled templates with matching names, while missing files fall back to bundled templates. Direct overrides in the first argument take precedence. `convert()` is a convenience function for one-off conversions.

Results always contain output, the best available document tree, and positioned diagnostics. Recoverable errors may still produce output; check `ok` before replacing source files. Warnings do not set `ok` to `false`.

CLI examples (all inputs accept `-` for stdin; output defaults to stdout):

```sh
npm run experiment -- input.tex --to md -o output.md
npm run experiment -- tex-to-json input.tex output.json
npm run experiment -- input.json --to tex --format exam_q-phase
npm run experiment -- input.json --to tex --template-dir ./my-templates
cat input.md | npm run experiment -- - --from md --to tex
```

`--diagnostics file.json` writes a machine-readable report to that file in addition to stderr diagnostics. `--strict` treats warnings as errors. Exit codes: `0` success, `1` conversion error (output may still be usable), `2` usage or file error. Help: `npm run experiment -- --help`.

### npm package

The standalone manifest in `experiment/package.json` names the package `libedoxwrite`. After building, it can be imported as a library and provides the global `edoxwrite` command. Run `edoxwrite input.tex --to json` to use the CLI; `--template-dir ./templates` selects a custom template directory with bundled templates as fallback. `npm run build --prefix experiment` generates the publishable `experiment/dist/` directory.

Verification:

```sh
npm run experiment:check
npm run experiment:test
```

The conversion tests cover format transitions and the existing `test/` corpus. They compare JSON structures and check TeX rendering; they do not compile PDFs or guarantee byte-identical or pixel-identical layouts.

## Data audit and arbeit1

The original audit imported all 26 TeX files directly under `test/` in memory and compared them with their existing JSON files:

- 26/26 stored JSON files matched the compact output of `importTex`.
- 26/26 JSON → Markdown → JSON conversions were structurally identical, without Markdown errors.
- 26/26 stored documents rendered through TeX and HTML templates without reported rendering errors.
- `differentialrechnung.tex` contains five documents; `test_quadratzahlen.tex` contains two. Only the first document in each file is imported. This is an actual import limitation.
- The audit recorded raw TeX and discarded preamble lines per file; the historical report has since been removed.

`arbeit1` is the grade 10 mathematics exam on linear and quadratic functions: 86 points, two sections, ten exercise nodes including presentation points, 28 task nodes, 29 solutions, 53 points nodes, three tables, and three TikZ figures. It has one raw node containing hspace. The preamble definition renewcommand/sign is not imported. The import still matches the stored JSON because the stored representation also lacks that information.

## Verification and limitations

The original audit passed 55 existing tests (zero failures): template tokenizer/defaults/rendering, document import, Markdown, and document templates. `UPDATE` was unset to keep snapshot files unchanged:

```sh
env -u UPDATE node --test src/shared/template/*.test.ts src/shared/edox/import.test.ts src/shared/edox/markdown/markdown.test.ts src/shared/edox/renderer/rendertemplate.test.ts
```

The original test log and per-file audit report have been removed. That audit made no fixes and included no visual browser/PDF inspection, TeX compilation, or full app build. Successful roundtrips apply to this sample corpus, not every possible input.

On November 9, 2026, the experiment type check and package build passed, and all 68 experiment tests passed. The built library and CLI were also checked against the two worksheet examples and `arbeit1`. The sandbox blocked the `tsx` CLI's IPC socket, so the same suite was run successfully using:

```sh
env -u UPDATE node --import=tsx --test experiment/lib/template/*.test.ts experiment/tests/*.test.ts
```

The obsolete conversion test log showing the previous strip-only TypeScript failure has been removed. Generated TeX has not been compiled to PDF or visually inspected in this verification.

Future work should account for the two HTML pipelines, table cells outside children, separate text/TeX escaping, discarded preamble content, first-document-only imports, derived points and form field names, missing TikZ HTML output, and the distinction between parser errors and schema/rendering errors.
