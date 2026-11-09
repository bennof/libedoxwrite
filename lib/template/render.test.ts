// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT

// node --test src/shared/template/render.test.ts
// The tokenizer is not written yet; the templates here are built from tokens by hand.
import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeHtml } from "./defaults.ts";
import { hasError, hasWarning, TemplateEngine, type Template, type TemplateConfig } from "./index.ts";

type Token = Template["tokens"][number];
type Expression = Extract<Token, { type: "output" }>["expression"];

let line = 0;
const pos = () => ({ line: ++line, column: 1 });

// Expressions
const lit = (value: string | number | boolean | null): Expression => ({ type: "literal", value, pos: pos() });
const path = (p: string): Expression => ({ type: "path", path: p.split("."), pos: pos() });
const bin = (operator: Extract<Expression, { type: "binary" }>["operator"], left: Expression, right: Expression): Expression =>
  ({ type: "binary", operator, left, right, pos: pos() });
const not = (operand: Expression): Expression => ({ type: "unary", operator: "not", operand, pos: pos() });
const filter = (input: Expression, name: string, args: Record<string, Expression> = {}): Expression =>
  ({ type: "filter", name, input, args, pos: pos() });
const call = (name: string, args: Record<string, Expression> = {}): Expression => ({ type: "call", name, args, pos: pos() });

// Tokens
const text = (value: string): Token => ({ type: "text", value, pos: pos() });
const out = (expression: Expression): Token => ({ type: "output", expression, pos: pos() });
const $if = (test: Expression): Token => ({ type: "if", test, pos: pos() });
const $elif = (test: Expression): Token => ({ type: "elif", test, pos: pos() });
const $else = (): Token => ({ type: "else", pos: pos() });
const endif = (): Token => ({ type: "endif", pos: pos() });
const $for = (value: string, iterable: Expression, key?: string): Token => ({ type: "for", key, value, iterable, pos: pos() });
const endfor = (): Token => ({ type: "endfor", pos: pos() });
const set = (name: string, value: Expression): Token => ({ type: "set", name, value, pos: pos() });
const include = (name: string): Token => ({ type: "include", name, pos: pos() });
const $extends = (name: string): Token => ({ type: "extends", name, pos: pos() });
const block = (name: string): Token => ({ type: "block", name, pos: pos() });
const endblock = (): Token => ({ type: "endblock", pos: pos() });

function engine(templates: Record<string, Token[]>, config: TemplateConfig = {}) {
  return new TemplateEngine({
    ...config,
    templates: Object.fromEntries(
      Object.entries(templates).map(([name, tokens]) => [name, { name, source: "", tokens, components: [] }]),
    ),
  });
}

const render = (e: TemplateEngine, name: string, context: Record<string, unknown> = {}) => e.render(name, context);
const messages = (r: { errors: { message: string }[] }) => r.errors.map((err) => err.message);

test("text, output, filters, functions", () => {
  const e = engine({
    t: [
      text("Hallo "), out(path("name")), text(", "),
      out(filter(path("points"), "number", { decimals: lit(1) })), text(" P, "),
      out(filter(call("range", { end: lit(3) }), "join", { sep: lit("-") })),
    ],
  });
  const r = render(e, "t", { name: "Ayşe", points: 1.5 });
  assert.equal(r.output, "Hallo Ayşe, 1,5 P, 0-1-2");
  assert.deepEqual(r.errors, []);
});

test("lookup order: set, context, globals; only own properties", () => {
  const e = engine(
    { t: [out(path("a")), out(path("b")), set("a", lit("S")), out(path("a")), out(path("o.constructor"))] },
    { globals: { a: "G", b: "g" } },
  );
  const r = render(e, "t", { a: "C", o: {} });
  assert.equal(r.output, "CgS");
  assert.deepEqual(messages(r), ["o.constructor is undefined"]);
});

test("if, elif, else, nested", () => {
  const tokens = [
    $if(bin(">", path("n"), lit(2))), text("big"),
      $if(path("x")), text("+x"), $else(), text("-x"), endif(),
    $elif(bin("==", path("n"), lit(2))), text("two"),
    $else(), text("small"),
    endif(), text("."),
  ];
  const e = engine({ t: tokens });
  assert.equal(render(e, "t", { n: 3, x: true }).output, "big+x.");
  assert.equal(render(e, "t", { n: 3 }).output, "big-x.");
  assert.equal(render(e, "t", { n: 2 }).output, "two.");
  assert.equal(render(e, "t", { n: 1 }).output, "small.");
});

test("truthiness as in Tera", () => {
  const e = engine({ t: [$if(path("v")), text("y"), $else(), text("n"), endif()] });
  for (const v of [false, 0, "", null, undefined, [], {}]) assert.equal(render(e, "t", { v }).output, "n", String(v));
  for (const v of [true, 1, "a", [0], { a: 0 }, new Date()]) assert.equal(render(e, "t", { v }).output, "y", String(v));
});

