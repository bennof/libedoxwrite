// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT

// node --test src/shared/template/tokenize.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeHtml, texFilters } from "./defaults.ts";
import { componentCall, TemplateEngine, tokenize, type TemplateConfig } from "./index.ts";

/** Renders `source` as template "t"; errors from adding and rendering together. */
function run(source: string, context: Record<string, unknown> = {}, config: TemplateConfig = {}, more: Record<string, string> = {}) {
  const engine = new TemplateEngine(config);
  const errors = [];
  for (const [name, src] of Object.entries(more)) errors.push(...engine.addTemplate(name, src));
  errors.push(...engine.addTemplate("t", source));
  const result = engine.render("t", context);
  errors.push(...result.errors);
  return { output: result.output, errors: errors.map((e) => `${e.pos.line}:${e.pos.column} ${e.message}`) };
}
const out = (source: string, context: Record<string, unknown> = {}, config: TemplateConfig = {}) => {
  const r = run(source, context, config);
  assert.deepEqual(r.errors, [], source);
  return r.output;
};

test("text and output", () => {
  assert.equal(out("Hallo {{ name }}!", { name: "Ayşe" }), "Hallo Ayşe!");
  assert.equal(out("{{name}}", { name: "x" }), "x");
  assert.equal(out("a { b } {x} %}"), "a { b } {x} %}");
});

test("whitespace: collapse spaces, keep newlines and paragraphs", () => {
  assert.equal(out("a  \t b\n     c\n\n\n   d"), "a b\nc\n\nd");
  assert.equal(out("a  b"), "a  b"); // no-break spaces stay
  assert.equal(out("{{ v }}", { v: "x  \n\n\n y" }), "x  \n\n\n y"); // values stay
});

test("whitespace: lines with only statements or comments vanish", () => {
  const source = [
    "<ul>",
    "  {% for x in xs %}",
    "  {# one item #}",
    "  <li>{{ x }}</li>",
    "  {% endfor %}",
    "</ul>",
  ].join("\n");
  assert.equal(out(source, { xs: [1, 2] }), "<ul>\n<li>1</li>\n<li>2</li>\n</ul>");

  // A paragraph around a conditional stays a paragraph.
  assert.equal(out("A\n\n{% if x %}\nB\n{% endif %}\n\nC", { x: true }), "A\n\nB\n\nC");
  // Skipped: the newlines on both sides add up; still one paragraph break for TeX and HTML.
  assert.equal(out("A\n\n{% if x %}\nB\n{% endif %}\n\nC", { x: false }), "A\n\n\nC");
  // Two tags on one line, text on the line: only the first vanishes.
  assert.equal(out("{% if x %}{% if y %}\nboth\n{% endif %}{% endif %}\n", { x: 1, y: 1 }), "both\n");
  assert.equal(out("a {% if x %}b{% endif %}\nc", { x: 1 }), "a b\nc");
});

test("whitespace: trim markers and keep", () => {
  assert.equal(out("a  {%- if true -%}  b  {%- endif %}"), "ab");
  assert.equal(out("[ {{- v -}} ]", { v: 1 }), "[1]");
  assert.equal(out("a  b\n  {% if true %}\n  c\n  {% endif %}\n", {}, { whitespace: "keep" }), "a  b\n  \n  c\n  \n");
});

test("raw and comments", () => {
  assert.equal(out("{% raw %}{{ x }}  {% if %}{% endraw %}!"), "{{ x }}  {% if %}!");
  assert.equal(out("{% raw -%}\n  a  {%- endraw %}"), "a");
  assert.equal(out("a {# {{ nothing }} #}b"), "a b");
});

test("TeX delimiters", () => {
  const config: TemplateConfig = { openDelimiter: "<", closeDelimiter: ">", filters: { ...texFilters } };
  const source = "\\newcommand{\\a}{%\n}\n<% if x %>\n\\textbf{<< x | tex >>} $a<b$\n<% endif %>\n<# Kommentar #>";
  assert.equal(out(source, { x: "a_b & c" }, config), "\\newcommand{\\a}{%\n}\n\\textbf{a\\_b \\& c} $a<b$\n");
});

