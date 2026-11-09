// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT

// node --test src/shared/edox/renderer/rendertemplate.test.ts
// The TeX of the templates is compared with the expected files in testdata/.
// After an intended change of the templates: UPDATE=1 node --test … writes them anew;
// check the difference (git diff) before committing.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";

import { normalizeNode, type Node } from "../node.ts";
import { texToExam } from "../parser/texparser.ts";
import { createHtmlEngine, createTexEngine, renderHtmlTemplate, renderTexTemplate, texGlue } from "./rendertemplate.ts";

const here = import.meta.dirname;
const templateDir = join(here, "../templates/tex");
const testdata = join(here, "testdata");

function loadTemplates(dir: string, ext: string): Record<string, string> {
  const sources: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(ext)) sources[relative(dir, path)] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return sources;
}

const { engine, errors } = createTexEngine(loadTemplates(templateDir, ".tex"));
const html = createHtmlEngine(loadTemplates(join(here, "../templates/html"), ".html"));

/** Renders `doc` (with `template`, else its format) and compares with testdata/<name>.tex. */
function expectTex(name: string, doc: Node, template?: string) {
  const result = renderTexTemplate(doc, engine, template);
  assert.deepEqual(result.errors, []);
  const file = join(testdata, `${name}.tex`);
  if (process.env.UPDATE) writeFileSync(file, result.output);
  assert.equal(result.output, readFileSync(file, "utf8"), name);
}

/** Renders `doc` as HTML with `template` and compares with testdata/<name>. */
function expectHtml(name: string, doc: Node, template: string) {
  const result = renderHtmlTemplate(doc, html.engine, { template });
  assert.deepEqual(result.errors, []);
  const file = join(testdata, name);
  if (process.env.UPDATE) writeFileSync(file, result.output);
  assert.equal(result.output, readFileSync(file, "utf8"), name);
}

/** The parser reads back what base.tex writes: json -> tex -> json gives the same tree (without the args of the format). */
function roundTrip(doc: Node) {
  const tex = renderTexTemplate(doc, engine, "base.tex").output;
  const strip = (x: Node): Node => ({
    type: x.type,
    args: Object.fromEntries(Object.entries(x.args).filter(([k]) => !["points", "format", "timePartA", "timePartB"].includes(k))),
    children: x.children.map(strip),
  });
  assert.ok(isDeepStrictEqual(strip(texToExam(tex)), strip({ ...doc, args: { documentClass: "edoxarticle", ...doc.args } })));
}

const example = (name: string): Node =>
  // the example exams (copies of the edo-ws app examples)
  normalizeNode(JSON.parse(readFileSync(join(testdata, `${name}.json`), "utf8")));

const n = (type: string, args: Record<string, unknown> = {}, children: Node[] = []): Node => ({ type, args, children });
const text = (value: string) => n("text", { value });
const p = (...children: Node[]) => n("paragraph", {}, children);

/** Every node type and option once. */
const allTypes = (): Node =>
  n("exam", {
    documentOptions: "lang=ngerman", documentClass: "edoxarticle",
    examName: "Test", pointsName: "BE",
    macros: [{ name: "R", body: "\\mathbb{R}" }, { name: "N", body: "\\mathbb{N}", provide: true }, { name: "abs", args: 1, body: "|#1|" }, { name: "v", args: 2, default: "x", body: "#1#2" }],
    date: "21.10.2026", titleTex: "Mathe \\& Physik", totalPoints: 7,
  }, [
    n("section", { id: "A", title: "Teil A & B", newPage: true, command: "wssection" }, [
      n("exercise", { title: "Aufgabe 1", starred: true }, [
        n("task", { width: "0.5\\textwidth", newPage: true }, [
          p(text("Rechne "), n("math", { tex: "x_1 + 50\\%" }), text(" aus."), n("points", { value: 2 })),
          n("displaymath", { tex: "a^2 + b^2 = c^2" }),
          n("displaymath", { env: "align*", tex: "x &= 1\\\\\ny &= 2" }),
          n("solution", { inline: true }, [p(text("inline"))]),
          n("solution", {}, [p(text("block")), n("vspace", { size: "1cm" })]),
        ]),
        n("task", { starred: true }, [
          p(text("(i) erster Teil")), p(text("weiter")),
          p(text("(ii)")), n("displaymath", { tex: "1" }),
        ]),
      ]),
      n("exercise", {}, [
        n("list", { ordered: true }, [n("item", {}, [p(text("eins"))]), n("item", {}, [p(text("zwei"))])]),
        n("list", {}, [n("item", {}, [p(text("Punkt"))])]),
        n("figure", {}, [n("tikz", { options: "scale=2", code: "\\draw (0,0) -- (1,1);" }), n("tikz", { code: "\\fill (0,0) circle (1pt);" })]),
        n("answerspace", { kind: "answerbox", height: "3" }),
        p(
          n("hint", {}, [text("Tipp")]),
          n("bold", {}, [text("fett")]), n("emph", {}, [text("schräg")]), n("underline", {}, [text("unten")]),
          n("linebreak"), n("ctrlspace"), n("raw", { tex: "\\hfill" }),
          text("Text $ { } \\ ~ ^ – — €  x"),
          n("textit", { opt: "o" }, [text("eigen")]), n("relax"),
        ),
        // glue: control word before a letter, before [ and before *
        p(n("points"), text("Punkt"), n("points"), text("[x]"), n("raw", { tex: "\\foo" }), text("*"), n("points"), n("math", { tex: "y" })),
      ]),
    ]),
  ]);

