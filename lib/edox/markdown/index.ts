// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT

/*
 * edox markdown: a text form of the document tree for editing. The JSON stays
 * the stored document; the text is made from it (toMarkdown) and read back
 * (parseMarkdown). The way back is unique: parseMarkdown(toMarkdown(doc)) gives
 * doc again.
 *
 *   ---                          front matter: the arguments of the exam
 *   examName: Klausur 1          value: JSON if it reads as JSON, else text
 *   ---
 *
 *   :::section id=A title="Teil A"    block node with children; a bare ":::"
 *   Text with **bold**, *emph*, $x^2$  closes the innermost open block
 *   and ::points 2:: inline.           paragraph: lines up to a blank line
 *   :::
 *
 *   ::vspace 10pt::              a node without children, alone on its line
 *   $$ env=align*                display math (env optional)
 *   x &= 1
 *   $$
 *   ```tikz options="scale=2"    TikZ code; ```tex … ``` is raw LaTeX
 *   \draw (0,0) -- (1,1);
 *   ```
 *   - item                       list (only when every item is one paragraph;
 *   1. item                      otherwise :::list / :::item)
 *   :::table columns=["l","c"]   table: one line per row, cells between "|"
 *   | $x$ | 1 |                  ("\|" in a cell is text)
 *   :::
 *
 * Arguments: key=value, key="text" (JSON string), key={…}/[…] (JSON), a flag
 * `key` means true. Some types take one value without a key: points (value),
 * vspace (size), raw (tex). Unknown node types are kept as they are.
 * Escapes in text: \\ \* \$ \: (before ":"), "\ " is a control space.
 * args.points of exam, section, exercise and task are derived: not written,
 * computed again when reading.
 */

import type { Node } from "../node.ts";
import { maxPoints, sumPoints } from "../tex.ts";

export type MarkdownError = { line: number; message: string };

/** Types whose one argument may be written without key. */
const MAIN: Record<string, string> = { points: "value", vspace: "size", raw: "tex" };
/** Block types whose content is inline (one paragraph), not blocks. */
const INLINE_CONTENT = new Set(["paragraph", "hint"]);
/** Types with derived args.points. */
const DERIVED = new Set(["exam", "section", "exercise", "task"]);

const IDENT = /^[A-Za-z_][\w.-]*$/;

// ===========================================================================
// Writing
// ===========================================================================

/** The document as edox markdown. */
export function toMarkdown(doc: Node): string {
  const front = Object.entries(doc.args).filter(([k]) => k !== "points");
  const head = front.length ? `---\n${front.map(([k, v]) => `${k}: ${frontValue(v)}`).join("\n")}\n---\n\n` : "";
  return head + blocks(doc.children) + "\n";
}

function frontValue(v: unknown): string {
  if (typeof v !== "string") return JSON.stringify(v);
  return needsQuotes(v) ? JSON.stringify(v) : v;
}

