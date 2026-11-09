import { tableCells, type Node } from "../node.ts";
import { Renderer } from "./renderer.ts";

/*
 * Generic JSON tree (see ../parser/texparser.ts) -> HTML.
 *
 * Renderer (renderer.ts) with HTML handlers. Every element carries
 * data-type (and data-* for semantic args) so styling/scripting can hook in.
 * Math stays LaTeX inside \( \) / \[ \] (typeset by KaTeX); TikZ is not
 * rendered yet and becomes <div data-type="tikz" code="...">missing tikz</div>.
 *
 * No styling here: all CSS lives in ../html/style.css. Lengths taken from the
 * document are only handed over as CSS custom properties (--width, --height,
 * --size, --gap).
 */

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** TeX lengths that CSS understands as-is; \hsize/\textwidth fractions become % */
export function cssLength(len: string): string {
  const m = /^([\d.]*)\s*\\(?:hsize|textwidth|linewidth)$/.exec(len.trim());
  if (m) return `${(m[1] === "" ? 1 : Number(m[1])) * 100}%`;
  return len.trim().replace(/^(-?[\d.]+)(pt|cm|mm|em|ex|in)$/, "$1$2");
}

const attrs = (a: Record<string, string | number | boolean | undefined>): string =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${escapeHtml(String(v))}"`))
    .join("");

const title = (n: Node): string => escapeHtml(n.args.title ?? n.args.titleTex ?? "");

/** style="--name: value" for lengths from the document */
export const vars = (v: Record<string, string | undefined>): string | undefined => {
  const s = Object.entries(v)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) => `--${k}: ${cssLength(x!)}`)
    .join("; ");
  return s || undefined;
};

/* ---------- form field names (must match the PDF) ----------
 *
 * points-<exercise>-<subexercise>-<position>
 *   exercise:    running number of \exercise over the whole exam (1, 2, ...)
 *   subexercise: number of the \subexercise within the exercise, 0 outside one
 *   position:    running per subexercise; +1 per checkbox, +1 per text field
 * Sum-Points-<exercise>, Name, SumPointsTotal, Grade, CheckDate (date of correction),
 * Signature (name of the teacher; only when the document does not set \sign itself)
 */

const FIELDS = new WeakMap<Node, string[]>();
const EXERCISE_NO = new WeakMap<Node, number>();
const TASK_NO = new WeakMap<Node, number>();

/** a \pp with up to 3 points is one checkbox per point, otherwise one text field */
const isCheckboxes = (v: number): boolean => Number.isInteger(v) && v <= 3;

/** Field names of a points node (after assignFieldNames): one per checkbox, or one text field. */
export const fieldNames = (n: Node): string[] => FIELDS.get(n) ?? [];
/** Running number of an exercise (after assignFieldNames). */
export const exerciseNumber = (n: Node): number | undefined => EXERCISE_NO.get(n);

/**
 * Label of a subexercise as the class prints it: "a)", "b)", … counted per exercise,
 * starred ones included (they count, but show no label). After assignFieldNames.
 */
