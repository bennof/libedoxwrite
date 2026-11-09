import type { Node } from "../node.ts";
import { escapeTex } from "../tex.ts";
import type { Span } from "../table.ts";

/*
 * LaTeX (edoxarticle exam) -> generic JSON tree of
 *
 *   Node { type: string; args: Record<string, any>; children: Node[] }
 *
 * Meaning (sections, exercises, tasks, solutions, points, text, math, ...)
 * becomes node types (see ../document.schema.json); \vskip becomes "vspace",
 * \newpage before a section/exercise/task args.newPage. Blank lines of the
 * source are not kept: the renderers decide them by node type. Old layout
 * constructs (headings, signature lines, \underline, ...) and LaTeX without a
 * mapping are kept as { type: "raw", args: { tex } }. Comments and the
 * preamble (except macros, \examname, \pointsname) are dropped.
 *
 * args.points on exercise/task (sum of \pp) and on section/exam (achievable
 * maximum) are derived; the renderers ignore them. A section's
 * args.choice = { select: n } means only n of its exercises are graded
 * (exercise selection). \setpoints becomes args.totalPoints on the exam and is
 * written back as it is; TeX itself only sums all \pp, so a choice needs it.
 */

/* =====================================================================
 * Semantic model
 * ===================================================================== */

export type Inline =
  | string
  | { type: "math"; tex: string }
  | { type: "strong" | "emph"; content: Inline[] }
  | { type: "points"; value: number }
  | { type: "linebreak" }
  | { type: "ctrlspace" }
  | { type: "raw"; tex: string };

export type Block =
  | { type: "paragraph"; content: Inline[] }
  | { type: "hint"; content: Inline[] }
  | { type: "displaymath"; tex: string; env?: string }
  | { type: "points"; value: number }
  | { type: "figure"; graphics: Graphic[] }
  | { type: "list"; ordered: boolean; items: Block[][] }
  | { type: "answerspace"; kind: string; height: string }
  | { type: "vspace"; size: string }
  | { type: "pagebreak"; src: string }
  | Table
  | Section
  | Exercise
  | Task
  | { type: "raw"; tex: string };

export type Graphic = { type: "tikz"; options?: string; code: string };

/**
 * A tabular: columns l, c, r or p{width}; every cell inline content. Only the forms
 * that come back unchanged: no lines, or a full grid (| everywhere, \hline after every
 * row); @{} on both sides (compact); one \\[space] for all rows; in a center
 * environment (center). Any other tabular stays raw TeX.
 */
export interface Table {
  type: "table";
  columns: string[];
  rows: Inline[][][];
  rules?: "grid";
  compact?: boolean;
  rowSpace?: string;
  rowSpaces?: string[];
  stretch?: string;
  spans?: Span[];
  center?: boolean;
}

export interface Section {
  type: "section";
  command?: string; // only when not \wssection
  id?: string;
  title: string | Inline[];
  newPage?: boolean;
  /** only `select` of the section's exercises are graded (exercise selection) */
  choice?: { select: number };
  points?: number;
  content: Block[];
}

export interface Exercise {
  type: "exercise";
  title?: string | Inline[];
  starred?: boolean;
  newPage?: boolean;
  points?: number;
  content: Block[];
  solution?: Block[];
}

export interface Task {
  type: "task";
  width?: string;
  starred?: boolean;
  newPage?: boolean;
  points?: number;
  content: Block[];
  solution?: Block[];
}

export interface ExamDoc {
  type: "exam";
  meta: {
    documentClass?: { name: string; options?: string };
    examName?: string;
    pointsName?: string;
    /** environment: exam (default), test or worksheet */
    kind?: "test" | "worksheet";
    /** false: [nosolution], the solutions are not printed */
    solutions?: boolean;
    macros?: { name: string; args?: number; default?: string; body: string; provide?: boolean }[];
    preamble?: string[];
    date?: string;
    title?: string | Inline[];
    totalPoints?: number;
  };
  points?: number;
  content: Block[];
}

/* =====================================================================
 * Low-level TeX syntax tree
 * ===================================================================== */

interface Arg {
  raw: string;
  nodes: Tex[];
}

type Tex =
  | { k: "text"; v: string }
  | { k: "par" }
  | { k: "math"; display: boolean; tex: string; env?: string }
  | { k: "cmd"; name: string; star: boolean; opt?: string; dim?: string; args: Arg[]; src: string }
  | { k: "env"; name: string; opt?: string; args: Arg[]; body: Tex[]; raw: string; src: string }
  | { k: "group"; body: Tex[]; src: string };

/*
 * Argument signatures:
 *   *  optional star      o  [optional]       m  {mandatory}
 *   d  TeX dimension      t  "to <dim>"       g  any number of {..}
 */
const SIG: Record<string, string> = {
  documentclass: "om",
  usepackage: "om",
  renewcommand: "*mo om",
  newcommand: "*mo om",
  providecommand: "*mo om",
  exercise: "*om",
  subexercise: "*om",
  solve: "m",
  wssection: "om",
  section: "*om",
  subsection: "*om",
  pp: "o",
  pdate: "m",
  setpoints: "m",
  answerbox: "m",
  mathbox: "m",
  textbf: "m",
  textit: "m",
  emph: "m",
  underline: "m",
  text: "m",
  vskip: "d",
  vspace: "*m",
  hspace: "*m",
  kern: "d",
  hbox: "tm",
  rule: "omm",
  item: "o",
  includegraphics: "om",
  "\\": "*o",
};

const NO_ARGS = new Set([
  "newpage", "pagebreak", "clearpage", "hfill", "hrulefill", "leaders",
  "hrule", "noindent", "par", "bigskip", "medskip", "smallskip", "centering",
  "quad", "qquad", "euro", "glqq", "grqq", "tiny", "scriptsize", "footnotesize", "small",
  "normalsize", "large", "Large", "LARGE", "huge", "Huge", "bfseries",
  "itshape", "hsize", "textwidth", "empty", "makeatletter", "makeatother", "hline",
]);

const ENV_SIG: Record<string, string> = {
  exam: "m",
  test: "m",
  worksheet: "m",
  flap: "mm",
  tabular: "m",
  minipage: "om",
};

const RAW_ENVS = new Set(["tikzpicture", "verbatim", "lstlisting"]);