/** A string that would read back as something else: JSON, empty, edge spaces, line breaks. */
function needsQuotes(s: string): boolean {
  if (s === "" || s !== s.trim() || /[\n\r]/.test(s)) return true;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function blocks(nodes: Node[]): string {
  return nodes.map(block).join("\n\n");
}

/** Arguments of a node, without derived points; `main` first and without key where allowed. */
function argList(n: Node): string {
  const parts: string[] = [];
  const main = MAIN[n.type];
  for (const [k, v] of Object.entries(n.args)) {
    if (k === "points" && DERIVED.has(n.type)) continue;
    if (v === undefined) continue;
    if (k === main && (typeof v !== "string" || !IDENT.test(v))) parts.unshift(argValue(v));
    else if (v === true) parts.push(k);
    else parts.push(`${k}=${argValue(v)}`);
  }
  return parts.join(" ");
}

function argValue(v: unknown): string {
  if (typeof v !== "string") return JSON.stringify(v);
  return v === "" || /[\s"=|{}[\]]|::/.test(v) || needsQuotes(v) ? JSON.stringify(v) : v;
}

const header = (prefix: string, n: Node): string => {
  const a = argList(n);
  return a ? `${prefix} ${a}` : prefix;
};

function block(n: Node): string {
  switch (n.type) {
    case "paragraph": {
      const only = n.children.length === 1 ? n.children[0] : undefined;
      // a paragraph of one ::inline:: alone would read back as a block node
      if (only && isGenericInline(only)) return `:::paragraph\n${inline(n.children)}\n:::`;
      return escapeLineStart(inline(n.children));
    }
    case "displaymath":
      return `${header("$$", { ...n, args: withoutKey(n.args, "tex") })}\n${n.args.tex}\n$$`;
    case "tikz":
      return `${header("```tikz", { ...n, args: withoutKey(n.args, "code") })}\n${n.args.code}\n\`\`\``;
    case "raw":
      if (Object.keys(n.args).every((k) => k === "tex")) return `\`\`\`tex\n${n.args.tex}\n\`\`\``;
      break;
    case "table":
      if (Array.isArray(n.args.rows)) {
        const rows = (n.args.rows as Node[][][]).map((r) => `| ${r.map((c) => inline(c, true)).join(" | ")} |`);
        return [header(":::table", { ...n, args: withoutKey(n.args, "rows") }), ...rows, ":::"].join("\n");
      }
      break;
    case "list":
      if (isSimpleList(n)) {
        return n.children
          .map((item, i) => `${n.args.ordered ? `${i + 1}.` : "-"} ${escapeLineStart(inline(item.children[0].children))}`)
          .join("\n");
      }
      break;
  }
  if (INLINE_CONTENT.has(n.type)) return `${header(`:::${n.type}`, n)}\n${escapeLineStart(inline(n.children))}\n:::`;
  if (n.children.length === 0) return `::${[n.type, argList(n)].filter(Boolean).join(" ")}::`;
  return `${header(`:::${n.type}`, n)}\n${blocks(n.children)}\n:::`;
}

const withoutKey = (args: Record<string, any>, key: string) =>
  Object.fromEntries(Object.entries(args).filter(([k]) => k !== key));

/** Every item one paragraph, no other list options: then "- text" lines. */
function isSimpleList(n: Node): boolean {
  if (Object.keys(n.args).some((k) => k !== "ordered") || n.children.length === 0) return false;
  return n.children.every(
    (item) =>
      item.type === "item" && Object.keys(item.args).length === 0 && item.children.length === 1 &&
      item.children[0].type === "paragraph" && Object.keys(item.children[0].args).length === 0 &&
      !(item.children[0].children.length === 1 && isGenericInline(item.children[0].children[0])),
  );
}

/** Inline nodes written as ::name … :: (not text, math, bold, emph, ctrlspace). */
const isGenericInline = (n: Node) => !["text", "math", "bold", "emph", "ctrlspace"].includes(n.type);

/** A text line must not start like a block construct. */
function escapeLineStart(s: string): string {
  if (/^(:::|\$\$|```|---|- |\d+\. )/.test(s)) return "\\" + s;
  return s;
}

/** Inline nodes as text; in a table `cell` "|" is escaped too. */
function inline(nodes: Node[], cell = false): string {
  return nodes.map((n) => inlineNode(n, cell)).join("");
}

function escapeText(s: string, cell = false): string {
  const t = s.replace(/\\/g, "\\\\").replace(/\*/g, "\\*").replace(/\$/g, "\\$").replace(/:(?=:)/g, "\\:");
  return cell ? t.replace(/\|/g, "\\|") : t;
}

function inlineNode(n: Node, cell = false): string {
  const plain = Object.keys(n.args).length === 0;
  switch (n.type) {
    case "text":
      if (Object.keys(n.args).every((k) => k === "value")) return escapeText(n.args.value ?? "", cell);
      break;
    case "math":
      if (Object.keys(n.args).every((k) => k === "tex")) return `$${n.args.tex}$`;
      break;
    case "bold":
      if (plain && n.children.length) return `**${inline(n.children, cell)}**`;
      break;
    case "emph":
      if (plain && n.children.length) return `*${inline(n.children, cell)}*`;
      break;
    case "ctrlspace":
      if (plain && !n.children.length) return "\\ ";
      break;
  }
  const head = [n.type, argList(n)].filter(Boolean).join(" ");
  return n.children.length ? `::${head} | ${inline(n.children, cell)}::` : `::${head}::`;
}

// ===========================================================================
// Reading
// ===========================================================================

/** edox markdown → document; errors with line numbers, reading goes on after them. */
export function parseMarkdown(source: string): { doc: Node; errors: MarkdownError[] } {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const errors: MarkdownError[] = [];
  const fail = (line: number, message: string) => errors.push({ line: line + 1, message });
  let i = 0;

  // front matter
  const args: Record<string, any> = {};
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end < 0) fail(0, "front matter: missing closing ---; read as text");
    else {
      for (i = 1; i < end; i++) {
        const m = /^([\w.-]+):\s?(.*)$/.exec(lines[i]);
        if (m) args[m[1]] = readValue(m[2]);
        else if (lines[i].trim() !== "") fail(i, `front matter: expected "key: value", found "${lines[i]}"`);
      }
      i = end + 1;
    }
  }

  const ctx: Ctx = { lines, fail, pos: i };
  const children = readBlocks(ctx, false);
  const doc: Node = { type: "exam", args, children };
  derivePoints(doc);
  return { doc, errors };
}

type Ctx = { lines: string[]; fail: (line: number, message: string) => void; pos: number };

function readValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Blocks up to the end, or up to a bare ":::" when `closing`. */
function readBlocks(ctx: Ctx, closing: boolean): Node[] {
  const out: Node[] = [];
  const { lines } = ctx;
  while (ctx.pos < lines.length) {
    const start = ctx.pos;
    const line = lines[ctx.pos];
    const trimmed = line.trim();

    if (trimmed === "") {
      ctx.pos++;
      continue;
    }
    if (trimmed === ":::") {
      if (closing) {
        ctx.pos++;
        return out;
      }
      ctx.fail(start, "::: without an open block");
      ctx.pos++;
      continue;
    }

    // :::name args
    let m = /^:::\s*([A-Za-z_][\w.-]*)\s*(.*)$/.exec(trimmed);
    if (m) {
      ctx.pos++;
      const type = m[1];
      const args = readArgs(m[2], type, (msg) => ctx.fail(start, msg));
      if (type === "table") {
        const rows: Node[][][] = [];
        while (ctx.pos < lines.length && lines[ctx.pos].trim() !== ":::") {
          const at = ctx.pos;
          const l = lines[ctx.pos++].trim();
          if (l === "") continue;
          if (!l.startsWith("|") || !l.endsWith("|") || l.length < 2) {
            ctx.fail(at, "a table row starts and ends with |");
            continue;
          }
          rows.push(splitCells(l.slice(1, -1)).map((c) => readInline(c.trim(), (msg) => ctx.fail(at, msg))));
        }
        if (ctx.pos >= lines.length) ctx.fail(start, "missing ::: for :::table");
        else ctx.pos++;
        out.push({ type, args: { ...args, rows }, children: [] });
      } else if (INLINE_CONTENT.has(type)) {
        const body: string[] = [];
        while (ctx.pos < lines.length && lines[ctx.pos].trim() !== ":::") body.push(lines[ctx.pos++]);
        if (ctx.pos >= lines.length) ctx.fail(start, `missing ::: for :::${type}`);
        else ctx.pos++;
        out.push({ type, args, children: readInline(unescapeLineStart(body.join(" ").trim()), (msg) => ctx.fail(start, msg)) });
      } else {
        out.push({ type, args, children: readBlocks(ctx, true) });
      }
      continue;
    }

    // $$ args … $$
    if (/^\$\$(\s|$)/.test(trimmed)) {
      ctx.pos++;
      const args = readArgs(trimmed.slice(2), "displaymath", (msg) => ctx.fail(start, msg));
      const body: string[] = [];
      while (ctx.pos < lines.length && lines[ctx.pos].trim() !== "$$") body.push(lines[ctx.pos++]);
      if (ctx.pos >= lines.length) ctx.fail(start, "missing closing $$");
      else ctx.pos++;
      out.push({ type: "displaymath", args: { tex: body.join("\n"), ...args }, children: [] });
      continue;
    }

    // ```tikz args / ```tex
    m = /^```(\w+)\s*(.*)$/.exec(trimmed);
    if (m) {
      ctx.pos++;
      const body: string[] = [];
      while (ctx.pos < lines.length && lines[ctx.pos].trim() !== "```") body.push(lines[ctx.pos++]);
      if (ctx.pos >= lines.length) ctx.fail(start, "missing closing ```");
      else ctx.pos++;
      const code = body.join("\n");
      if (m[1] === "tex") out.push({ type: "raw", args: { tex: code }, children: [] });
      else {
        const args = readArgs(m[2], m[1], (msg) => ctx.fail(start, msg));
        out.push({ type: m[1], args: { code, ...args }, children: [] });
      }
      continue;
    }

    // ::name args:: alone on its line: a node without children
    m = /^::([A-Za-z_][\w.-]*)(.*)::$/.exec(trimmed);
    if (m && !m[2].includes("::")) {
      ctx.pos++;
      out.push({ type: m[1], args: readArgs(m[2], m[1], (msg) => ctx.fail(start, msg)), children: [] });
      continue;
    }

    // - item / 1. item
    const listMark = /^(- |\d+\. )/.exec(trimmed);
    if (listMark) {
      const ordered = listMark[1] !== "- ";
      const items: Node[] = [];
      while (ctx.pos < lines.length) {
        const l = lines[ctx.pos].trim();
        const mm = ordered ? /^\d+\. (.*)$/.exec(l) : /^- (.*)$/.exec(l);
        if (!mm) break;
        const at = ctx.pos;
        items.push({
          type: "item", args: {},
          children: [{ type: "paragraph", args: {}, children: readInline(unescapeLineStart(mm[1]), (msg) => ctx.fail(at, msg)) }],
        });
        ctx.pos++;
      }
      out.push({ type: "list", args: ordered ? { ordered: true } : {}, children: items });
      continue;
    }

    // paragraph: lines up to a blank line or a block construct
    const body: string[] = [];
    while (ctx.pos < lines.length) {
      const l = lines[ctx.pos].trim();
      if (l === "" || (body.length && startsBlock(l))) break;
      body.push(l);
      ctx.pos++;
    }
    out.push({ type: "paragraph", args: {}, children: readInline(unescapeLineStart(body.join(" ")), (msg) => ctx.fail(start, msg)) });
  }
  if (closing) ctx.fail(ctx.lines.length - 1, "missing ::: at the end");
  return out;
}

/** The cells of a table row: split at "|", but not at "\|", in $…$ or in ::…::. */
function splitCells(s: string): string[] {
  const cells: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "$") {
      while (++i < s.length && s[i] !== "$") if (s[i] === "\\") i++;
    } else if (s.startsWith("::", i) && /^::[A-Za-z_]/.test(s.slice(i))) {
      const close = s.indexOf("::", i + 2);
      if (close >= 0) i = close + 1;
    } else if (c === "|") {
      cells.push(s.slice(start, i));
      start = i + 1;
    }
  }
  cells.push(s.slice(start));
  return cells;
}

function startsBlock(l: string): boolean {
  return /^(:::|\$\$(\s|$)|```|- |\d+\. )/.test(l) || (/^::[A-Za-z_][\w.-]*.*::$/.test(l) && !l.slice(2, -2).includes("::"));
}

function unescapeLineStart(s: string): string {
  return /^\\(:::|\$\$|```|---|- |\d+\. )/.test(s) ? s.slice(1) : s;
}

// ---------- arguments ----------

/** "key=value key="x" flag 3" → args; `type` decides the key of a value without key. */
function readArgs(src: string, type: string, fail: (message: string) => void): Record<string, any> {
  const args: Record<string, any> = {};
  let i = 0;
  const s = src;
  const skip = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  skip();
  while (i < s.length) {
    let key: string | undefined;
    const km = /^([A-Za-z_][\w.-]*)(=?)/.exec(s.slice(i));
    if (km && km[2] === "=") {
      key = km[1];
      i += km[0].length;
    } else if (km && (i + km[1].length === s.length || /\s/.test(s[i + km[1].length]))) {
      // a flag; for a type with a main argument a bare word is that argument's value
      const word = km[1];
      i += word.length;
      args[word] = true;
      skip();
      continue;
    }
    const { value, end, error } = readArgValue(s, i);
    if (error) {
      fail(error);
      return args;
    }
    i = end;
    if (key) args[key] = value;
    else if (MAIN[type] && !(MAIN[type] in args)) args[MAIN[type]] = value;
    else fail(`value without key: ${s.slice(i - 1)}`);
    skip();
  }
  return args;
}

function readArgValue(s: string, i: number): { value: unknown; end: number; error?: string } {
  const c = s[i];
  if (c === '"' || c === "{" || c === "[") {
    const end = jsonEnd(s, i);
    if (end < 0) return { value: undefined, end: s.length, error: `unclosed ${c} in arguments` };
    try {
      return { value: JSON.parse(s.slice(i, end)), end };
    } catch {
      return { value: undefined, end, error: `not valid JSON: ${s.slice(i, end)}` };
    }
  }
  let end = i;
  while (end < s.length && !/\s/.test(s[end])) end++;
  const raw = s.slice(i, end);
  let value: unknown = raw;
  try {
    const v = JSON.parse(raw);
    if (typeof v !== "object" || v === null) value = v; // number, true, false, null
  } catch {}
  return { value, end };
}

/** End (exclusive) of the JSON value starting at i: string, object or array. */
function jsonEnd(s: string, i: number): number {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '"') {
      for (k++; k < s.length && s[k] !== '"'; k++) if (s[k] === "\\") k++;
      if (k >= s.length) return -1;
      if (depth === 0) return k + 1;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

// ---------- inline ----------

function readInline(s: string, fail: (message: string) => void): Node[] {
  const p = { s, i: 0 };
  const nodes = inlineUntil(p, "", fail);
  return nodes;
}

const text = (value: string): Node => ({ type: "text", args: { value }, children: [] });

/** Inline nodes up to `stop` ("**", "*", "::" or "" = end of text). */
function inlineUntil(p: { s: string; i: number }, stop: string, fail: (message: string) => void): Node[] {
  const out: Node[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(text(buf));
    buf = "";
  };
  const { s } = p;
  while (p.i < s.length) {
    // "***" ends an emph first (then a bold may end): **a *b*** and *a **b***
    if (stop && s.startsWith(stop, p.i) && !(stop === "*" && s.startsWith("**", p.i) && !s.startsWith("***", p.i))) {
      p.i += stop.length;
      flush();
      return out;
    }
    const c = s[p.i];
    if (c === "\\" && p.i + 1 < s.length) {
      if (s[p.i + 1] === " ") {
        flush();
        out.push({ type: "ctrlspace", args: {}, children: [] });
      } else buf += s[p.i + 1];
      p.i += 2;
      continue;
    }
    if (c === "$") {
      let k = p.i + 1;
      while (k < s.length && s[k] !== "$") k += s[k] === "\\" ? 2 : 1;
      if (k >= s.length) {
        fail("missing closing $");
        buf += s.slice(p.i);
        p.i = s.length;
        continue;
      }
      flush();
      out.push({ type: "math", args: { tex: s.slice(p.i + 1, k) }, children: [] });
      p.i = k + 1;
      continue;
    }
    if (s.startsWith("**", p.i)) {
      flush();
      p.i += 2;
      out.push({ type: "bold", args: {}, children: inlineUntil(p, "**", fail) });
      continue;
    }
    if (c === "*") {
      flush();
      p.i += 1;
      out.push({ type: "emph", args: {}, children: inlineUntil(p, "*", fail) });
      continue;
    }
    const m = /^::([A-Za-z_][\w.-]*)/.exec(s.slice(p.i));
    if (m) {
      const close = s.indexOf("::", p.i + m[0].length);
      if (close < 0) {
        fail(`missing closing :: for ::${m[1]}`);
        buf += s.slice(p.i);
        p.i = s.length;
        continue;
      }
      flush();
      const inner = s.slice(p.i + m[0].length, close);
      const bar = inner.indexOf(" | ");
      const node: Node = {
        type: m[1],
        args: readArgs(bar < 0 ? inner : inner.slice(0, bar), m[1], fail),
        children: bar < 0 ? [] : readInline(inner.slice(bar + 3), fail),
      };
      out.push(node);
      p.i = close + 2;
      continue;
    }
    buf += c;
    p.i++;
  }
  if (stop) fail(`missing closing ${stop}`);
  flush();
  return out;
}

// ---------- derived points ----------

/** Sets args.points of exam, section, exercise and task (in place), as the parser of .tex files does. */
export function derivePoints(n: Node) {
  n.children.forEach(derivePoints);
  if (!DERIVED.has(n.type)) return;
  const p = n.type === "exam" || n.type === "section" ? maxPoints(n) : sumPoints(n);
  if (p > 0) n.args.points = p;
  else delete n.args.points;
}