test("templates load without errors", () => {
  assert.deepEqual(errors, []);
});

test("example exams with their format", () => {
  expectTex("klausuref", example("klausuref"));
  expectTex("klausurq2", example("klausurq2"));
});

test("example exams: parser round trip with base.tex", () => {
  roundTrip(example("klausuref"));
  roundTrip(example("klausurq2"));
});

// emph and underline have no component; the fallback "command" writes \emph{…}, \underline{…}.
test("all node types and options (base.tex)", () => {
  expectTex("all-types", allTypes(), "base.tex");
  // A choice of exercises: \setpoints comes from totalPoints only, TeX sums all \pp.
  expectTex("choice", n("exam", { title: "Wahl", totalPoints: 5 }, [
    n("section", { title: "A", choice: { select: 1 } }, [
      n("exercise", {}, [p(n("points", { value: 3 }))]),
      n("exercise", {}, [p(n("points", { value: 5 }))]),
    ]),
  ]), "base.tex");
  expectTex("empty", n("exam", {}, []), "base.tex");
});

test("HTML templates load without errors", () => {
  assert.deepEqual(html.errors, []);
});

test("HTML: exam fragment, app variant and standalone page", () => {
  expectHtml("klausuref.html", example("klausuref"), "base.html");
  expectHtml("klausurq2.app.html", example("klausurq2"), "app.html");
  expectHtml("klausurq2.page.html", example("klausurq2"), "page.html");
  expectHtml("all-types.html", allTypes(), "base.html");
});

test("texGlue", () => {
  assert.equal(texGlue("a\\pp", "b"), " ");
  assert.equal(texGlue("a\\pp", "[1]"), "{}");
  assert.equal(texGlue("a\\pp", "*"), "{}");
  assert.equal(texGlue("a\\pp", "$x$"), "");
  assert.equal(texGlue("a\\\\", "b"), "");
  assert.equal(texGlue("a}", "b"), "");
});

/** A worksheet as the edox classes write it: name macro, solution option through a macro. */
const WORKSHEET = String.raw`\documentclass[lang=ngerman]{edoxarticle}
\renewcommand\worksheetname{Übung}
\renewcommand\testname{ohne Wirkung}
\providecommand{\usesolution}{nosolution}
\begin{document}
\pdate{}
\begin{worksheet}[\usesolution]{Terme -- Teil 1}

\glqq Zitat\grqq\quad weiter

\begin{tabular}{|p{3cm}|c|}
\hline
 & richtig\\
\hline
$|x|$ \& mehr & $\square$\\
\hline
\end{tabular}

\begin{center}
\begin{tabular}{@{}lr@{}}
a & \textbf{b}\\[4pt]
c &
\end{tabular}
\end{center}

\exercise[Funktion 4.\ Grades]{
\subexercise[0.3\hsize]{
$2(x+3)$
\solve{$2x+6$}
}
\subexercise[0.3\hsize]{
$4(x+5)$
\solve{$4x+20$}
}
}
\end{worksheet}
\end{document}
`;

test("worksheet: kind, name, solutions, quotes, tables, side by side tasks", () => {
  const ignored: string[] = [];
  const doc = texToExam(WORKSHEET, ignored);
  assert.equal(doc.args.kind, "worksheet");
  assert.equal(doc.args.examName, "Übung");
  assert.equal(doc.args.solutions, false);
  assert.equal(doc.args.macros, undefined); // \usesolution only served the option
  assert.deepEqual(ignored, ["\\renewcommand\\testname{ohne Wirkung}"]);
  assert.deepEqual(doc.children[0].children[0], text("„Zitat“\u2003weiter"));
  const [grid, centered] = [doc.children[1], doc.children[2]];
  assert.deepEqual(grid.args.columns, ["p{3cm}", "c"]);
  assert.equal(grid.args.rules, "grid");
  assert.deepEqual(grid.args.rows[1][0], [n("math", { tex: "|x|" }), text(" & mehr")]);
  assert.deepEqual(
    { ...centered.args, rows: undefined },
    { columns: ["l", "r"], compact: true, rowSpace: "4pt", center: true, rows: undefined },
  );
  assert.deepEqual(centered.args.rows[1], [[text("c")], []]);
  assert.equal(doc.children[3].args.titleTex, "Funktion 4.\\ Grades");
  expectTex("worksheet", doc);
  expectHtml("worksheet.html", doc, "base.html");
  // json -> tex -> json
  assert.ok(isDeepStrictEqual(texToExam(renderTexTemplate(doc, engine).output), doc));
});