const MATH_ENVS = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*",
  "multline", "multline*", "eqnarray", "eqnarray*",
]);

const SIZE_CMDS = new Set(["tiny", "small", "large", "Large", "LARGE", "huge", "Huge"]);

const DIM_RE =
  /^(-?\d*[.,]?\d+\s*(?:pt|cm|mm|em|ex|in|bp|sp|pc|dd|cc)|-?\d*[.,]?\d*\s*\\[A-Za-z@]+)/;

export type TexDiagnostic = { line: number; column: number; message: string };

export function diagnoseTex(source: string): TexDiagnostic[] {
  const errors: TexDiagnostic[] = [];
  new Parser(source, errors).parseAll();
  return errors;
}

class Parser {
  private pos = 0;
  private readonly src: string;

  constructor(src: string, private readonly errors: TexDiagnostic[] = []) {
    this.src = src;
  }

  private fail(message: string) {
    const lines = this.src.slice(0, this.pos).split("\n");
    this.errors.push({ line: lines.length, column: lines.at(-1)!.length + 1, message });
  }

  parseAll(): Tex[] {
    return this.seq(null);
  }

  /** Parse until EOF, an unbalanced "}" (stop === "}") or the token `stop`. */
  private seq(stop: string | null): Tex[] {
    const out: Tex[] = [];
    let text = "";
    const flush = () => {
      if (text) pushText(out, text);
      text = "";
    };

    while (this.pos < this.src.length) {
      if (stop === "}" && this.peek() === "}") break;
      if (stop && stop !== "}" && this.src.startsWith(stop, this.pos)) break;

      const ch = this.peek();

      if (ch === "%") {
        this.skipComment();
        continue;
      }
      if (ch === "{") {
        flush();
        out.push(this.group());
        continue;
      }
      if (ch === "}") {
        // stray closing brace
        this.fail("unexpected closing }");
        this.pos++;
        continue;
      }
      if (ch === "$") {
        flush();
        out.push(this.dollarMath());
        continue;
      }
      if (ch === "&") {
        // alignment tab (\& is text): its own token, so tables can be split
        flush();
        out.push({ k: "cmd", name: "&", star: false, args: [], src: "&" });
        this.pos++;
        continue;
      }
      if (ch === "~") {
        text += "\u00A0";
        this.pos++;
        continue;
      }
      if (ch === "\\") {
        const next = this.peek(1);
        if (next === "[") {
          flush();
          out.push(this.bracketMath());
          continue;
        }
        if (next && "%&_#${}".includes(next)) {
          text += next;
          this.pos += 2;
          continue;
        }
        if (next === " " || next === "\n" || next === "\t") {
          // control space: kept as its own node (differs from " " after a period)
          flush();
          out.push({ k: "cmd", name: " ", star: false, args: [], src: "\\ " });
          this.pos += 2;
          continue;
        }
        if (next === ",") {
          text += "\u202F";
          this.pos += 2;
          continue;
        }
        if (next === "-") {
          this.pos += 2;
          continue;
        }
        flush();
        out.push(this.command());
        continue;
      }

      text += ch;
      this.pos++;
    }

    flush();
    return out;
  }

  private group(): Tex {
    const start = this.pos;
    this.pos++;
    const body = this.seq("}");
    if (this.peek() === "}") this.pos++;
      else this.fail("missing closing }");
    return { k: "group", body, src: this.src.slice(start, this.pos) };
  }

  private command(): Tex {
    const start = this.pos;
    this.pos++;

    let name: string;
    if (/[A-Za-z@]/.test(this.peek())) {
      const s = this.pos;
      while (/[A-Za-z@]/.test(this.peek())) this.pos++;
      name = this.src.slice(s, this.pos);
    } else {
      name = this.peek();
      this.pos++;
    }

    if (name === "begin") return this.environment(start);

    const isWord = /^[A-Za-z@]+$/.test(name);
    const sig = SIG[name] ?? (NO_ARGS.has(name) ? "" : isWord ? "*og" : "");
    const node: Extract<Tex, { k: "cmd" }> = { k: "cmd", name, star: false, args: [], src: "" };

    let end = this.pos;
    if (isWord) this.skipCsSpace();
    const afterSpace = this.pos;
    let consumed = false;

    for (const s of sig) {
      if (s === " ") continue;
      const before = this.pos;
      if (s === "*") {
        if (this.peek() === "*") {
          node.star = true;
          this.pos++;
          consumed = true;
        }
      } else if (s === "o") {
        this.skipSpace();
        if (this.peek() === "[") {
          node.opt = this.readBalanced("[", "]");
          consumed = true;
        } else this.pos = before;
      } else if (s === "m") {
        this.skipSpace();
        node.args.push(this.readArg());
        consumed = true;
      } else if (s === "g") {
        for (;;) {
          const b = this.pos;
          this.skipInlineSpace();
          if (this.peek() !== "{") {
            this.pos = b;
            break;
          }
          node.args.push(this.readArg());
          consumed = true;
        }
      } else if (s === "d") {
        this.skipSpace();
        const m = DIM_RE.exec(this.src.slice(this.pos, this.pos + 40));
        if (m) {
          node.dim = m[1].replace(/\s+/g, "");
          this.pos += m[0].length;
          consumed = true;
        }
      } else if (s === "t") {
        this.skipSpace();
        if (this.src.startsWith("to", this.pos)) {
          this.pos += 2;
          this.skipSpace();
          const m = DIM_RE.exec(this.src.slice(this.pos, this.pos + 40));
          if (m) {
            node.dim = m[1].replace(/\s+/g, "");
            this.pos += m[0].length;
          }
          consumed = true;
        } else this.pos = before;
      }
      if (consumed) end = this.pos;
    }

    if (!consumed) this.pos = afterSpace;
    node.src = this.src.slice(start, end);

    // control words swallow following spaces (once more after a dimension)
    if (consumed && node.dim !== undefined && node.args.length === 0) this.skipCsSpace();
    return node;
  }