export function taskLabel(n: Node): string | undefined {
  const no = TASK_NO.get(n);
  if (no === undefined) return undefined;
  let s = "";
  for (let k = no; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
  return `${s})`;
}

export function assignFieldNames(doc: Node): void {
  let exercise = 0;
  const walk = (n: Node, ctx: { e: number; t: number; pos: { k: number } } | null): void => {
    if (n.type === "exercise") {
      EXERCISE_NO.set(n, ++exercise);
      let task = 0;
      const own = { e: exercise, t: 0, pos: { k: 0 } };
      for (const c of n.children) {
        if (c.type === "task") {
          TASK_NO.set(c, ++task);
          walk(c, { e: exercise, t: task, pos: { k: 0 } });
        }
        else walk(c, own);
      }
      return;
    }
    if (n.type === "points" && ctx) {
      const v: number = n.args.value ?? 1;
      const count = isCheckboxes(v) ? v : 1;
      FIELDS.set(n, Array.from({ length: count }, () => `points-${ctx.e}-${ctx.t}-${++ctx.pos.k}`));
      return;
    }
    // table cells row by row, as TeX meets their \pp
    for (const cell of tableCells(n)) for (const c of cell) walk(c, ctx);
    for (const c of n.children) walk(c, ctx);
  };
  walk(doc, null);
}

/* ---------- grading scale (defaults of edoxarticle, \renewcommand overrides) ---------- */

const GRADE_DEFAULTS: Record<string, string> = {
  edoxgradeslabels: "1+,1,1-,2+,2,2-,3+,3,3-,4+,4,4-,5+,5,5-,6",
  edoxgradesindices: "15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0",
  edoxgradespercentages: "95,90,85,80,75,70,65,60,55,50,45,40,33,27,20,0",
};

/** `\renewcommand\name{body}` and `\renewcommand{\name}{body}` of the preamble: name → body. */
export function renewedCommands(doc: Node): Record<string, string> {
  const renewed: Record<string, string> = {};
  for (const line of doc.args.preamble ?? []) {
    const m = /^\\renewcommand\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))\s*\{([\s\S]*)\}\s*$/.exec(line);
    if (m) renewed[m[1] ?? m[2]] = m[3];
  }
  return renewed;
}

export function gradeScale(doc: Node): Record<string, string> {
  const custom: Record<string, string> = renewedCommands(doc);
  for (const m of doc.args.macros ?? []) custom[m.name] = m.body;
  const get = (k: string) => (custom[k] ?? GRADE_DEFAULTS[k]).replace(/\s+/g, "");
  return {
    "data-grade-labels": get("edoxgradeslabels"),
    "data-grade-indices": get("edoxgradesindices"),
    "data-grade-percentages": get("edoxgradespercentages"),
  };
}

const field = (type: "checkbox" | "text", name: string | undefined, extra = ""): string =>
  type === "checkbox"
    ? `<input type="checkbox"${attrs({ id: name, name })}${extra}>`
    : `<input type="text"${attrs({ id: name, name })}${extra}>`;

