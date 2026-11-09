// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT

// node --test src/shared/edox/import.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { importTex } from "./import.ts";
import { createTexEngine, renderTexTemplate } from "./renderer/rendertemplate.ts";
import type { Node } from "./node.ts";

const templateDir = join(import.meta.dirname, "templates/tex");
const sources: Record<string, string> = {};
for (const entry of readdirSync(templateDir, { recursive: true, withFileTypes: true })) {
  const path = join(entry.parentPath, entry.name);
  if (entry.isFile() && path.endsWith(".tex")) sources[relative(templateDir, path)] = readFileSync(path, "utf8");
}
const { engine } = createTexEngine(sources);

const n = (type: string, args: Record<string, unknown> = {}, children: Node[] = []): Node => ({ type, args, children });

/** An exam whose cover is the one of exam_q-phase, with 40 minutes for part A. */
function qExam(): string {
  const doc = n("exam", { examName: "Klausur 1", pointsName: "BE", title: "Mathematik", format: "exam_q-phase", timePartA: 40 }, [
    n("section", { id: "A", title: "Teil A" }, [n("exercise", { title: "Aufgabe 1" }, [n("paragraph", {}, [n("points", { value: 2 })])])]),
  ]);
  // the cover as the template writes it, without the closing block of the format
  return renderTexTemplate(doc, engine).output.replace(/\\vskip20pt\n\\textbf\{Zugelassene Hilfsmittel[^]*?\\end\{itemize\}\n/, "");
}

test("import: the cover becomes the format, its time timePartA", () => {
  const { doc, notes, warnings } = importTex(qExam(), engine);
  assert.equal(doc.args.format, "exam_q-phase");
  assert.equal(doc.args.timePartA, 40);
  assert.equal(doc.args.timePartB, 55);
  assert.equal(doc.children[0].type, "section");
  assert.equal(doc.children[0].args.newPage, undefined); // the template writes the \newpage
  assert.ok(notes.some((x) => x.startsWith("cover replaced")));
  assert.ok(notes.includes("format exam_q-phase adds 3 block(s) at the end (aids for part B)"));
  assert.deepEqual(warnings, []);
});

test("import: a changed cover is kept", () => {
  const { doc, warnings } = importTex(qExam().replace("Zeichengeräte und ein", "Zeichengeräte, ein"), engine);
  assert.equal(doc.args.format, undefined);
  assert.equal(doc.children[0].type, "vspace");
  assert.deepEqual(warnings, ["cover differs from format exam_q-phase: kept in the document"]);
});

test("import: several documents in one file, raw TeX is counted (also in table cells)", () => {
  // the first tabular has a single \\hline: no table; the second becomes one with raw TeX in a cell
  const ws = (title: string) =>
    `\\begin{worksheet}{${title}}\n\\begin{tabular}{ll}\\hline a&b\\end{tabular}\n\n\\begin{tabular}{ll}\\hfill a&b\\end{tabular}\n\\end{worksheet}\n`;
  const { doc, warnings, raw } = importTex(`\\documentclass{edoxarticle}\n\\begin{document}\n${ws("A")}% \\begin{worksheet}\n${ws("B")}\\end{document}\n`, engine);
  assert.equal(doc.args.title, "A");
  assert.deepEqual(warnings, ["file holds 2 documents, only the first was imported"]);
  assert.deepEqual(raw, { "\\begin{tabular}": 1, "\\hfill": 1 });
});

test("import: a flap keeps title, planning, stations and retro, the rest comes from flap.tex", () => {
  const flap = (parentsign: string) => String.raw`\documentclass[nocopyright]{edoxarticle}
\usepackage{edoxflap}
\begin{document}
\begin{flap}{Terme \& Gleichungen}{\underline{\hspace{3cm}}}
\sprintplanning{Wir können Terme aufstellen.}
\stations{%
\stationrow{1}{Terme aufstellen}
\stationrow{2}{Formeln umstellen}%
}
\sprintretro{Alle kommen voran.}
${parentsign}
\end{flap}
\end{document}
`;
  const { doc, warnings } = importTex(flap("\\parentsign"), engine);
  assert.deepEqual(doc, n("exam", {
    kind: "flap", title: "Terme & Gleichungen", planning: "Wir können Terme aufstellen.",
    stations: [{ number: 1, title: "Terme aufstellen" }, { number: 2, title: "Formeln umstellen" }],
    retro: "Alle kommen voran.",
  }));
  assert.deepEqual(warnings, []);
  assert.match(renderTexTemplate(doc, engine).output, /\\begin\{flap\}\{Terme \\& Gleichungen\}/);
  // anything else that differs from flap.tex is not in the model: reported
  assert.deepEqual(importTex(flap(""), engine).warnings, [
    "the file differs from flap.tex beyond title, planning, stations and retro: those parts were not kept",
  ]);
});