  private environment(start: number): Tex {
    this.skipSpace();
    const name = this.readBalanced("{", "}");
    const endToken = `\\end{${name}}`;

    if (MATH_ENVS.has(name)) {
      const end = this.findOrEof(endToken);
      const tex = this.src.slice(this.pos, end);
      this.pos = Math.min(this.src.length, end + endToken.length);
      return { k: "math", display: true, tex: tex.trim(), env: name };
    }

    const node: Extract<Tex, { k: "env" }> = { k: "env", name, args: [], body: [], raw: "", src: "" };

    const before = this.pos;
    this.skipInlineSpace();
    if (this.peek() === "[") node.opt = this.readBalanced("[", "]");
    else this.pos = before;

    for (const s of ENV_SIG[name] ?? "") {
      if (s === "m") {
        this.skipSpace();
        node.args.push(this.readArg());
      }
    }

    const bodyStart = this.pos;
    if (RAW_ENVS.has(name)) {
      const end = this.findOrEof(endToken);
      this.pos = end;
    } else {
      node.body = this.seq(endToken);
    }
    node.raw = this.src.slice(bodyStart, this.pos);
    if (this.src.startsWith(endToken, this.pos)) this.pos += endToken.length;
    else if (!RAW_ENVS.has(name)) this.fail(`missing ${endToken}`);
    node.src = this.src.slice(start, this.pos);
    return node;
  }

  private dollarMath(): Tex {
    const display = this.peek(1) === "$";
    const delim = display ? "$$" : "$";
    this.pos += delim.length;
    const start = this.pos;
    while (this.pos < this.src.length) {
      if (this.peek() === "\\") {
        this.pos += 2;
        continue;
      }
      if (this.src.startsWith(delim, this.pos)) break;
      this.pos++;
    }
    if (!this.src.startsWith(delim, this.pos)) this.fail(`missing closing ${delim}`);
    const tex = this.src.slice(start, this.pos);
    this.pos = Math.min(this.src.length, this.pos + delim.length);
    return { k: "math", display, tex: display ? tex.trim() : tex };
  }

  private bracketMath(): Tex {
    this.pos += 2;
    const end = this.findOrEof("\\]");
    const tex = this.src.slice(this.pos, end);
    this.pos = Math.min(this.src.length, end + 2);
    return { k: "math", display: true, tex: tex.trim() };
  }

  /** {group} parsed recursively, or a single token (\cs or char). */
  private readArg(): Arg {
    if (this.peek() === "{") {
      this.pos++;
      const start = this.pos;
      const nodes = this.seq("}");
      const raw = this.src.slice(start, this.pos);
      if (this.peek() === "}") this.pos++;
      else this.fail("missing closing }");
      return { raw, nodes };
    }
    const start = this.pos;
    if (this.peek() === "\\") {
      this.pos++;
      if (/[A-Za-z@]/.test(this.peek())) while (/[A-Za-z@]/.test(this.peek())) this.pos++;
      else this.pos++;
    } else this.pos++;
    const raw = this.src.slice(start, this.pos);
    return { raw, nodes: new Parser(raw).parseAll() };
  }

  private readBalanced(open: string, close: string): string {
    if (this.peek() !== open) return "";
    this.pos++;
    const start = this.pos;
    let depth = 1;
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch === "\\") {
        this.pos += 2;
        continue;
      }
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        const result = this.src.slice(start, this.pos);
        this.pos++;
        return result;
      }
      this.pos++;
    }
    this.fail(`missing closing ${close}`);
    return this.src.slice(start);
  }

  private findOrEof(token: string): number {
    const i = this.src.indexOf(token, this.pos);
    if (i < 0) this.fail(`missing ${token}`);
    return i < 0 ? this.src.length : i;
  }

  private skipComment(): void {
    while (this.pos < this.src.length && this.peek() !== "\n") this.pos++;
    if (this.peek() === "\n") this.pos++;
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  /** Spaces after a control word, including one line end (but not a blank line). */
  private skipCsSpace(): void {
    this.skipInlineSpace();
    if (this.peek() === "\n") {
      const rest = this.src.slice(this.pos + 1);
      if (!/^[ \t]*\n/.test(rest)) {
        this.pos++;
        this.skipInlineSpace();
      }
    }
  }

  private skipInlineSpace(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  private skipSpace(): void {
    while (/\s/.test(this.peek())) this.pos++;
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }
}

function pushText(out: Tex[], text: string): void {
  const parts = text.split(/\n[ \t]*\n\s*/);
  parts.forEach((p, i) => {
    if (i > 0) out.push({ k: "par" });
    if (p) out.push({ k: "text", v: p.replace(/---/g, "\u2014").replace(/--/g, "\u2013") });
  });
}

/* =====================================================================
 * TeX tree -> semantic model
 * ===================================================================== */

type Cmd = Extract<Tex, { k: "cmd" }>;
type Env = Extract<Tex, { k: "env" }>;

const isCmd = (n: Tex | undefined, ...names: string[]): n is Cmd =>
  !!n && n.k === "cmd" && (names.length === 0 || names.includes(n.name));

const isBlank = (n: Tex): boolean =>
  (n.k === "text" && n.v.trim() === "") || n.k === "par";

const significant = (nodes: Tex[]): Tex[] => nodes.filter((n) => !isBlank(n));

function rawTex(src: string): Inline & { type: "raw" } {
  // a bare control word must not merge with following letters
  return { type: "raw", tex: /\\[A-Za-z@]+$/.test(src) ? src + "{}" : src };
}

function parsePoints(opt: string | undefined): number {
  if (opt === undefined || opt.trim() === "") return 1;
  const v = Number(opt.trim().replace(",", "."));
  return Number.isFinite(v) ? v : 1;
}

/* ---------- inline ---------- */

/** \hbox to 4cm{\hrulefill}: a line to write on within the text, not a block */
function isRuleLine(n: Tex): boolean {
  if (!isCmd(n, "hbox") || !n.dim || !n.args[0]) return false;
  const body = significant(n.args[0].nodes);
  return body.length === 1 && isCmd(body[0], "hrulefill");
}

function toInline(nodes: Tex[]): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    switch (n.k) {
      case "text":
        out.push(n.v);
        break;
      case "par":
        out.push(" ");
        break;
      case "math":
        out.push(n.display ? rawTex(`\\[${n.tex}\\]`) : { type: "math", tex: n.tex });
        break;
      case "group":
        if (n.body.some((b) => b.k === "cmd" && (SIZE_CMDS.has(b.name) || b.name === "bfseries"))) {
          out.push(rawTex(n.src));
        } else out.push(...toInline(n.body));
        break;
      case "env":
        out.push(rawTex(n.src));
        break;
      case "cmd": {
        const arg0 = n.args[0]?.nodes ?? [];
        switch (n.name) {
          case "textbf":
            out.push({ type: "strong", content: normalizeInline(toInline(arg0), false) });
            break;
          case "emph":
          case "textit":
            out.push({ type: "emph", content: normalizeInline(toInline(arg0), false) });
            break;
          case "pp":
            out.push({ type: "points", value: parsePoints(n.opt) });
            break;
          case "\\":
            out.push({ type: "linebreak" });
            break;
          case " ":
            out.push({ type: "ctrlspace" });
            break;
          case "euro":
            out.push("\u20AC");
            break;
          case "quad":
            out.push("\u2003"); // em space; written back as \quad{}
            break;
          case "glqq":
            out.push("\u201E");
            break;
          case "grqq":
            out.push("\u201C");
            break;
          default:
            out.push(rawTex(n.src));
        }
        break;
      }
    }
  }
  return out;
}

