// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT

/*
 * Import of existing edoxarticle files (exams, tests, worksheets) into the document model.
 * Beyond texToExam: a cover page that a format template writes itself (the "Vorblatt"
 * of exam_q-phase) is removed and its values become args (timePartA). Every step is
 * checked by rendering the result and parsing it again.
 */
import type { TemplateEngine } from "../template/index.ts";
import { tableCells, type Node } from "./node.ts";
import { texToExam, texToFlap } from "./parser/texparser.ts";
import { renderTexTemplate } from "./renderer/rendertemplate.ts";

export interface ImportResult {
  doc: Node;
  /** what was done or noticed, one line each */
  notes: string[];
  /** problems: the document does not come out as it went in */
  warnings: string[];
  /** first command of each raw block (TeX the model has no node for), with counts */
  raw: Record<string, number>;
}

/** Cover pages of format templates: how to recognize them and which args they take. */
const COVERS: { format: string; marker: RegExp; args(text: string): Record<string, any> }[] = [
  {
    format: "exam_q-phase",
    marker: /\\textbf\{Vorblatt\}/,
    // part B is not on the cover: 55 minutes for now, edited in the document later
    args: (text) => {
      const m = /spätestens (\d+) Minuten/.exec(text);
      return m ? { timePartA: Number(m[1]), timePartB: 55 } : {};
    },
  },
];

/** all text and raw TeX below `nodes`, for searching */
const flatText = (nodes: Node[]): string =>
  nodes.map((n) => `${n.args.value ?? ""}${n.args.tex ?? ""}${flatText(n.children)}`).join(" ");

/** The document in `tex`; throws when it is no exam, test or worksheet. */
export function importTex(tex: string, engine: TemplateEngine, options: { format?: string } = {}): ImportResult {
  if (/\\begin\{flap\}/.test(tex)) return importFlap(tex, engine);
  const ignored: string[] = [];
  let doc = texToExam(tex, ignored);
  const notes = ignored.map((line) => `preamble line not kept: ${line}`);
  const warnings: string[] = [];
  const envs = tex.replace(/(?<!\\)%.*$/gm, "").match(/\\begin\{(exam|test|worksheet)\}/g) ?? [];
  if (envs.length > 1) warnings.push(`file holds ${envs.length} documents, only the first was imported`);

  const first = doc.children.findIndex((n) => n.type === "section");
  const cover = first > 0 ? doc.children.slice(0, first) : [];
  const known = COVERS.find((c) => (options.format ? c.format === options.format : c.marker.test(flatText(cover))));
  if (known && cover.length) {
    const stripped: Node = {
      ...doc,
      args: { ...doc.args, format: known.format, ...known.args(flatText(cover)) },
      children: doc.children.slice(first).map((n, i) => (i === 0 ? { ...n, args: withoutNewPage(n.args) } : n)),
    };
    // the format template must give back the cover as it was
    const back = texToExam(renderTexTemplate(stripped, engine).output).children;
    const extra = trailingExtra(doc.children, back);
    if (extra !== undefined) {
      doc = stripped;
      notes.push(`cover replaced by format ${known.format} (${JSON.stringify(known.args(flatText(cover)))})`);
      if (extra > 0) notes.push(`format ${known.format} adds ${extra} block(s) at the end (aids for part B)`);
    } else {
      warnings.push(`cover differs from format ${known.format}: kept in the document`);
    }
  } else if (options.format) {
    doc = { ...doc, args: { ...doc.args, format: options.format } };
  }

  // round trip without format: json -> tex -> json must be stable
  const plain = { ...doc, args: { ...doc.args } };
  delete plain.args.format;
  const again = texToExam(renderTexTemplate(plain, engine).output);
  if (!deepEqual(again.children, doc.children)) warnings.push("round trip is not stable");

  if (doc.args.totalPoints !== undefined && doc.args.totalPoints > (doc.args.points ?? 0)) {
    warnings.push(`\\setpoints{${doc.args.totalPoints}} is above the achievable maximum ${doc.args.points ?? 0}`);
  }

  const raw: Record<string, number> = {};
  const walk = (n: Node) => {
    if (n.type === "raw") {
      const head = /^\s*(\\begin\{[^}]*\}|\\[A-Za-z@]+|\{\\[A-Za-z@]+|.)/.exec(n.args.tex ?? "")?.[1] ?? "?";
      raw[head] = (raw[head] ?? 0) + 1;
    }
    n.children.forEach(walk);
    tableCells(n).forEach((cell) => cell.forEach(walk));
  };
  walk(doc);

  return { doc, notes, warnings, raw };
}

/**
 * Number of blocks that `back` has beyond `orig` at the end of the document — they land
 * in the last section or exercise, wherever the content ends —, undefined if the two
 * differ otherwise.
 */
function trailingExtra(orig: Node[], back: Node[]): number | undefined {
  if (back.length < orig.length) return undefined;
  if (back.length > orig.length) return deepEqual(back.slice(0, orig.length), orig) ? back.length - orig.length : undefined;
  if (orig.length === 0) return 0;
  const last = orig.length - 1;
  if (!deepEqual(back.slice(0, last), orig.slice(0, last))) return undefined;
  const [a, b] = [orig[last], back[last]];
  if (a.type !== b.type || !deepEqual(a.args, b.args)) return undefined;
  return trailingExtra(a.children, b.children);
}

/** TeX source compared loosely: comments (with their line end) gone, whitespace runs one space */
const looseTex = (s: string) =>
  s.replace(/(?<!\\)%[^\n]*\n?[ \t]*/g, "").replace(/\s+/g, " ").trim();

/** A flap: title, planning, stations and retro from the file, the rest must be what flap.tex writes. */
function importFlap(tex: string, engine: TemplateEngine): ImportResult {
  const doc = texToFlap(tex);
  const notes: string[] = [];
  const warnings: string[] = [];
  const out = renderTexTemplate(doc, engine);
  if (out.errors.length) warnings.push(...out.errors.map((e) => `flap.tex: ${e.message}`));
  if (looseTex(out.output) === looseTex(tex)) notes.push("everything else as in flap.tex");
  else warnings.push("the file differs from flap.tex beyond title, planning, stations and retro: those parts were not kept");
  if (!deepEqual(texToFlap(out.output), doc)) warnings.push("round trip is not stable");
  return { doc, notes, warnings, raw: {} };
}

/**
 * Structural equality of JSON values (browser-safe, no node:util). Runs of spaces and
 * tabs count as one space, as in TeX.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "string" && typeof b === "string") return a.replace(/[ \t]+/g, " ") === b.replace(/[ \t]+/g, " ");
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as any)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}

function withoutNewPage(args: Record<string, any>) {
  const { newPage: _, ...rest } = args;
  return rest;
}
