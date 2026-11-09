// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT

// node --test src/shared/edox/markdown/markdown.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { normalizeNode, type Node } from "../node.ts";
import { derivePoints, parseMarkdown, toMarkdown } from "./index.ts";

const here = import.meta.dirname;
const example = (name: string): Node =>
  // the examples of the app; shared code does not import them, the test only reads them
  normalizeNode(JSON.parse(readFileSync(join(here, "../renderer/testdata", `${name}.json`), "utf8")));

const n = (type: string, args: Record<string, unknown> = {}, children: Node[] = []): Node => ({ type, args, children });
const text = (value: string) => n("text", { value });
const p = (...children: Node[]) => n("paragraph", {}, children);

/** json → markdown → json gives the same tree, and the markdown is stable. */
function roundTrip(doc: Node) {
  const md = toMarkdown(doc);
  const { doc: back, errors } = parseMarkdown(md);
  assert.deepEqual(errors, []);
  assert.deepEqual(back, doc);
  assert.equal(toMarkdown(back), md);
  return md;
}

test("example exams: json → markdown → json", () => {
  roundTrip(example("klausuref"));
  roundTrip(example("klausurq2"));
});

test("the markdown reads well", () => {
  const md = toMarkdown(example("klausuref"));
  assert.ok(md.startsWith("---\nformat: exam_ef\nexamName: Klausur 1\ndate: \"\"\ntitle: Mathematik EF GK\n---\n\n"), md.slice(0, 120));
  assert.match(md, /^:::section id=A title="Prüfungsteil A: Aufgaben ohne Hilfsmittel"$/m);
  assert.match(md, /^\*\*Hinweis:\*\* Für Prüfungsteil A sind außer Zeichengeräten keine Hilfsmittel zugelassen\.$/m);
  assert.match(md, /^:::exercise title="Aufgabe 1" starred$/m);
  assert.match(md, /^::vspace 10pt::$/m);
  assert.doesNotMatch(md, /points=/); // derived, computed again
});

test("all node types, unknown ones included", () => {
  const doc = n("exam", { format: "exam_q-phase", examName: "Test", title: "3", totalPoints: 7, macros: [{ name: "R", body: "\\mathbb{R}" }] }, [
    n("section", { id: "A", title: "Teil A & B", newPage: true, choice: { select: 1 } }, [
      n("exercise", { title: "Aufgabe 1", starred: true }, [
        n("task", { width: "0.5\\textwidth", newPage: true }, [
          p(text("Rechne "), n("math", { tex: "x_1 + 50\\%" }), text(" aus."), n("points", { value: 2 })),
          n("displaymath", { tex: "a^2 + b^2 = c^2" }),
          n("displaymath", { env: "align*", tex: "x &= 1\\\\\ny &= 2" }),
          n("solution", { inline: true }, [p(text("inline"))]),
          n("solution", {}, [p(text("block")), n("points", { value: 3 }), n("vspace", { size: "1cm" })]),
        ]),
        n("hint", {}, [text("Tipp: "), n("math", { tex: "x" })]),
      ]),
      n("exercise", {}, [
        n("list", { ordered: true }, [n("item", {}, [p(text("eins"))]), n("item", {}, [p(text("zwei"))])]),
        n("list", {}, [n("item", {}, [p(text("Punkt")), p(text("zweiter Absatz"))])]),
        n("figure", {}, [n("tikz", { options: "scale=2", code: "\\draw (0,0) -- (1,1);\n\\fill (0,0) circle (1pt);" }), n("tikz", { code: "x" })]),
        n("answerspace", { kind: "mathbox", height: "3" }),
        n("raw", { tex: "\\begin{center}\nx\n\\end{center}" }),
        p(
          n("bold", {}, [text("fett "), n("emph", {}, [text("und schräg")])]),
          text(" bzw."), n("ctrlspace"), text("dann "), n("linebreak"),
          n("raw", { tex: "\\hfill" }),
          text("Sonderzeichen: * $ \\ :: :"),
          n("textcolor", { color: "red" }, [text("eigen")]),
          n("relax"),
        ),
        p(n("points")),
        p(text("- kein Listeneintrag")),
        p(text("2. auch keiner")),
        p(text(":::nicht")),
        n("unknownblock", { a: 1, b: "x y", c: false }, [p(text("innen"))]),
        n("unknownleaf", { flag: true }),
      ]),
    ]),
  ]);
  derivePoints(doc);
  roundTrip(doc);
});

test("unknown types are kept", () => {
  const { doc, errors } = parseMarkdown(":::box color=blue\nText ::star size=3::\n:::\n\n::marker::\n");
  assert.deepEqual(errors, []);
  assert.deepEqual(doc.children, [
    n("box", { color: "blue" }, [p(text("Text "), n("star", { size: 3 }))]),
    n("marker"),
  ]);
});

test("written by hand: paragraphs over several lines, lists, defaults", () => {
  const { doc, errors } = parseMarkdown(
    "Erste Zeile\nzweite Zeile\n\n- a\n- b *c*\n\n::points::\n\n:::exercise\n:::task\nText ::points 2::\n:::\n:::\n",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(doc.children[0], p(text("Erste Zeile zweite Zeile")));
  assert.equal(doc.children[1].type, "list");
  assert.deepEqual(doc.children[1].children[1], n("item", {}, [p(text("b "), n("emph", {}, [text("c")]))]));
  assert.deepEqual(doc.children[2], n("points"));
  // derived points are computed
  assert.equal(doc.children[3].args.points, 2);
  assert.equal(doc.children[3].children[0].args.points, 2);
  assert.equal(doc.args.points, 3);
});

test("errors with line numbers; reading goes on", () => {
  const front = parseMarkdown("---\ntitle: x\n\nText\n");
  assert.deepEqual(front.errors, [{ line: 1, message: "front matter: missing closing ---; read as text" }]);
  assert.equal(front.doc.children.length, 2);

  const r = parseMarkdown(":::section\nText $x and **bold\n:::\n:::\n\n$$\ny\n\n:::open\nz\n");
  assert.deepEqual(r.errors.map((e) => `${e.line}: ${e.message}`), [
    "2: missing closing $",
    "4: ::: without an open block",
    "6: missing closing $$",
  ]);
});

test("tables: one line per row, | in text escaped, | in math and ::…:: kept", () => {
  const table = n("table", {
    columns: ["p{3cm}", "c"], rules: "grid",
    rows: [
      [[], [text("a | b")]],
      [[n("math", { tex: "|x|" }), text(" mehr")], [n("points", { value: 2 }), n("bold", {}, [text("x|y")])]],
      [[n("hint", {}, [text("p | q")])], []],
    ],
  });
  // points in cells count: the exam gets 2
  const md = roundTrip(n("exam", { points: 2 }, [table]));
  assert.equal(md, [
    ':::table columns=["p{3cm}","c"] rules=grid',
    "|  | a \\| b |",
    "| $|x|$ mehr | ::points 2::**x\\|y** |",
    "| ::hint | p \\| q:: |  |",
    ":::",
    "",
  ].join("\n"));

  // written by hand: spaces around the cells do not matter, blank lines are skipped
  const { doc, errors } = parseMarkdown(":::table columns=[\"l\",\"r\"]\n|a|  $1$ |\n\n| b | c |\nkeine Zeile\n:::\n");
  assert.deepEqual(errors, [{ line: 5, message: "a table row starts and ends with |" }]);
  assert.deepEqual(doc.children[0].args.rows, [[[text("a")], [n("math", { tex: "1" })]], [[text("b")], [text("c")]]]);
});