const isPointsInline = (x: Inline): boolean => typeof x !== "string" && x.type === "points";

/** Merge strings, collapse whitespace, optionally trim the ends. */
function normalizeInline(items: Inline[], trim = true): Inline[] {
  const merged: Inline[] = [];
  for (const it of items) {
    const last = merged[merged.length - 1];
    if (typeof it === "string" && typeof last === "string") merged[merged.length - 1] = last + it;
    else merged.push(it);
  }
  const out = merged
    .map((x) => (typeof x === "string" ? x.replace(/[ \t\r\n]+/g, " ") : x))
    .filter((x) => x !== "");

  if (trim) {
    // leading whitespace
    while (typeof out[0] === "string" && (out[0] as string).trimStart() === "") out.shift();
    if (typeof out[0] === "string") out[0] = (out[0] as string).replace(/^ +/, "");

    // trailing whitespace
    const last = out.length - 1;
    if (typeof out[last] === "string") {
      const t = (out[last] as string).replace(/ +$/, "");
      if (t === "") out.pop();
      else out[last] = t;
    }
  }
  return out;
}

function inlineOrText(nodes: Tex[]): string | Inline[] {
  const inl = normalizeInline(toInline(nodes));
  if (inl.every((x) => typeof x === "string")) return inl.join("");
  return inl;
}

/* ---------- blocks ---------- */

const BLOCK_CMDS = new Set([
  "exercise", "subexercise", "solve", "wssection", "section", "subsection",
  "vskip", "vspace", "bigskip", "medskip", "smallskip", "newpage", "pagebreak",
  "clearpage", "setpoints", "answerbox", "mathbox", "noindent", "par", "item",
]);

type Pre = Block | { type: "solution"; content: Block[] } | { type: "setpoints"; value: number };

function isBlockNode(n: Tex): boolean {
  if (n.k === "math") return n.display;
  if (n.k === "env") return true;
  if (n.k === "group") {
    const first = significant(n.body)[0];
    return isCmd(first) && SIZE_CMDS.has(first.name);
  }
  if (n.k === "cmd") {
    if (n.name === "hbox") return !isRuleLine(n);
    return BLOCK_CMDS.has(n.name);
  }
  return false;
}

const INLINE = new WeakSet<object>();

function toBlocks(nodes: Tex[]): Pre[] {
  const out: Pre[] = [];
  let cur: Tex[] = [];
  const flush = () => {
    const content = normalizeInline(toInline(cur));
    if (content.length) {
      out.push({ type: "paragraph", content });
    }
    cur = [];
  };
  for (const n of nodes) {
    if (n.k === "par") {
      flush();
    } else if (isBlockNode(n)) {
      flush();
      const b = toBlock(n);
      if (b) out.push(b);
    } else {
      if (cur.length === 0 && n.k === "text" && n.v.trim() === "") continue;
      cur.push(n);
    }
  }
  flush();
  return out;
}

function toBlock(n: Tex): Pre | null {
  if (n.k === "math") return n.env ? { type: "displaymath", tex: n.tex, env: n.env } : { type: "displaymath", tex: n.tex };
  // a group that starts with a size command ({\LARGE\textbf{…}}): layout, kept as written
  if (n.k === "group") return { type: "raw", tex: n.src };
  if (n.k === "env") return toEnvBlock(n);
  if (n.k !== "cmd") return null;

  switch (n.name) {
    case "exercise":
    case "subexercise": {
      const pre = toBlocks(n.args[0]?.nodes ?? []);
      const solution = pre.flatMap((b) => (b.type === "solution" ? b.content : []));
      const sol = pre.find((b) => b.type === "solution");
      if (sol && INLINE.has((sol as { content: Block[] }).content)) INLINE.add(solution);
      const content = postProcess(pre.filter((b) => b.type !== "solution"));
      const hasSolution = pre.some((b) => b.type === "solution");

      if (n.name === "exercise") {
        const ex = { type: "exercise" } as Exercise;
        if (n.opt !== undefined) ex.title = inlineOrText(new Parser(n.opt).parseAll());
        if (n.star) ex.starred = true;
        ex.content = content;
        if (hasSolution) ex.solution = solution;
        return ex;
      }
      const t = { type: "task" } as Task;
      if (n.opt !== undefined) t.width = n.opt.trim();
      if (n.star) t.starred = true;
      t.content = content;
      if (hasSolution) t.solution = solution;
      return t;
    }
    case "solve": {
      const sol: Pre = { type: "solution", content: postProcess(toBlocks(n.args[0]?.nodes ?? [])) };
      // \solve{...} written on one line (no line break after "{")
      if (!/^[ \t]*\n/.test(n.args[0]?.raw ?? "")) INLINE.add(sol.content);
      return sol;
    }
    case "wssection":
    case "section":
    case "subsection": {
      const s = { type: "section" } as Section;
      if (n.name !== "wssection") s.command = n.star ? `${n.name}*` : n.name;
      if (n.opt !== undefined) s.id = n.opt.trim();
      s.title = inlineOrText(n.args[0]?.nodes ?? []);
      s.content = [];
      return s;
    }
    case "vskip":
      return { type: "vspace", size: n.dim ?? "0pt" };
    case "vspace":
      return { type: "vspace", size: n.args[0]?.raw.trim() ?? "0pt" };
    case "bigskip":
      return { type: "vspace", size: "12pt" };
    case "medskip":
      return { type: "vspace", size: "6pt" };
    case "smallskip":
      return { type: "vspace", size: "3pt" };
    case "newpage":
    case "pagebreak":
    case "clearpage":
      return { type: "pagebreak", src: n.src };
    case "setpoints":
      return { type: "setpoints", value: parsePoints(n.args[0]?.raw) };
    case "answerbox":
    case "mathbox":
      return { type: "answerspace", kind: n.name, height: n.args[0]?.raw.trim() ?? "" };
    case "noindent":
    case "par":
      return null;
  }
  return { type: "raw", tex: n.src };
}