export const htmlRenderer = new Renderer(
  {
    exam: (n, r) => {
      const a = n.args;
      const sign = renewedCommands(n).sign;
      const head = [
        a.examName && `<span data-type="examname">${escapeHtml(a.examName)}</span>`,
        a.title && `<h1>${title(n)}</h1>`,
        a.date && `<span data-type="date">${escapeHtml(a.date)}</span>`,
        sign && `<span data-type="signature">${escapeHtml(sign)}</span>`,
      ].filter(Boolean);
      head.push(r.render({ type: "namefield", args: {}, children: [] }));
      const grading = [
        `<label data-type="total">Summe ${field("text", "SumPointsTotal", ' inputmode="decimal" size="3"')}` +
          `${a.totalPoints ?? a.points ? `<span data-type="max">/${a.totalPoints ?? a.points}</span>` : ""}</label>`,
        `<label data-type="grade">Note ${field("text", "Grade", ' size="28"')}</label>`,
        `<label data-type="checkdate">Datum ${field("text", "CheckDate")}</label>`,
        // the class sets a form field Signature where \sign is not defined
        sign === undefined && `<label data-type="signature">Lehrkraft ${field("text", "Signature")}</label>`,
        r.render({ type: "actions", args: {}, children: [] }),
      ].filter(Boolean);
      return (
        `<form id="exam-form" autocomplete="off">\n` +
        `<article${attrs({
          "data-type": "exam",
          "data-points": a.totalPoints ?? a.points,
          "data-exam-name": a.examName,
          "data-title": a.title,
          "data-date": a.date,
          ...gradeScale(n),
        })}>\n` +
        `<header>\n${head.join("\n")}\n</header>\n${r.blocks(n.children)}\n` +
        `<footer data-type="grading">\n${grading.join("\n")}\n</footer>\n</article>\n</form>`
      );
    },

    // page chrome, replaced by the app (src/apps/assess/lib/exam.js) via htmlRenderer.extend
    namefield: () => `<label data-type="name">Name ${field("text", "Name")}</label>`,
    actions: () =>
      `<span data-type="actions">` +
      `<button type="button" data-action="download">JSON herunterladen</button>` +
      `<button type="button" data-action="load">JSON laden</button>` +
      `<input type="file" accept="application/json,.json" data-action="load-file" hidden>` +
      `</span>`,

    section: (n, r) =>
      `<section${attrs({
        "data-type": "section",
        "data-id": n.args.id,
        "data-select": n.args.choice?.select,
        "data-points": n.args.points,
        "data-new-page": n.args.newPage,
      })}>\n<h2>${title(n)}</h2>\n${r.blocks(n.children)}\n</section>`,

    exercise: (n, r) => {
      const no = EXERCISE_NO.get(n);
      const sum =
        no === undefined
          ? ""
          : `\n<label data-type="sum">${field("text", `Sum-Points-${no}`, ' inputmode="decimal" size="2"')}` +
            `${n.args.points ? `<span data-type="max">/${n.args.points}</span>` : ""}</label>`;
      return (
        `<div${attrs({
          "data-type": "exercise",
          "data-number": no,
          "data-starred": n.args.starred,
          "data-points": n.args.points,
          "data-new-page": n.args.newPage,
        })}>\n` +
        (n.args.title !== undefined || n.args.titleTex !== undefined ? `<h3>${title(n)}</h3>\n` : "") +
        `${r.blocks(n.children)}${sum}\n</div>`
      );
    },

    task: (n, r) =>
      `<div${attrs({
        "data-type": "task",
        "data-starred": n.args.starred,
        "data-points": n.args.points,
        "data-new-page": n.args.newPage,
        "data-width": n.args.width !== undefined,
        style: vars({ width: n.args.width }),
      })}>\n${!n.args.starred && taskLabel(n) ? `<span data-type="label">${taskLabel(n)}</span>\n` : ""}${r.blocks(n.children)}\n</div>`,

    solution: (n, r) => `<div data-type="solution">\n${r.blocks(n.children)}\n</div>`,

    part: (n, r) => {
      const [first, ...rest] = n.children;
      const label = `<span data-type="label">${escapeHtml(n.args.label)}</span>`;
      const head = first?.type === "paragraph" ? `<p>${label} ${r.inline(first.children)}</p>` : `<p>${label}</p>`;
      const body = first?.type === "paragraph" ? rest : n.children;
      return `<div${attrs({ "data-type": "part", "data-label": n.args.label })}>\n${[head, ...body.map(r.render)].join("\n")}\n</div>`;
    },

    paragraph: (n, r) => `<p>${r.inline(n.children)}</p>`,
    hint: (n, r) => `<p data-type="hint"><em>${r.inline(n.children)}</em></p>`,
    heading: (n, r) => `<h2 data-type="heading">${r.inline(n.children)}</h2>`,

    displaymath: (n) =>
      n.args.env
        ? `<div data-type="displaymath">\\begin{${n.args.env}}${escapeHtml(n.args.tex)}\\end{${n.args.env}}</div>`
        : `<div data-type="displaymath">\\[${escapeHtml(n.args.tex)}\\]</div>`,

    // up to 3 points: one checkbox per point, otherwise a small text field
    points: (n) => {
      const v: number = n.args.value ?? 1;
      const names = FIELDS.get(n) ?? [];
      const inner = isCheckboxes(v)
        ? Array.from({ length: v }, (_, i) => field("checkbox", names[i])).join("")
        : field("text", names[0], ` inputmode="decimal" size="2"${attrs({ "data-max": v })}`) +
          `<span data-type="max">/${v}</span>`;
      return `<span${attrs({ "data-type": "points", "data-value": v })}>${inner}</span>`;
    },

    figure: (n, r) => `<figure data-type="figure">\n${n.children.map(r.render).join("\n")}\n</figure>`,
    tikz: (n) => `<div${attrs({ "data-type": "tikz", code: n.args.code, options: n.args.options })}> missing tikz </div>`,

    list: (n, r) => {
      const tag = n.args.ordered ? "ol" : "ul";
      return `<${tag}>\n${n.children.map(r.render).join("\n")}\n</${tag}>`;
    },
    item: (n, r) => `<li>${r.blocks(n.children)}</li>`,
    center: (n, r) => `<div data-type="center">\n${r.blocks(n.children)}\n</div>`,

    signatureline: (n) =>
      `<div${attrs({ "data-type": "signatureline", style: vars({ gap: n.args.gap }) })}>` +
      `<span data-type="label">${escapeHtml(n.args.label)}</span><span data-type="line"></span></div>`,
    spread: (n, r) => `<div data-type="spread">\n${n.children.map(r.render).join("\n")}\n</div>`,
    cell: (n, r) => `<span>${r.inline(n.children)}</span>`,

    answerspace: (n) =>
      `<div${attrs({ "data-type": "answerspace", "data-kind": n.args.kind, style: vars({ height: n.args.height }) })}></div>`,
    vspace: (n) => `<div${attrs({ "data-type": "vspace", style: vars({ size: n.args.size }) })}></div>`,
    pagebreak: () => `<div data-type="pagebreak"></div>`,

    text: (n) => escapeHtml(n.args.value),
    math: (n) => `<span data-type="math">\\(${escapeHtml(n.args.tex)}\\)</span>`,
    bold: (n, r) => `<strong>${r.inline(n.children)}</strong>`,
    emph: (n, r) => `<em>${r.inline(n.children)}</em>`,
    underline: (n, r) => `<u>${r.inline(n.children)}</u>`,
    blank: (n) => `<span${attrs({ "data-type": "blank", "data-style": n.args.style, style: vars({ width: n.args.width }) })}></span>`,
    linebreak: () => "<br>",
    ctrlspace: () => " ",
    strut: () => "",
    raw: (n) => `<code${attrs({ "data-type": "raw" })}>${escapeHtml(n.args.tex)}</code>`,

    // unknown/custom node types
    "*": (n, r) => `<div${attrs({ "data-type": n.type })}>${r.blocks(n.children)}</div>`,
  },
  () => "\n",
);