test("for with loop variables, key, else, nesting and set scope", () => {
  const e = engine({
    list: [
      $for("x", path("items")),
        out(path("loop.index")), text(":"), out(path("x")),
        $if(not(path("loop.last"))), text(","), endif(),
        set("inner", lit(1)),
      $else(), text("leer"),
      endfor(),
      out(filter(path("inner"), "default", { value: lit("-") })),
    ],
    obj: [$for("v", path("o"), "k"), out(path("k")), text("="), out(path("v")), text(";"), endfor()],
    nested: [$for("r", path("rows")), $for("c", path("r")), out(path("c")), endfor(), text("|"), endfor()],
  });
  assert.equal(render(e, "list", { items: ["a", "b", "c"] }).output, "1:a,2:b,3:c-");
  assert.equal(render(e, "list", { items: [] }).output, "leer-");
  assert.equal(render(e, "obj", { o: { a: 1, b: 2 } }).output, "a=1;b=2;");
  assert.equal(render(e, "nested", { rows: [[1, 2], [3]] }).output, "12|3|");
});

test("include sees the variables, its set does not leak", () => {
  const e = engine({
    main: [$for("x", path("xs")), include("item"), endfor(), out(filter(path("y"), "default", { value: lit("-") }))],
    item: [text("["), out(path("x")), text("]"), set("y", lit("leak"))],
  });
  assert.equal(render(e, "main", { xs: [1, 2] }).output, "[1][2]-");
});

test("extends and block over two levels", () => {
  const e = engine({
    base: [text("<"), block("head"), text("H"), endblock(), text("|"), block("body"), text("B"), endblock(), text(">")],
    page: [text("\n"), $extends("base"), block("body"), text("P"), block("inner"), text("i"), endblock(), endblock(), text("ignored")],
    special: [$extends("page"), block("inner"), text("I"), endblock()],
  });
  assert.equal(render(e, "base").output, "<H|B>");
  assert.equal(render(e, "page").output, "<H|Pi>");
  assert.equal(render(e, "special").output, "<H|PI>");
});

test("escaping: only output, not text; safe filters are not escaped", () => {
  const e = engine(
    { t: [text("<b>"), out(path("v")), text("</b> "), out(filter(path("v"), "safe")), out(filter(path("v"), "upper"))] },
    { escape: escapeHtml },
  );
  assert.equal(render(e, "t", { v: "<i>" }).output, "<b>&lt;i&gt;</b> <i>&lt;I&gt;");
});

test("errors: listed, the element gives no output, rendering goes on", () => {
  const e = engine({
    t: [
      text("a"), out(path("missing")),
      text("b"), out(filter(path("v"), "nope")),
      text("c"), out(call("error", { message: lit("Aufgabe fehlt") })),
      text("d"), $if(filter(path("v"), "nope")), text("X"), endif(),
      text("e"), $for("x", path("v")), text("Y"), endfor(),
      text("f"), include("gone"),
      text("g"), out(path("list")),
      text("h"), out(bin("/", lit(1), lit(0))),
      text("i"), endif(),
      text("j"),
    ],
  });
  const r = render(e, "t", { v: 3, list: [1] });
  assert.equal(r.output, "abcdefghij");
  assert.deepEqual(messages(r), [
    "missing is undefined",
    "unknown filter nope",
    "Aufgabe fehlt",
    "unknown filter nope",
    "v: cannot loop over number",
    "unknown template gone",
    "cannot output array; use a filter like join or json",
    "/: division by zero",
    "endif without if",
  ]);
  assert.ok(hasError(r.errors) && hasWarning(r.errors));
  assert.equal(r.errors[0].template, "t");
  assert.equal(render(e, "nothing").errors[0].message, "unknown template nothing");
});

test("structure errors: missing endif and endfor, extends loop, too deep", () => {
  const e = engine(
    {
      noendif: [$if(lit(true)), text("a")],
      noendfor: [text("a"), $for("x", path("xs")), text("b")],
      loopA: [$extends("loopB")],
      loopB: [$extends("loopA")],
      self: [text("."), include("self")],
    },
    { maxDepth: 5 },
  );
  assert.deepEqual(messages(render(e, "noendif")), ["missing endif"]);
  assert.deepEqual(messages(render(e, "noendfor", { xs: [1] })), ["missing endfor"]);
  assert.deepEqual(messages(render(e, "loopA")), ["extends loop"]);
  const deep = render(e, "self");
  assert.equal(deep.output, ".....");
  assert.deepEqual(messages(deep), ["stack deeper than 5"]);
});

test("no errors means hasError and hasWarning are false", () => {
  const r = render(engine({ t: [text("x")] }), "t");
  assert.ok(!hasError(r.errors) && !hasWarning(r.errors));
});