function toEnvBlock(n: Env): Pre {
  switch (n.name) {
    case "tabular":
      return toTable(n) ?? { type: "raw", tex: n.src };
    case "center": {
      const sig = significant(n.body);
      const tab = sig.at(-1);
      const stretch = sig.length === 2 ? arrayStretch(sig[0]) : undefined;
      if ((sig.length === 1 || stretch) && tab?.k === "env" && tab.name === "tabular") {
        const t = toTable(tab);
        if (t) return stretch ? { ...t, stretch, center: true } : { ...t, center: true };
      }
      const graphics: Graphic[] = [];
      let figure = sig.length > 0;
      for (const x of sig) {
        if (x.k === "env" && x.name === "tikzpicture") graphics.push(toTikz(x));
        else if (!isCmd(x, "hfill")) figure = false;
      }
      if (figure && graphics.length) return { type: "figure", graphics };
      return { type: "raw", tex: n.src };
    }
    case "itemize":
    case "enumerate": {
      const items: Block[][] = [];
      let cur: Tex[] | null = null;
      for (const x of n.body) {
        if (isCmd(x, "item")) {
          if (cur) items.push(postProcess(toBlocks(cur)));
          cur = [];
        } else if (cur) cur.push(x);
      }
      if (cur) items.push(postProcess(toBlocks(cur)));
      return { type: "list", ordered: n.name === "enumerate", items };
    }
  }
  return { type: "raw", tex: n.src };
}

/** The tabular as a table, null if it does not fit the model (see Table). */
function toTable(n: Env): Table | null {
  // column spec: @{} … @{}, |, l c r p{…}, >{\centering\arraybackslash}p{…}, *{n}{…}
  let spec = expandSpec((n.args[0]?.raw ?? "").replace(/\s+/g, ""));
  if (spec === null) return null;
  let compact = false;
  if (spec.startsWith("@{}") && spec.endsWith("@{}") && spec.length > 6) {
    compact = true;
    spec = spec.slice(3, -3);
  }
  const columns: string[] = [];
  let shape = ""; // | and x per column, to check the rules
  for (let i = 0; i < spec.length; ) {
    const c = spec[i];
    let prefix = "";
    if (c === "|") {
      shape += "|";
      i++;
      continue;
    }
    if (c === ">" && spec[i + 1] === "{") {
      const end = closingBrace(spec, i + 1);
      if (end < 0) return null;
      prefix = spec.slice(i + 2, end);
      i = end + 1;
    }
    const d = spec[i];
    if (!prefix && "lcr".includes(d)) {
      columns.push(d);
      i++;
    } else if (d === "p" && spec[i + 1] === "{") {
      const end = closingBrace(spec, i + 1);
      if (end < 0) return null;
      const width = spec.slice(i + 2, end);
      const align = PREFIX_ALIGN[prefix];
      if (align === undefined) return null;
      columns.push(`${align}{${width}}`);
      i = end + 1;
    } else return null;
    shape += "x";
  }
  const grid = shape.includes("|");
  if (!columns.length || (grid && (compact || !/^\|(x\|)+$/.test(shape)))) return null;

  // rows and cells; where the \hline stand and what ends each row
  const rows: Tex[][][] = [];
  const ends: (string | null)[] = []; // per row: "" for \\, the space of \\[…], null for none
  const hlines: number[] = [];
  let row: Tex[][] = [];
  let cell: Tex[] = [];
  const empty = () => row.length === 0 && significant(cell).length === 0;
  for (const x of n.body) {
    if (x.k === "cmd" && x.name === "&") {
      row.push(cell);
      cell = [];
    } else if (x.k === "cmd" && x.name === "\\") {
      if (x.star) return null;
      row.push(cell);
      rows.push(row);
      ends.push(x.opt?.trim() ?? "");
      row = [];
      cell = [];
    } else if (x.k === "cmd" && x.name === "hline") {
      if (!empty()) return null;
      hlines.push(rows.length);
    } else if (x.k === "par") return null;
    else cell.push(x);
  }
  if (!empty()) {
    row.push(cell);
    rows.push(row);
    ends.push(null);
  }
  if (!rows.length) return null;

  // spaces after the rows: one for all, or one per row where they differ
  let rowSpace: string | undefined;
  let rowSpaces: string[] | undefined;
  let spaced: string[];
  if (grid) {
    // \hline before the first and after every row, every row ends with \\
    if (hlines.join() !== rows.map((_, i) => i).concat(rows.length).join()) return null;
    if (ends.some((e) => e === null)) return null;
    spaced = ends as string[];
  } else {
    // no \hline; every row but the last ends with \\
    if (hlines.length || ends[ends.length - 1] !== null) return null;
    spaced = ends.slice(0, -1) as string[];
  }
  if (new Set(spaced).size > 1) rowSpaces = grid ? spaced : [...spaced, ""];
  else rowSpace = spaced[0] || undefined;

  // \multicolumn{n}{spec}{content}: one cell over n columns
  const spans: Span[] = [];
  for (let r = 0; r < rows.length; r++) {
    let width = 0;
    for (let i = 0; i < rows[r].length; i++) {
      const sig = significant(rows[r][i]);
      const m = sig.length === 1 && sig[0].k === "cmd" && sig[0].name === "multicolumn" ? sig[0] : null;
      if (!m) {
        width++;
        continue;
      }
      const count = Number(m.args[0]?.raw.trim());
      const s = (m.args[1]?.raw ?? "").replace(/\s+/g, "");
      const a = s.replace(/\|/g, "");
      const want = grid ? `${i === 0 ? "|" : ""}${a}|` : a;
      if (m.args.length !== 3 || !Number.isInteger(count) || count < 1 || !"lcr".includes(a) || a.length !== 1 || s !== want) {
        return null;
      }
      spans.push({ row: r, column: i, columns: count, align: a as Span["align"] });
      rows[r][i] = m.args[2].nodes;
      width += count;
    }
    if (width > columns.length) return null;
  }

  // p{…} columns whose cells all start with \centering or \raggedleft: c{…}, r{…}
  for (let j = 0; j < columns.length; j++) {
    if (!columns[j].startsWith("p{")) continue;
    const cells = rows.filter((r, i) => !spans.some((s) => s.row === i) && j < r.length).map((r) => r[j]);
    const filled = cells.filter((c) => significant(c).length > 0);
    const lead = (c: Tex[]) => {
      const sig = significant(c);
      return sig[0]?.k === "cmd" && (sig[0].name === "centering" || sig[0].name === "raggedleft") ? sig[0].name : null;
    };
    const kind = filled.length ? lead(filled[0]) : null;
    if (!kind || !filled.every((c) => lead(c) === kind)) continue;
    for (const c of filled) {
      // drop the command (and \arraybackslash after it) with the blanks around
      let k = c.findIndex((x) => !isBlank(x)) + 1;
      while (k < c.length && (isBlank(c[k]) || (c[k].k === "cmd" && (c[k] as any).name === "arraybackslash"))) k++;
      c.splice(0, k);
    }
    columns[j] = `${kind === "centering" ? "c" : "r"}${columns[j].slice(1)}`;
  }

  const t: Table = {
    type: "table",
    columns,
    rows: rows.map((r) => r.map((c) => normalizeInline(toInline(c)))),
  };
  if (grid) t.rules = "grid";
  if (compact) t.compact = true;
  if (rowSpace) t.rowSpace = rowSpace;
  if (rowSpaces) t.rowSpaces = rowSpaces;
  if (spans.length) t.spans = spans;
  return t;
}