test("expressions", () => {
  const ctx = { a: true, b: false, xs: [1, 2, 3], items: [{ title: "T" }], o: { "a-b": 5 }, n: null };
  const cases: [string, string][] = [
    ["{{ 1 + 2 * 3 }}", "7"],
    ["{{ (1 + 2) * 3 }}", "9"],
    ["{{ -2 + 5 }}", "3"],
    ["{{ 7 % 4 }} {{ 1.5 * 2 }}", "3 3"],
    ["{{ not a and b }}", "false"],
    ["{{ a or b and b }}", "true"],
    ["{{ 'x' ~ 1 + 1 }}", "x2"],
    ["{{ xs | length > 2 }}", "true"],
    ["{{ 2 in xs }} {{ 5 not in xs }}", "true true"],
    ["{{ items.0.title }} {{ items[0]['title'] }}", "T T"],
    ['{{ o["a-b"] }}', "5"],
    ['{{ n | default(value="-") }}', "-"],
    ['{{ "a\\"b\\n" | trim }}', 'a"b'],
    ["{{ [1, 2] | join(sep=`, `) }}", "1, 2"],
    ["{{ range(start=1, end=4) | join(sep='') }}", "123"],
    ["{{ 1 == 1 }} {{ 'a' != 'b' }} {{ 2 <= 1 }}", "true true false"],
  ];
  for (const [source, expected] of cases) assert.equal(out(source, ctx), expected, source);
});

test("statements: set, for with key, include, extends", () => {
  assert.equal(out("{% set y = x * 2 %}{{ y }}", { x: 4 }), "8");
  assert.equal(out("{% for k, v in o %}{{ k }}={{ v }};{% endfor %}", { o: { a: 1, b: 2 } }), "a=1;b=2;");
  assert.equal(out("{% for x in xs %}{{ x }}{% else %}leer{% endfor %}", { xs: [] }), "leer");
  const r = run(
    '{% extends "base" %}\n{% block body %}\nSeite {{ n }}\n{% endblock body %}\n',
    { n: 1 },
    { escape: escapeHtml },
    { base: '<main>\n{% block body %}{% endblock %}\n</main>\n{% include "foot" %}', foot: "<footer>{{ '<f>' }}</footer>" },
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.output, "<main>\nSeite 1\n</main>\n<footer>&lt;f&gt;</footer>");
});

test("components are collected and give no output where defined", () => {
  const source = [
    "A",
    "{% component ui.img(src: string, alt: string = \"\", width: integer = 800) %}",
    '<img src="{{ src }}">',
    "{% endcomponent ui.img %}",
    "B",
  ].join("\n");
  const { template, errors } = tokenize("t", source);
  assert.deepEqual(errors, []);
  assert.equal(template.components.length, 1);
  const [img] = template.components;
  assert.equal(img.name, "ui.img");
  assert.deepEqual(img.parameters.map((p) => [p.name, p.type, p.default !== undefined]), [
    ["src", "string", false],
    ["alt", "string", true],
    ["width", "integer", true],
  ]);
  assert.equal(img.pos.line, 2);
  assert.equal(out(source), "A\nB");

  const engine = new TemplateEngine();
  engine.addTemplate("a", "{% component x() %}{% endcomponent %}");
  const warnings = engine.addTemplate("b", "\n{% component x() %}{% endcomponent %}");
  assert.deepEqual(warnings.map((w) => [w.type, w.pos.line, w.message]), [
    ["warning", 2, "component x replaces the one from template a"],
  ]);
});

test("parse errors with position; the element is left out", () => {
  assert.deepEqual(run("a\n  {{ 1 + }}b"), { output: "a\nb", errors: ["2:10 expected a value, found end of tag"] });
  // A broken if keeps the nesting: its body is skipped, no stray endif.
  assert.deepEqual(run("{% if 1 + %}x{% endif %}y"), { output: "y", errors: ["1:11 expected a value, found end of tag"] });
  assert.deepEqual(run("{% for x xs %}x{% endfor %}y").output, "y");
  assert.deepEqual(run("{% foo %}a").errors, ["1:4 unknown statement foo"]);
  assert.deepEqual(run("{{ v | default('-') }}").errors, ["1:16 expected name, found -"]);
  assert.deepEqual(run("{{ f(a) }}").errors, ["1:6 argument a needs a name: a=…"]);
  assert.deepEqual(run("{{ 'abc }}").errors, ["1:1 unclosed tag, }} missing"]);
  assert.deepEqual(run("a {{ b").output, "a {{ b");
  assert.deepEqual(run("{{ a.constructor }}", { a: {} }).errors, ["1:1 a.constructor is undefined"]);
  assert.deepEqual(run("{{ x $ }}").errors, ["1:6 unexpected character $"]);
  assert.deepEqual(run("{% set and = 1 %}").errors, ["1:8 and is a keyword"]);
});

