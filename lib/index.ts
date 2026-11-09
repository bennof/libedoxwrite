// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT

// Conversion API. The copied parser and templates remain independent of src/.
// A recoverable error does not prevent output; callers must inspect diagnostics.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compactNode, type Node } from "./edox/node.ts";
import { importTex } from "./edox/import.ts";
import { diagnoseTex, texToExam, texToFlap } from "./edox/parser/texparser.ts";
import { parseMarkdown, toMarkdown } from "./edox/markdown/index.ts";
import { createTexEngine, renderTexTemplate } from "./edox/renderer/rendertemplate.ts";
import type { TemplateError } from "./template/index.ts";

export { compactNode, normalizeNode } from "./edox/node.ts";
export type { Node, NodeJson } from "./edox/node.ts";
export { parseMarkdown, toMarkdown } from "./edox/markdown/index.ts";
export { texToExam, texToFlap } from "./edox/parser/texparser.ts";
export { createTexEngine, renderTexTemplate } from "./edox/renderer/rendertemplate.ts";
export { createHtmlEngine, renderHtmlTemplate } from "./edox/renderer/rendertemplate.ts";
export { renderHtml, renderHtmlDocument, katexOptions, KATEX } from "./edox/renderer/renderhtml.ts";
export { classicScript, companionFiles } from "./edox/html/standalone.ts";

export type Format = "tex" | "json" | "md";
export type Diagnostic = {
  severity: "info" | "warning" | "error";
  stage: "input" | "parse" | "import" | "render" | "roundtrip";
  message: string;
  line?: number;
  column?: number;
  template?: string;
  path?: string;
};
export type ConvertOptions = {
  from: Format;
  to: Format;
  /** Document format, e.g. exam_q-phase (without .tex). */
  format?: string;
  /** Explicit output template, e.g. base.tex. */
  template?: string;
};
export type ConverterOptions = {
  /** Directory of additional or replacement templates, recursively loaded by relative path. */
  templateDirectory?: string;
};
export type ConvertResult = {
  output: string;
  doc: Node;
  diagnostics: Diagnostic[];
  /** False on errors, even when usable output is available. Warnings do not fail. */
  ok: boolean;
};

/** Read the bundled templates or a replacement directory. No templates in src/ are used. */
export function loadTexTemplates(directory = fileURLToPath(new URL("./edox/templates/tex/", import.meta.url))): Record<string, string> {
  const sources: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".tex")) sources[relative(directory, path).split("\\").join("/")] = readFileSync(path, "utf8");
    }
  };
  walk(directory);
  return sources;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const object = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x);

/** Preserve unreadable input verbatim in metadata and as readable body text. */
function recovery(source: string, format: Format): Node {
  return {
    type: "exam", args: { recoverySource: { format, source } },
    children: [{ type: "paragraph", args: {}, children: [{ type: "text", args: { value: source }, children: [] }] }],
  };
}

/** Basic shape validation, deliberately not a restrictive whitelist of node types. */
function readNode(value: unknown, diagnostics: Diagnostic[], path = "$", depth = 0): Node {
  if (depth > 128) throw new Error(`${path}: document nesting exceeds 128`);
  if (!object(value) || typeof value.type !== "string" || !value.type) {
    diagnostics.push({ severity: "error", stage: "parse", path, message: "expected a node with a nonempty string type; retained as text" });
    return { type: "text", args: { value: JSON.stringify(value) ?? "" }, children: [] };
  }
  const args = object(value.args) ? { ...value.args } : {};
  if (value.args !== undefined && !object(value.args)) diagnostics.push({ severity: "error", stage: "parse", path, message: "args must be an object; original value retained in recoveryArgs" });
  if (value.args !== undefined && !object(value.args)) args.recoveryArgs = value.args;
  let children: Node[] = [];
  if (Array.isArray(value.children)) children = value.children.map((n, i) => readNode(n, diagnostics, `${path}.children[${i}]`, depth + 1));
  else if (value.children !== undefined) {
    diagnostics.push({ severity: "error", stage: "parse", path, message: "children must be an array; original value retained in recoveryChildren" });
    args.recoveryChildren = value.children;
  }
  for (const key of Object.keys(value)) if (!["type", "args", "children"].includes(key)) {
    diagnostics.push({ severity: "warning", stage: "parse", path, message: `extra node property ${key} moved to args.recoveryProperties` });
    args.recoveryProperties = { ...args.recoveryProperties, [key]: value[key] };
  }
  if (value.type === "table" && Array.isArray(args.rows)) {
    args.rows = args.rows.map((row: unknown, r: number) => {
      if (!Array.isArray(row)) throw new Error(`${path}.args.rows[${r}]: expected an array`);
      return row.map((cell: unknown, c: number) => {
        if (!Array.isArray(cell)) throw new Error(`${path}.args.rows[${r}][${c}]: expected an array`);
        return cell.map((n, i) => readNode(n, diagnostics, `${path}.args.rows[${r}][${c}][${i}]`, depth + 1));
      });
    });
  }
  return { type: value.type, args, children };
}