/** >{…} before p{…}: the alignment it gives */
const PREFIX_ALIGN: Record<string, string> = {
  "": "p",
  "\\raggedright\\arraybackslash": "p",
  "\\centering\\arraybackslash": "c",
  "\\raggedleft\\arraybackslash": "r",
};

/** index of the } closing the { at `open`, -1 if none */
function closingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** column spec with *{n}{…} written out; null if malformed */
function expandSpec(spec: string): string | null {
  for (let i = spec.indexOf("*{"); i >= 0; i = spec.indexOf("*{")) {
    const a = closingBrace(spec, i + 1);
    if (a < 0 || spec[a + 1] !== "{") return null;
    const b = closingBrace(spec, a + 1);
    const n = Number(spec.slice(i + 2, a));
    if (b < 0 || !Number.isInteger(n) || n < 1 || n > 100) return null;
    spec = spec.slice(0, i) + spec.slice(a + 2, b).repeat(n) + spec.slice(b + 1);
  }
  return spec;
}

/** the value of \renewcommand{\arraystretch}{x}, else undefined */
function arrayStretch(x: Tex): string | undefined {
  if (x.k !== "cmd" || x.name !== "renewcommand" || x.star || x.opt !== undefined) return undefined;
  if (x.args[0]?.raw.trim() !== "\\arraystretch") return undefined;
  const v = x.args[1]?.raw.trim() ?? "";
  return /^\d+(\.\d+)?$/.test(v) ? v : undefined;
}

function toTikz(n: Env): Graphic {
  const g: Graphic = { type: "tikz", code: n.raw.replace(/^\s*\n/, "").replace(/\s+$/, "") };
  if (n.opt !== undefined) g.options = n.opt;
  return g;
}

/* ---------- block post-processing ---------- */

function postProcess(list: Pre[]): Block[] {
  let blocks = list.slice();

  // \newpage directly before a section/exercise/task -> newPage flag
  blocks = blocks.filter((b, i) => {
    if (b.type !== "pagebreak") return true;
    const next = blocks[i + 1];
    if (next && (next.type === "section" || next.type === "exercise" || next.type === "task")) {
      next.newPage = true;
      return false;
    }
    return true;
  });

  // A paragraph starting with "(i)", "(2)" … stays a paragraph; the label is its text.
  const out: Block[] = [];

  for (const b0 of blocks as Block[]) {
    let b: Block = b0;

    if (b.type === "paragraph") {
      const c = b.content;
      // a paragraph that is only \emph{...} is a hint
      if (c.length === 1 && typeof c[0] !== "string" && c[0].type === "emph") {
        b = { type: "hint", content: c[0].content };
      }
      // a paragraph that only awards points
      else if (c.every(isPointsInline)) {
        for (const p of c) out.push({ type: "points", value: (p as { value: number }).value });
        continue;
      }
    }

    out.push(b);
  }

  return out;
}

/* ---------- points ---------- */

function sumPoints(x: unknown): number {
  if (Array.isArray(x)) return x.reduce((s: number, y) => s + sumPoints(y), 0);
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (o.type === "points") return o.value as number;
    let s = 0;
    for (const [k, v] of Object.entries(o)) if (k !== "points") s += sumPoints(v);
    return s;
  }
  return 0;
}