test("nesting errors are found while tokenizing", () => {
  const messages = (source: string) => tokenize("t", source).errors.map((e) => e.message);
  assert.deepEqual(messages("{% if x %}a"), ["missing endif"]);
  assert.deepEqual(messages("{% endfor %}"), ["endfor without for"]);
  assert.deepEqual(messages("{% if x %}{% endfor %}{% endif %}"), ["endfor where endif is expected"]);
  assert.deepEqual(messages("{% block a %}{% endblock b %}"), ["endblock b closes block a"]);
  assert.deepEqual(messages("{% if x %}{% else %}{% elif y %}{% endif %}"), ["elif after else"]);
  assert.deepEqual(messages("{% else %}"), ["else without if or for"]);
  assert.deepEqual(messages("{% raw %}{{ x }}"), ["missing endraw"]);
});

test("component calls: arguments, defaults, types, isolation", () => {
  const image = [
    '{% component components.image(src: string, alt: string = "", sizes: string = "100vw", width: integer = 800) %}',
    '<img src="{{ src }}-960w.webp" sizes="{{ sizes }}" alt="{{ alt }}" width="{{ width }}">',
    "{% endcomponent %}",
  ].join("\n");
  const call = (source: string, context: Record<string, unknown> = {}, config: TemplateConfig = {}) =>
    run(source, context, config, { image });

  assert.deepEqual(call('{{ components.image(src="/f") }}'), {
    output: '<img src="/f-960w.webp" sizes="100vw" alt="" width="800">\n',
    errors: [],
  });
  assert.equal(call('{{ components.image(src=s, alt="A & B", width=600) }}', { s: "/g" }, { escape: escapeHtml }).output,
    '<img src="/g-960w.webp" sizes="100vw" alt="A &amp; B" width="600">\n');

  assert.deepEqual(call("a{{ components.image() }}b"), { output: "ab", errors: ["1:2 component components.image: missing argument src"] });
  assert.deepEqual(call('{{ components.image(src=1) }}').errors, ["1:1 component components.image: src must be string, got number"]);
  assert.deepEqual(call('{{ components.image(src="x", width=1.5) }}').errors, ["1:1 component components.image: width must be integer, got number"]);
  assert.deepEqual(call('{{ components.image(src=null) }}').errors, ["1:1 component components.image: src must be string, got null"]);
  const unknown = call('{{ components.image(src="x", title="t") }}');
  assert.equal(unknown.output, '<img src="x-960w.webp" sizes="100vw" alt="" width="800">\n');
  assert.deepEqual(unknown.errors, ["1:1 component components.image has no parameter title; ignored"]);
  assert.deepEqual(call("{{ components.image(src='x') | upper }}").errors, [
    "1:1 component components.image can only be called as a whole tag",
  ]);
  assert.deepEqual(call("{{ nope.thing(a=1) }}").errors, ["1:1 unknown function nope.thing"]);

  // A component sees only its own world: no context, no globals.
  const world = run("{{ c(a=1) }}", { x: "ctx" }, { globals: { g: "glob" } }, {
    c: "{% component c(a, b = a + 1) %}{{ a }}{{ b }}{{ x | default(value='-') }}{{ g | default(value='-') }}{% endcomponent %}",
  });
  assert.deepEqual(world, { output: "12--", errors: [] });
});

test("component calls with a body", () => {
  const box = [
    '{% component ui.box(title: string, level: integer = 1) %}',
    '<div class="box"><h{{ level }}>{{ title }}</h{{ level }}>{{ body }}</div>',
    "{% endcomponent ui.box %}",
  ].join("\n");
  const r = run(
    [
      '{% call ui.box(title="Hinweis") %}',
      "{% for x in xs %}<p>{{ x }}</p>{% endfor %}",
      "{% call ui.box(title=inner, level=2) %}innen{% endcall %}",
      "{% endcall ui.box %}",
      "{{ ui.box(title='leer') }}",
    ].join("\n"),
    { xs: [1, 2], inner: "Innen" },
    {},
    { box },
  );
  assert.deepEqual(r.errors, []);
  assert.equal(
    r.output,
    '<div class="box"><h1>Hinweis</h1><p>1</p><p>2</p>\n' +
      // The component ends with the newline of its definition, then the caller's newline follows.
      '<div class="box"><h2>Innen</h2>innen</div>\n\n</div>\n' +
      '<div class="box"><h1>leer</h1></div>\n',
  );

  assert.deepEqual(tokenize("t", "{% call x() %}").errors.map((e) => e.message), ["missing endcall"]);
  assert.deepEqual(tokenize("t", "{% endcall %}").errors.map((e) => e.message), ["endcall without call"]);
  assert.deepEqual(tokenize("t", "{% component c(a: text) %}{% endcomponent %}").errors.map((e) => e.message), [
    "unknown type text, expected string, integer, number, boolean, array, object, any",
  ]);

  const engine = new TemplateEngine({ maxDepth: 8 });
  engine.addTemplate("r", "{% component r() %}.{{ r() }}{% endcomponent %}");
  engine.addTemplate("t", "{{ r() }}");
  const deep = engine.render("t", {});
  assert.equal(deep.output, ".......");
  assert.deepEqual(deep.errors.map((e) => e.message), ["stack deeper than 8"]);

  engine.addFunction("r", () => "f");
  assert.deepEqual(engine.render("t", {}).errors[0].message, "component r hides the function of the same name");
});

