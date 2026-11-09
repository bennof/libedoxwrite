// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT

/*
 * Generic JSON tree (see ../parser/texparser.ts) -> LaTeX, with templates.
 *
 * The TeX lives in templates (../templates/tex/):
 * base.tex renders the exam, components/<type>.tex one component per node type.
 * This file only provides what templates cannot decide themselves: which component
 * renders a node, the separators between blocks, the achievable points and the
 * joining of TeX snippets.
 */

import { tableLayout, tableSpec } from "../table.ts";
import { defaultFilters, escapeHtml } from "../../template/defaults.ts";
import { componentCall, TemplateEngine, type RenderResult, type TemplateError } from "../../template/index.ts";
import type { Node } from "../node.ts";
import { defaultPar, escapeTex, maxPoints } from "../tex.ts";
import { assignFieldNames, exerciseNumber, fieldNames, gradeScale, KATEX, katexOptions, taskLabel, vars } from "./renderhtml.ts";

/** Component for node types without one of their own: `\name[opt]{children}`. */
const FALLBACK = "components.command";

/** Line break or blank line (= \par) between two sibling blocks. */
function separator(a: Node, b: Node): string {
  return defaultPar(a, b) ? "\n\n" : "\n";
}

/**
 * Glue between two inline snippets: a control word must
 * not swallow a following letter, nor take a following [ or * as its argument.
 */
export function texGlue(before: string, after: string): string {
  if (!/\\[A-Za-z@]+$/.test(before)) return "";
  if (/^[A-Za-z@]/.test(after)) return " ";
  if (/^[\[*]/.test(after)) return "{}";
  return "";
}

/**
 * A TeX engine for edox templates: delimiters `<` `>` (`<< … >>`, `<% … %>`,
 * `<# … #>`), no automatic escaping (node arguments are TeX); plain text gets the
 * filter `text`. Returns the errors of the templates, too.
 */
export function createTexEngine(templates: Record<string, string>): { engine: TemplateEngine; errors: TemplateError[] } {
  const engine = new TemplateEngine({
    openDelimiter: "<",
    closeDelimiter: ">",
    filters: {
      ...defaultFilters,
      /** Plain text → TeX, all special characters escaped. */
      text: (value) => escapeTex(value === undefined || value === null ? "" : String(value)),
    },
    glue: texGlue,
  });

  /** `<< render(node=c) >>`: the component for the node's type. */
  engine.addFunction("render", ({ node }) => {
    const name = `components.${(node as Node).type}`;
    return componentCall(engine.hasComponent(name) ? name : FALLBACK, { node });
  });

  /**
   * Blocks with their separators: `[{ node, sep }]`. `sep` of the first block is
   * empty, or, with `prev` (a node type), the separator after such a node.
   */
  engine.addFunction("blocks", ({ nodes, prev }) =>
    (nodes as Node[]).map((node, i, all) => ({
      node,
      sep: i > 0 ? separator(all[i - 1], node)
        : prev ? separator({ type: String(prev), args: {}, children: [] }, node)
        : "",
    })),
  );

  engine.addFunction("maxPoints", ({ node }) => maxPoints(node as Node));
  /** tables: column spec and rows with their cells (src/shared/edox/table.ts) */
  engine.addFunction("tableSpec", ({ args }) => tableSpec(args as Record<string, any>));
  engine.addFunction("tableLayout", ({ args }) => tableLayout(args as Record<string, any>));

  const errors: TemplateError[] = [];
  for (const [name, source] of Object.entries(templates)) errors.push(...engine.addTemplate(name, source));
  return { engine, errors };
}

/**
 * Renders the document `doc`. The template is `template`, else the format named in the
 * root node (`args.format: "exam_ef"` → exam_ef.tex), else worksheet.tex for worksheets
 * and tests, flap.tex for flaps (`args.kind`), else base.tex.
 */
export function renderTexTemplate(doc: Node, engine: TemplateEngine, template?: string): RenderResult {
  const name =
    template ??
    (doc.args.format ? `${doc.args.format}.tex`
    : doc.args.kind === "worksheet" || doc.args.kind === "test" ? "worksheet.tex"
    : doc.args.kind === "flap" ? "flap.tex"
    : "base.tex");
  return engine.render(name, { node: doc });
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/**
 * An HTML engine for edox templates (../templates/html/): delimiters `{` `}`, the
 * output of `{{ … }}` is HTML-escaped. Returns the errors of the templates, too.
 */
export function createHtmlEngine(templates: Record<string, string>): { engine: TemplateEngine; errors: TemplateError[] } {
  const engine = new TemplateEngine({ escape: escapeHtml });

  /** `{{ render(node=c) }}`: the component for the node's type. */
  engine.addFunction("render", ({ node }) => {
    const name = `components.${(node as Node).type}`;
    return componentCall(engine.hasComponent(name) ? name : FALLBACK, { node });
  });
  /** PDF form field names of a points node: one per checkbox, or one text field. */
  engine.addFunction("fieldNames", ({ node }) => {
    const names = fieldNames(node as Node);
    if (names.length) return names;
    // outside an exercise: fields without names, as many as there would be
    const v = (node as Node).args.value ?? 1;
    return Array.from({ length: Number.isInteger(v) && v <= 3 ? v : 1 }, () => "");
  });
  /** Label of a subexercise: "a)", "b)" … per exercise (starred ones count too). */
  engine.addFunction("taskLabel", ({ node }) => taskLabel(node as Node) ?? null);
  /** Running number of an exercise: Sum-Points-<number>. */
  engine.addFunction("exerciseNumber", ({ node }) => exerciseNumber(node as Node) ?? null);
  /** Grading scale of the exam: { labels, indices, percentages } as comma lists. */
  engine.addFunction("gradeScale", ({ node }) => {
    const g = gradeScale(node as Node);
    return { labels: g["data-grade-labels"], indices: g["data-grade-indices"], percentages: g["data-grade-percentages"] };
  });
  /** style value for lengths from the document: cssVars(width=…) → "--width: …"; null without any. */
  engine.addFunction("cssVars", (args) => vars(args as Record<string, string | undefined>) ?? null);
  engine.addFunction("katexOptions", ({ node }) => katexOptions(node as Node));
  /** rows of a table with their cells (src/shared/edox/table.ts) */
  engine.addFunction("tableLayout", ({ args }) => tableLayout(args as Record<string, any>));
  engine.addGlobal("katexUrl", KATEX);

  const errors: TemplateError[] = [];
  for (const [name, source] of Object.entries(templates)) errors.push(...engine.addTemplate(name, source));
  return { engine, errors };
}

/**
 * Renders the exam `doc` as HTML: base.html (the exam with name field and buttons),
 * app.html (without them) or page.html (standalone page; `stylesheet` and `script`
 * are the files it links).
 */
export function renderHtmlTemplate(
  doc: Node,
  engine: TemplateEngine,
  { template = "base.html", stylesheet = "style.css", script = "grading.js" } = {},
): RenderResult {
  assignFieldNames(doc);
  return engine.render(template, { node: doc, stylesheet, script });
}
