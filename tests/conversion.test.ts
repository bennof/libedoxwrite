import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createConverter, compactNode, normalizeNode } from "../lib/index.ts";

const converter = createConverter();
const source = String.raw`\documentclass{edoxarticle}
\begin{document}
\begin{exam}{Beispiel}
\exercise[Rechnen]{\subexercise{$1+1$\solve{$2$\pp[2]}}}
\end{exam}
\end{document}`;
const convert = converter.convert;

test("all conversion directions retain the document tree", () => {
  const json = convert(source, { from: "tex", to: "json" });
  assert.equal(json.ok, true);
  const md = convert(source, { from: "tex", to: "md" });
  assert.equal(md.ok, true);
  assert.deepEqual(convert(md.output, { from: "md", to: "json" }).doc, json.doc);
  for (const [from, input] of [["json", json.output], ["md", md.output]] as const) {
    const tex = convert(input, { from, to: "tex" });
    assert.equal(tex.ok, true);
    assert.deepEqual(convert(tex.output, { from: "tex", to: "json" }).doc, json.doc);
  }
});

test("preamble loss and multiple documents are reported", () => {
  const result = convert(String.raw`\renewcommand\sign{Name}` + source + source, { from: "tex", to: "json" });
  assert.ok(result.output.length);
  assert.ok(result.diagnostics.some(d => d.message.includes("preamble line not kept")));
  assert.ok(result.diagnostics.some(d => d.message.includes("only the first")));
});

test("malformed TeX produces a tree and positioned diagnostics", () => {
  const result = convert(String.raw`\begin{exam}{Title}\exercise{Text $x`, { from: "tex", to: "json" });
  assert.equal(result.ok, false);
  assert.equal(JSON.parse(result.output).type, "exam");
  assert.ok(result.diagnostics.some(d => d.line && d.message.includes("missing closing $")));
  assert.ok(result.diagnostics.some(d => d.message.includes("missing closing }")));
});

test("unrecognized TeX and invalid JSON preserve the original source", () => {
  for (const [from, input] of [["tex", "plain source without exam"], ["json", '{"broken":']] as const) {
    const result = convert(input, { from, to: "json" });
    assert.equal(result.ok, false);
    assert.equal(JSON.parse(result.output).args.recoverySource.source, input);
  }
});

test("Markdown recovery retains valid preceding content", () => {
  const result = convert(":::exercise title=Example\nText with $unclosed", { from: "md", to: "tex" });
  assert.equal(result.ok, false);
  assert.match(result.output, /Text with/);
  assert.ok(result.diagnostics.some(d => d.stage === "parse" && d.line));
});

test("invalid JSON node shape is reported without discarding valid siblings", () => {
  const result = convert(JSON.stringify({ type: "exam", children: [null, { type: "paragraph", children: [{ type: "text", args: { value: "kept" } }] }] }), { from: "json", to: "tex" });
  assert.equal(result.ok, false);
  assert.match(result.output, /kept/);
  assert.ok(result.diagnostics.some(d => d.path === "$.children[0]"));
});

test("unknown template falls back and broken components keep partial output", () => {
  const json = convert(source, { from: "tex", to: "json" }).output;
  const result = convert(json, { from: "json", to: "tex", template: "missing.tex" });
  assert.equal(result.ok, false);
  assert.match(result.output, /\\begin\{exam\}/);
  const custom = createConverter({ "broken.tex": "before << missing >> after" });
  const partial = custom.convert(json, { from: "json", to: "tex", template: "broken.tex" });
  assert.equal(partial.ok, false);
  assert.match(partial.output, /before.*after/);
  assert.ok(partial.diagnostics.some(d => d.template === "broken.tex"));
});

test("custom template directory overrides bundled templates and missing files fall back", () => {
  const dir = mkdtempSync(join(tmpdir(), "edox-templates-"));
  try {
    mkdirSync(join(dir, "components"), { recursive: true });
    writeFileSync(join(dir, "custom.tex"), "custom template");
    const converter = createConverter({}, { templateDirectory: dir });
    const json = convert(source, { from: "tex", to: "json" }).output;
    const custom = converter.convert(json, { from: "json", to: "tex", template: "custom.tex" });
    assert.equal(custom.ok, true);
    assert.equal(custom.output, "custom template");
    const fallback = converter.convert(json, { from: "json", to: "tex" });
    assert.equal(fallback.ok, true);
    assert.match(fallback.output, /\\begin\{exam\}/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI keeps stdout clean, writes a report and exits nonzero after output on error", () => {
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "edox-convert-"));
  try {
    const report = join(dir, "diagnostics.json");
    const run = spawnSync(process.execPath, ["--import=tsx", cli, "md-to-tex", "-", "--diagnostics", report], { input: ":::exercise\nHello $x", encoding: "utf8" });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stdout, /\\begin\{exam\}/);
    assert.match(run.stderr, /error: parse/);
    assert.equal(JSON.parse(readFileSync(report, "utf8")).ok, false);
    const good = spawnSync(process.execPath, ["--import=tsx", cli, "tex-to-json", "-"], { input: source, encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).type, "exam");
    const bad = spawnSync(process.execPath, ["--import=tsx", cli, "-", "--to", "json"], { input: source, encoding: "utf8" });
    assert.equal(bad.status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Optional integration against the existing local corpus; the library never loads it.
const corpus = fileURLToPath(new URL("../../test/", import.meta.url));
for (const file of (existsSync(corpus) ? readdirSync(corpus) : []).filter(f => f.endsWith(".tex"))) {
  test(`corpus: ${file} → JSON/MD → TeX`, () => {
    const tex = readFileSync(join(corpus, file), "utf8");
    const expected = normalizeNode(JSON.parse(readFileSync(join(corpus, file.replace(/tex$/, "json")), "utf8")));
    const result = convert(tex, { from: "tex", to: "json" });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(compactNode(result.doc), compactNode(expected));
    const md = convert(result.output, { from: "json", to: "md" });
    assert.equal(md.ok, true, JSON.stringify(md.diagnostics));
    assert.deepEqual(convert(md.output, { from: "md", to: "json" }).doc, expected);
    for (const [from, input] of [["md", md.output], ["json", result.output]] as const) {
      const rendered = convert(input, { from, to: "tex" });
      assert.equal(rendered.ok, true, JSON.stringify(rendered.diagnostics));
      assert.ok(rendered.output.includes("\\begin{"));
    }
  });
}
