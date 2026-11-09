// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT

// node --test src/shared/template/defaults.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultFilters as f, defaultFunctions as fn, escapeHtml, escapeTex, htmlFilters, texFilters } from "./defaults.ts";

test("safe and default", () => {
  assert.equal(f.safe.safe, true);
  assert.equal(f.safe(null, {}), "");
  assert.equal(f.default(undefined, { value: "x" }), "x");
  assert.equal(f.default(null, { value: "x" }), "x");
  assert.equal(f.default("", { value: "x" }), "");
  assert.equal(f.default(0, { value: 1 }), 0);
});

test("lists", () => {
  assert.equal(f.length([1, 2], {}), 2);
  assert.equal(f.length("äb", {}), 2);
  assert.equal(f.length({ a: 1 }, {}), 1);
  assert.throws(() => f.length(3, {}), /length: expected/);
  assert.equal(f.first([1, 2], {}), 1);
  assert.equal(f.last([1, 2], {}), 2);
  assert.equal(f.first([], {}), undefined);
  assert.equal(f.join([1, null, "a"], { sep: ", " }), "1, , a");
  assert.deepEqual(f.reverse([1, 2], {}), [2, 1]);
  assert.equal(f.reverse("abc", {}), "cba");
  assert.deepEqual(f.sort(["Zoe", "Ärger", "Anna"], {}), ["Anna", "Ärger", "Zoe"]);
  assert.deepEqual(f.sort(["a10", "a2"], {}), ["a2", "a10"]);
  assert.deepEqual(f.sort([{ n: 2 }, { n: 1 }], { attribute: "n" }), [{ n: 1 }, { n: 2 }]);
  assert.throws(() => f.sort([1, "a"], {}), /cannot compare/);
  assert.deepEqual(f.slice([1, 2, 3, 4], { start: 1, end: -1 }), [2, 3]);
  assert.equal(f.slice("abcd", { end: 2 }), "ab");
  const nodes = [
    { type: "exercise", args: { points: 3 } },
    { type: "text", args: {} },
    { type: "exercise", args: { points: 2 } },
  ];
  assert.deepEqual(f.map(nodes, { attribute: "args.points" }), [3, undefined, 2]);
  assert.equal((f.filter(nodes, { attribute: "type", value: "exercise" }) as unknown[]).length, 2);
  assert.equal((f.filter(nodes, { attribute: "args.points" }) as unknown[]).length, 2);
  assert.equal(f.get({ a: 1 }, { key: "a" }), 1);
  assert.equal(f.get({ a: 1 }, { key: "b", default: 0 }), 0);
  assert.throws(() => f.get({ a: 1 }, { key: "b" }), /no key "b"/);
});

test("text", () => {
  assert.equal(f.lower("ÄBC", {}), "äbc");
  assert.equal(f.upper("straße", {}), "STRASSE");
  assert.equal(f.capitalize("hALLO wELT", {}), "Hallo welt");
  assert.equal(f.title("über die brücke (zweiter teil)", {}), "Über Die Brücke (Zweiter Teil)");
  assert.equal(f.trim("  a \n", {}), "a");
  assert.equal(f.replace("a-b-c", { from: "-", to: "+" }), "a+b+c");
  assert.deepEqual(f.split("a,b", { pat: "," }), ["a", "b"]);
  assert.equal(f.truncate("abcdef", { length: 3 }), "abc…");
  assert.equal(f.truncate("abc", { length: 3 }), "abc");
  assert.equal(f.truncate("abcdef", { length: 2, end: "" }), "ab");
  assert.throws(() => f.lower(null, {}), /lower: expected a string, got null/);
});

test("numbers", () => {
  assert.equal(f.abs(-2, {}), 2);
  assert.equal(f.round(2.345, { precision: 2 }), 2.35);
  assert.equal(f.round(2.1, { method: "ceil" }), 3);
  assert.equal(f.round(2.9, { method: "floor" }), 2);
  assert.throws(() => f.round(1, { method: "x" }), /unknown method/);
  assert.equal(f.int("12", {}), 12);
  assert.equal(f.int(3.7, {}), 3);
  assert.equal(f.int("x", { default: 0 }), 0);
  assert.throws(() => f.int("x", {}), /int: not a number/);
  assert.equal(f.float("1,5", {}), 1.5);
  assert.equal(f.float("", { default: 0 }), 0);
  assert.equal(f.number(1.5, {}), "1,5");
  assert.equal(f.number(1234.5, { decimals: 2 }), "1.234,50");
  assert.equal(f.number(2, { decimals: 1 }), "2,0");
});

test("json and date", () => {
  assert.equal(f.json({ a: [1, "ä"] }, {}), '{"a":[1,"ä"]}');
  assert.equal(f.json(undefined, {}), "null");
  assert.equal(f.json({ a: 1 }, { pretty: true }), '{\n  "a": 1\n}');
  assert.equal(f.date("2026-10-21T12:00:00", {}), "21.10.2026");
  assert.equal(f.date(new Date(2026, 9, 21), { format: "short" }), "21.10.26");
  assert.equal(f.date(new Date(2026, 9, 21, 14, 5), { time: "short" }), "21.10.2026, 14:05");
  assert.throws(() => f.date("kein Datum", {}), /date: not a date/);
  assert.throws(() => f.date(new Date(), { format: "x" }), /expected full, long/);
});

test("functions", () => {
  assert.deepEqual(fn.range({ end: 3 }), [0, 1, 2]);
  assert.deepEqual(fn.range({ start: 1, end: 4 }), [1, 2, 3]);
  assert.deepEqual(fn.range({ start: 5, end: 0, step: -2 }), [5, 3, 1]);
  assert.deepEqual(fn.range({ start: 3, end: 1 }), []);
  assert.throws(() => fn.range({}), /missing argument end/);
  assert.throws(() => fn.range({ end: 3, step: 0 }), /step must not be 0/);
  assert.throws(() => fn.range({ end: 1e9 }), /more than/);
  assert.ok(!Number.isNaN(Date.parse(fn.now({}) as string)));
  assert.throws(() => fn.error({ message: "Aufgabe fehlt" }), /^Error: Aufgabe fehlt$/);
});

test("html and tex", () => {
  assert.equal(escapeHtml(`<a href="x">Ä & 'b'</a>`), "&lt;a href=&quot;x&quot;&gt;Ä &amp; &#39;b&#39;&lt;/a&gt;");
  assert.equal(htmlFilters.escape.safe, true);
  assert.equal(htmlFilters.striptags("<b>fett</b><!-- weg --> &amp; gut", {}), "fett &amp; gut");
  assert.equal(escapeTex("50 % & #1 a_b $x^2$ \\textbf{y}"), "50 \\% \\& \\#1 a\\_b $x^2$ \\textbf{y}");
  assert.equal(texFilters.tex.safe, true);
  assert.equal(texFilters.tex(null, {}), "");
});