export function renderHtml(doc: Node, renderer: Renderer = htmlRenderer): string {
  assignFieldNames(doc);
  return renderer.render(doc);
}

export const KATEX = "https://cdn.jsdelivr.net/npm/katex@0.19.0/dist";

/** KaTeX macros of an exam: its \newcommand definitions plus \euro (not known to KaTeX) */
export function katexMacros(doc: Node): Record<string, string> {
  const macros: Record<string, string> = { "\\euro": "\\text{€}" };
  for (const m of doc.args.macros ?? []) macros["\\" + m.name] = m.body;
  return macros;
}

/** Options for KaTeX's auto-render on a standalone page. */
export function katexOptions(doc: Node) {
  return {
    delimiters: [
      { left: "\\[", right: "\\]", display: true },
      { left: "\\(", right: "\\)", display: false },
    ],
    macros: katexMacros(doc),
    throwOnError: false,
    strict: "ignore",
  };
}

/**
 * Standalone page: rendered exam, linked style sheet and script, KaTeX with the exam's \newcommand macros.
 * Write the companion files next to it, see ../html/standalone.ts (companionFiles, classicScript).
 */
export function renderHtmlDocument(
  doc: Node,
  {
    renderer = htmlRenderer,
    stylesheet = "style.css",
    script = "grading.js",
  }: { renderer?: Renderer; stylesheet?: string; script?: string } = {},
): string {
  const katex = katexOptions(doc);
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml([doc.args.examName, doc.args.title].filter(Boolean).join(" – "))}</title>
<link rel="stylesheet" href="${escapeHtml(stylesheet)}">
<script defer src="${escapeHtml(script)}"></script>
<link rel="stylesheet" href="${KATEX}/katex.min.css">
<script>window.katexOptions = ${JSON.stringify(katex).replace(/</g, "\\u003c")};</script>
<script defer src="${KATEX}/katex.min.js"></script>
<script defer src="${KATEX}/contrib/auto-render.min.js" onload="renderMathInElement(document.body, window.katexOptions)"></script>
</head>
<body>
${renderHtml(doc, renderer)}
</body>
</html>
`;
}