test("test: \\testname, default solution, HTML keeps the grading footer only for tests", () => {
  const tex = WORKSHEET.replace(/worksheet\}/g, "test}").replace("nosolution", "solution");
  const doc = texToExam(tex);
  assert.equal(doc.args.kind, "test");
  assert.equal(doc.args.examName, "ohne Wirkung");
  assert.equal(doc.args.solutions, undefined);
  assert.match(renderTexTemplate(doc, engine).output, /\\renewcommand\\testname\{ohne Wirkung\}[^]*\\begin\{test\}\[solution\]/);
  const footer = (d: Node) => renderHtmlTemplate(d, html.engine, { template: "base.html" }).output.includes('data-type="grading"');
  assert.equal(footer(doc), true);
  assert.equal(footer(texToExam(WORKSHEET)), false);
});

test("points in table cells: counted and graded like any other, fields in TeX order", () => {
  const tex = String.raw`\documentclass{edoxarticle}
\begin{document}
\begin{exam}{Tabelle}
\exercise{
Berechne.
\solve{
\begin{tabular}{ll}
$1^2$\pp & $2^2$\pp[2]\\
$3^2$\pp & 
\end{tabular}

Danach.\pp
}
}
\end{exam}
\end{document}
`;
  const doc = texToExam(tex);
  assert.equal(doc.args.points, 5);
  assert.equal(doc.children[0].args.points, 5);
  assert.match(renderTexTemplate(doc, engine).output, /\$1\^2\$\\pp & \$2\^2\$\\pp\[2\]\\\\\n\$3\^2\$\\pp & \n/);
  const out = renderHtmlTemplate(doc, html.engine, { template: "base.html" }).output;
  const fields = [...out.matchAll(/name="(points-[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fields, ["points-1-0-1", "points-1-0-2", "points-1-0-3", "points-1-0-4", "points-1-0-5"]);
  assert.ok(out.indexOf('name="points-1-0-4"') < out.indexOf("</table>"));
});

test("tables: \\arraystretch, *{n}{…}, centered p columns, \\multicolumn, space per row", () => {
  const tex = String.raw`\documentclass{edoxarticle}
\begin{document}
\begin{worksheet}{Tabellen}
\begin{center}
\renewcommand{\arraystretch}{1.5}
\begin{tabular}{|*{2}{p{1.4cm}|}}
\hline
\centering$0{,}04$ & \centering\arraybackslash$-1{,}2$\\
\hline
 & \\[4pt]
\hline
\end{tabular}
\end{center}

\begin{center}
\begin{tabular}{|p{4cm}|>{\centering\arraybackslash}p{3cm}|}
\hline
\multicolumn{2}{|c|}{\textbf{Kopf}}\\
\hline
links & mitte\\
\hline
\end{tabular}
\end{center}
\end{worksheet}
\end{document}
`;
  const doc = texToExam(tex);
  const [a, b] = doc.children.map((t) => ({ ...t.args, rows: undefined }));
  assert.deepEqual(a, { columns: ["c{1.4cm}", "c{1.4cm}"], rules: "grid", rowSpaces: ["", "4pt"], stretch: "1.5", center: true, rows: undefined });
  assert.deepEqual(b, { columns: ["p{4cm}", "c{3cm}"], rules: "grid", spans: [{ row: 0, column: 0, columns: 2, align: "c" }], center: true, rows: undefined });
  assert.deepEqual(doc.children[0].args.rows[0][0], [n("math", { tex: "0{,}04" })]);

  const out = renderTexTemplate(doc, engine).output;
  assert.match(out, /\\renewcommand\{\\arraystretch\}\{1\.5\}\n\\begin\{tabular\}\{\|>\{\\centering\\arraybackslash\}p\{1\.4cm\}\|/);
  assert.match(out, / & \\\\\[4pt\]\n\\hline/);
  assert.match(out, /\\multicolumn\{2\}\{\|c\|\}\{\\textbf\{Kopf\}\}\\\\/);
  assert.deepEqual(normalizeNode(texToExam(out)).children, normalizeNode(doc).children);

  const page = renderHtmlTemplate(doc, html.engine, { template: "base.html" }).output;
  assert.match(page, /<table data-type="table" data-rules="grid" data-center style="--stretch: 1\.5">/);
  assert.match(page, /<tr style="--space: 4pt">/);
  assert.match(page, /<td colspan="2" data-align="center"><strong>Kopf<\/strong><\/td>/);
});