/** Create once, convert many documents. User templates override bundled templates. */
export function createConverter(
  templates: Record<string, string> = {},
  options: ConverterOptions = {},
) {
  const directoryTemplates = options.templateDirectory ? loadTexTemplates(options.templateDirectory) : {};
  const { engine, errors: templateErrors } = createTexEngine({
    ...loadTexTemplates(),
    ...directoryTemplates,
    ...templates,
  });
  return {
    convert(source: string, options: ConvertOptions): ConvertResult {
      const diagnostics: Diagnostic[] = [];
      const reportTemplates = (errors: TemplateError[]) => diagnostics.push(...errors.map((e): Diagnostic => ({
        severity: e.type, stage: "render", message: e.message, template: e.template, line: e.pos.line, column: e.pos.column,
      })));
      let doc: Node;
      try {
        if (options.from === "tex") {
          diagnostics.push(...diagnoseTex(source).map((e): Diagnostic => ({ severity: "error", stage: "parse", ...e })));
          try {
            const result = importTex(source, engine, { format: options.format });
            doc = result.doc;
            diagnostics.push(...result.notes.map((m): Diagnostic => ({ severity: "warning", stage: "import", message: m })));
            diagnostics.push(...result.warnings.map((m): Diagnostic => ({ severity: "warning", stage: "import", message: m })));
            for (const [command, count] of Object.entries(result.raw)) diagnostics.push({ severity: "info", stage: "import", message: `raw TeX retained: ${command} (${count})` });
          } catch (error) {
            diagnostics.push({ severity: "error", stage: "import", message: message(error) });
            // Import checking may fail even though the underlying parser can recover a tree.
            doc = /\\begin\{flap\}/.test(source) ? texToFlap(source) : texToExam(source);
          }
        } else if (options.from === "md") {
          const parsed = parseMarkdown(source);
          doc = parsed.doc;
          diagnostics.push(...parsed.errors.map((e): Diagnostic => ({ severity: "error", stage: "parse", ...e })));
        } else if (options.from === "json") {
          doc = readNode(JSON.parse(source), diagnostics);
          if (doc.type !== "exam") {
            diagnostics.push({ severity: "warning", stage: "parse", message: "root is not exam; wrapped in an exam document" });
            doc = { type: "exam", args: {}, children: [doc] };
          }
        } else throw new Error(`unsupported input format: ${options.from}`);
      } catch (error) {
        diagnostics.push({ severity: "error", stage: "parse", message: `${message(error)}; original input retained in args.recoverySource` });
        doc = recovery(source, options.from);
      }
      if (options.format) doc.args.format = options.format;
      let output: string;
      try {
        if (options.to === "json") output = JSON.stringify(compactNode(doc), null, 2) + "\n";
        else if (options.to === "md") {
          output = toMarkdown(doc);
          const back = parseMarkdown(output);
          if (back.errors.length || !isDeepStrictEqual(compactNode(back.doc), compactNode(doc))) {
            diagnostics.push({ severity: "warning", stage: "roundtrip", message: "JSON → Markdown → JSON changes the tree (including derived points); inspect the output before replacing the original" });
          }
        } else if (options.to === "tex") {
          reportTemplates(templateErrors);
          const rendered = renderTexTemplate(doc, engine, options.template);
          reportTemplates(rendered.errors);
          output = rendered.output;
          if (!output.trim()) {
            diagnostics.push({ severity: "error", stage: "render", message: "selected template produced no output; retrying with base.tex" });
            const fallback = renderTexTemplate(doc, engine, "base.tex");
            reportTemplates(fallback.errors);
            output = fallback.output;
          }
        } else throw new Error(`unsupported output format: ${options.to}`);
      } catch (error) {
        diagnostics.push({ severity: "error", stage: "render", message: message(error) });
        output = "";
      }
      if (!output.trim()) {
        diagnostics.push({ severity: "error", stage: "render", message: "no rendered output available; returning source text (not necessarily valid target syntax)" });
        output = source || "% empty input\n";
      }
      return { output, doc, diagnostics, ok: !diagnostics.some((e) => e.severity === "error") };
    },
  };
}

/** Convenience API; use createConverter for repeated conversions. */
export function convert(source: string, options: ConvertOptions): ConvertResult {
  return createConverter().convert(source, options);
}