function annotatePoints(blocks: Block[]): void {
  for (const b of blocks) {
    if (b.type === "section") annotatePoints(b.content);
    if (b.type === "exercise" || b.type === "task") {
      annotatePoints(b.content);
      const p = sumPoints(b.content.filter((c) => c.type === "task")) + sumPoints(b.solution ?? []);
      if (p > 0) b.points = round(p);
    }
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Achievable maximum: in a section with a choice only the best `select` exercises count. */
export function maxPoints(blocks: Block[]): number {
  let total = 0;
  for (const b of blocks) {
    if (b.type !== "section") {
      total += sumPoints(b);
      continue;
    }
    const exercises = b.content.filter((c) => c.type === "exercise").map(sumPoints).sort((x, y) => y - x);
    const counted = b.choice ? exercises.slice(0, b.choice.select) : exercises;
    total += counted.reduce((s, p) => s + p, 0) + sumPoints(b.content.filter((c) => c.type !== "exercise"));
  }
  return round(total);
}

const NUMBER_WORDS: Record<string, number> = {
  eine: 1, einen: 1, einer: 1, zwei: 2, drei: 3, vier: 4, "fünf": 5, sechs: 6,
  sieben: 7, acht: 8, neun: 9, zehn: 10,
};

// Recognizes German instructions meaning "Select two of the four exercises ..."
const CHOICE_RE = /W(?:ä|ae)hlen Sie (\d+|[a-zäöü]+) (?:der|von den|aus den)? ?(?:insgesamt )?(?:\S+ )?Aufgaben/i;

function detectChoice(s: Section): number | undefined {
  for (const b of s.content) {
    if (b.type === "exercise") break;
    if (b.type !== "paragraph" && b.type !== "hint") continue;
    const text = JSON.stringify(b.content);
    const m = CHOICE_RE.exec(text);
    if (!m) continue;
    const w = m[1].toLowerCase();
    const n = /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w];
    if (n) return n;
  }
  return undefined;
}

function annotateSections(blocks: Block[]): void {
  for (const b of blocks) {
    if (b.type !== "section") continue;
    const select = detectChoice(b);
    const content = b.content;
    delete (b as Partial<Section>).content;
    if (select !== undefined) b.choice = { select };
    const p = maxPoints([{ ...b, content }]);
    if (p > 0) b.points = p;
    b.content = content;
  }
}

/* ---------- document ---------- */

/** \renewcommand that become fields of their own; any other stays in the preamble as written. */
const META_RENEW: Record<string, "pointsName"> = {
  pointsname: "pointsName",
};

/**
 * Names of the document kinds: the one of the document's environment (\testname in a
 * test) is its examName, the others have no effect and stay in the preamble.
 */
const KIND_NAMES = new Set(["examname", "testname", "worksheetname"]);

/** document environments of the edox classes */
const DOC_ENVS = new Set(["exam", "test", "worksheet"]);

function buildExam(tex: string): ExamDoc {
  const top = new Parser(tex).parseAll();
  const doc: ExamDoc = { type: "exam", meta: {}, content: [] };
  const meta = doc.meta;

  let docEnv: Env | undefined;
  const kindNames = new Map<string, Cmd>();
  for (const n of top) {
    if (n.k === "env" && n.name === "document") {
      docEnv = n;
      continue;
    }
    if (n.k !== "cmd") continue;
    if (n.name === "documentclass") {
      meta.documentClass = { name: n.args[0]?.raw.trim() ?? "" };
      if (n.opt !== undefined) meta.documentClass.options = n.opt;
    } else if (n.name === "renewcommand" || n.name === "newcommand" || n.name === "providecommand") {
      const name = (n.args[0]?.raw ?? "").trim().replace(/^\\/, "");
      const body = n.args[1]?.raw ?? "";
      const known = META_RENEW[name];
      if (n.name === "renewcommand" && known) meta[known] = body;
      else if (n.name === "renewcommand" && KIND_NAMES.has(name)) kindNames.set(name, n);
      else if (n.name === "renewcommand") (meta.preamble ??= []).push(n.src);
      else {
        // \newcommand{\x}[n][default]{body}: "o" is read once, second [..] lands in body text
        const m: NonNullable<ExamDoc["meta"]["macros"]>[number] = { name, body };
        if (n.opt !== undefined) m.args = Number(n.opt);
        if (n.name === "providecommand") m.provide = true;
        (meta.macros ??= []).push(m);
      }
    } else {
      (meta.preamble ??= []).push(n.src);
    }
  }

  const exam = (docEnv?.body ?? top).find((n): n is Env => n.k === "env" && DOC_ENVS.has(n.name));
  if (!exam) throw new Error("no \\begin{exam}, \\begin{test} or \\begin{worksheet} found");
  if (exam.name !== "exam") meta.kind = exam.name as "test" | "worksheet";
  for (const [name, n] of kindNames) {
    if (name === `${exam.name}name`) meta.examName = n.args[1]?.raw ?? "";
    else (meta.preamble ??= []).push(n.src);
  }

  // [solution] / [nosolution], also through a macro such as \providecommand{\usesolution}{solution}
  let mode = exam.opt?.trim();
  const macroName = mode && /^\\([A-Za-z@]+)$/.exec(mode)?.[1];
  if (macroName) {
    const macro = meta.macros?.find((m) => m.name === macroName);
    mode = macro?.body.trim();
    // the macro only served the option: not kept
    if (macro) meta.macros = meta.macros!.filter((m) => m !== macro);
    if (meta.macros?.length === 0) delete meta.macros;
  }
  if (mode === "nosolution") meta.solutions = false;

  for (const n of docEnv?.body ?? []) {
    if (isCmd(n, "pdate")) meta.date = n.args[0]?.raw.trim() ?? "";
  }
  if (exam.args[0]) meta.title = inlineOrText(exam.args[0].nodes);

  const pre = toBlocks(exam.body).filter((b) => {
    if (b.type === "setpoints") {
      meta.totalPoints = b.value;
      return false;
    }
    return true;
  });

  // group into sections
  for (const b of postProcess(pre)) {
    const last = doc.content[doc.content.length - 1];
    if (b.type !== "section" && last?.type === "section") last.content.push(b);
    else doc.content.push(b);
  }
  annotatePoints(doc.content);
  annotateSections(doc.content);
  const total = maxPoints(doc.content);
  if (total > 0) doc.points = total;

  return doc;
}

/* =====================================================================
 * Typed model -> generic Node tree
 * ===================================================================== */

const node = (type: string, args: Record<string, any> = {}, children: Node[] = []): Node => ({
  type,
  args,
  children,
});

/** drop undefined/false args so the JSON stays small */
function clean(args: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== false) out[k] = v;
  return out;
}

function inlineNodes(items: Inline[] | string): Node[] {
  if (typeof items === "string") return [node("text", { value: items })];
  return items.map((x): Node => {
    if (typeof x === "string") return node("text", { value: x });
    switch (x.type) {
      case "math":
        return node("math", { tex: x.tex });
      case "strong":
        return node("bold", {}, inlineNodes(x.content));
      case "emph":
        return node("emph", {}, inlineNodes(x.content));
      case "points":
        return node("points", { value: x.value });
      case "linebreak":
        return node("linebreak");
      case "ctrlspace":
        return node("ctrlspace");
      case "raw":
        return node("raw", { tex: x.tex });
    }
  });
}