test("super() in blocks", () => {
  const base = '<head>\n{% block head %}\n<link href="/style.css">\n{% endblock %}\n</head>';
  const page = '{% extends "base" %}\n{% block head %}\n{{ super() }}\n<link href="/katex.css">\n{% endblock %}';
  assert.deepEqual(run(page, {}, {}, { base }), {
    output: '<head>\n<link href="/style.css">\n\n<link href="/katex.css">\n</head>',
    errors: [],
  });

  // Three levels: each super() goes one template up, variables of the page are seen.
  const r = run(
    '{% extends "mid" %}{% block b %}[3 {{ super() }} {{ x }}]{% endblock %}',
    { x: "x" },
    {},
    { top: "{% block b %}1{% endblock %}", mid: '{% extends "top" %}{% block b %}[2 {{ super() }}]{% endblock %}' },
  );
  assert.deepEqual(r, { output: "[3 [2 1] x]", errors: [] });

  // A block that only the derived templates define: super() reaches the middle one.
  assert.equal(
    run('{% extends "mid" %}{% block inner %}<{{ super() }}>{% endblock %}', {}, {}, {
      top: "{% block b %}{% endblock %}",
      mid: '{% extends "top" %}{% block b %}{% block inner %}i{% endblock %}{% endblock %}',
    }).output,
    "<i>",
  );

  assert.deepEqual(run("{% block b %}{{ super() }}{% endblock %}").errors, [
    "1:14 super() outside a block of a template that extends another",
  ]);
  assert.deepEqual(run('{% extends "top" %}{% block new %}{{ super() }}{% endblock %}', {}, {}, { top: "t" }), {
    output: "t",
    errors: [],
  });
  assert.deepEqual(
    run('{% extends "top" %}{% block b %}{{ super() | upper }}{% endblock %}', {}, {}, { top: "{% block b %}x{% endblock %}" }).errors,
    ["1:33 super() can only be used as a whole tag"],
  );
});

test("a function chooses the component: componentCall", () => {
  const engine = new TemplateEngine({ openDelimiter: "<", closeDelimiter: ">" });
  engine.addFunction("render", ({ node }) => componentCall(`components.${(node as { type: string }).type}`, { node }));
  const add = (name: string, source: string) => assert.deepEqual(engine.addTemplate(name, source), [], name);
  add("components/exam.tex", "<% component components.exam(node: object) %>[<% for c in node.children %><< render(node=c) >><% endfor %>]<% endcomponent %>");
  add("components/exercise.tex", "<% component components.exercise(node: object) %>A(<< node.args.title >>:<% for c in node.children %><< render(node=c) >><% endfor %>)<% endcomponent %>");
  add("components/text.tex", "<% component components.text(node: object) %><< node.args.value >><% endcomponent %>");
  add("t", "<< render(node=doc) >>");

  const doc = {
    type: "exam",
    children: [
      { type: "exercise", args: { title: "1" }, children: [{ type: "text", args: { value: "x" } }] },
      { type: "nope" },
      { type: "exercise", args: { title: "2" }, children: [] },
    ],
  };
  const r = engine.render("t", { doc });
  assert.equal(r.output, "[A(1:x)A(2:)]");
  assert.deepEqual(r.errors.map((e) => `${e.template} ${e.message}`), ["components/exam.tex unknown component components.nope"]);

  // Only as a whole tag.
  add("filtered", "<< render(node=doc) | default(value='') >>");
  add("stored", "<% set x = render(node=doc) %><< x >>");
  assert.deepEqual(engine.render("filtered", { doc }).errors.map((e) => e.message), [
    "call of component components.exam can only be used as a whole tag",
  ]);
  assert.deepEqual(engine.render("stored", { doc }).errors.map((e) => e.message), [
    "call of component components.exam can only be used as a whole tag",
  ]);
  // The rules of components apply: types are checked.
  assert.deepEqual(engine.render("t", { doc: { type: "text", args: { value: 1 } } }).errors, []);
  engine.addFunction("bad", () => componentCall("components.text", { node: "kein Objekt" }));
  add("bad", "<< bad() >>");
  assert.deepEqual(engine.render("bad", {}).errors.map((e) => e.message), [
    "component components.text: node must be object, got string",
  ]);
});