/** titles: plain string in args.title, otherwise LaTeX source in args.titleTex */
function titleArgs(t: string | Inline[] | undefined): Record<string, any> {
  if (t === undefined) return {};
  if (typeof t === "string") return { title: t };
  return { titleTex: inlineTex(t) };
}

/** inline content back to LaTeX source */
function inlineTex(t: Inline[]): string {
  return t
    .map((x) => {
      if (typeof x === "string") return escapeTex(x);
      switch (x.type) {
        case "math":
          return `$${x.tex}$`;
        case "strong":
          return `\\textbf{${inlineTex(x.content)}}`;
        case "emph":
          return `\\emph{${inlineTex(x.content)}}`;
        case "points":
          return x.value === 1 ? "\\pp" : `\\pp[${x.value}]`;
        case "linebreak":
          return "\\\\";
        case "ctrlspace":
          return "\\ ";
        case "raw":
          return x.tex;
      }
    })
    .join("");
}

function blockNodes(blocks: Block[]): Node[] {
  return blocks.map(blockNode);
}

function blockNode(b: Block): Node {
  switch (b.type) {
    case "paragraph":
      return node("paragraph", {}, inlineNodes(b.content));
    case "hint":
      return node("hint", {}, inlineNodes(b.content));
    case "displaymath":
      return node("displaymath", clean({ tex: b.tex, env: b.env }));
    case "points":
      return node("points", { value: b.value });
    case "figure":
      return node(
        "figure",
        {},
        b.graphics.map((g) => node("tikz", clean({ options: g.options, code: g.code }))),
      );
    case "list":
      return node(
        "list",
        clean({ ordered: b.ordered }),
        b.items.map((i) => node("item", {}, blockNodes(i))),
      );
    case "table":
      return node(
        "table",
        clean({
          columns: b.columns,
          rules: b.rules,
          compact: b.compact,
          rowSpace: b.rowSpace,
          rowSpaces: b.rowSpaces,
          stretch: b.stretch,
          spans: b.spans,
          center: b.center,
          rows: b.rows.map((r) => r.map((c) => inlineNodes(c))),
        }),
      );
    case "answerspace":
      return node("answerspace", { kind: b.kind, height: b.height });
    case "vspace":
      return node("vspace", { size: b.size });
    case "pagebreak": // not before a section/exercise/task (those get newPage): kept as written
      return node("raw", { tex: b.src });
    case "section": {
      const sec = node(
        "section",
        clean({
          command: b.command,
          id: b.id,
          ...titleArgs(b.title),
          newPage: b.newPage,
          choice: b.choice,
          points: b.points,
        }),
      );
      sec.children = blockNodes(b.content);
      return sec;
    }
    case "exercise":
    case "task": {
      const args =
        b.type === "exercise"
          ? clean({ ...titleArgs(b.title), starred: b.starred, newPage: b.newPage })
          : clean({ width: b.width, starred: b.starred, newPage: b.newPage });
      Object.assign(args, clean({ points: b.points }));
      const children = blockNodes(b.content);
      if (b.solution) {
        children.push(node("solution", INLINE.has(b.solution) ? { inline: true } : {}, blockNodes(b.solution)));
      }
      return node(b.type, args, children);
    }
    case "raw":
      return node("raw", { tex: b.tex });
  }
}

/**
 * A flap (edoxflap): title, \sprintplanning, \stations and \sprintretro become args
 * (kind "flap"); everything else is given by the template flap.tex. Throws without \begin{flap}.
 */
export function texToFlap(tex: string): Node {
  const find = (nodes: Tex[]): Env | undefined => {
    for (const n of nodes) {
      if (n.k !== "env") continue;
      if (n.name === "flap") return n;
      const inner = find(n.body);
      if (inner) return inner;
    }
  };
  const flap = find(new Parser(tex).parseAll());
  if (!flap) throw new Error("no \\begin{flap} found");
  const stations: { number: number | string; title: string }[] = [];
  const list = flap.body.find((n): n is Cmd => isCmd(n, "stations"));
  for (const row of list?.args[0]?.nodes ?? []) {
    if (!isCmd(row, "stationrow")) continue;
    const number = row.args[0]?.raw.trim() ?? "";
    const title = inlineOrText(row.args[1]?.nodes ?? []);
    if (typeof title !== "string") throw new Error(`station ${number}: only plain text is supported in the title`);
    stations.push({ number: /^\d+$/.test(number) ? Number(number) : number, title });
  }
  const text = (name: string) => {
    const cmd = flap.body.find((n): n is Cmd => isCmd(n, name));
    if (!cmd) return undefined;
    const t = inlineOrText(cmd.args[0]?.nodes ?? []);
    if (typeof t !== "string") throw new Error(`\\${name}: only plain text is supported`);
    return t;
  };
  return node(
    "exam",
    clean({
      kind: "flap",
      ...titleArgs(inlineOrText(flap.args[0]?.nodes ?? [])),
      planning: text("sprintplanning"),
      stations,
      retro: text("sprintretro"),
    }),
  );
}

/**
 * LaTeX → document. Preamble lines other than \documentclass, \newcommand,
 * \providecommand, \renewcommand\pointsname and the name of the document kind
 * (\examname, \testname or \worksheetname) are not kept
 * (they belong into the templates or the edox classes); pass `ignored` to get them.
 */
export function texToExam(tex: string, ignored?: string[]): Node {
  const doc = buildExam(tex);
  const m = doc.meta;
  ignored?.push(...(m.preamble ?? []));
  return node(
    "exam",
    {
      ...clean({
        documentClass: m.documentClass?.name,
        documentOptions: m.documentClass?.options,
        kind: m.kind,
        examName: m.examName,
        pointsName: m.pointsName,
        macros: m.macros,
        date: m.date,
        ...titleArgs(m.title),
        totalPoints: m.totalPoints,
        points: doc.points,
      }),
      // only false is written; clean() would drop it
      ...(m.solutions === false ? { solutions: false } : {}),
    },
    blockNodes(doc.content),
  );
}
