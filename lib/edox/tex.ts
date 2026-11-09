import { tableCells, type Node } from "./node.ts";

/*
 * TeX helpers of the edox document model, shared by the template renderer
 * (renderer/rendertemplate.ts), the HTML renderer and the app.
 */

const TEXT_ESC: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "%": "\\%", "&": "\\&", "_": "\\_", "#": "\\#", "$": "\\$", "{": "\\{", "}": "\\}",
  "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
  "—": "---", "–": "--", " ": "~", " ": "\\,", "€": "\\euro{}", " ": "\\quad{}",
};

/** Plain text → TeX: every special character escaped, dashes and spaces as TeX writes them. */
export const escapeTex = (s: string): string =>
  s.replace(/[\\%&_#${}~^—–  € ]/g, (c) => TEXT_ESC[c]);

/** Blank line (= \par) between two sibling blocks? By node type (and the width of tasks). */
export function defaultPar(a: Node, b: Node): boolean {
  if (a.type === "displaymath" || b.type === "displaymath") return false;
  if (a.type === "vspace" || b.type === "vspace" || b.type === "solution") return false;
  // tasks with a width are boxes side by side: a \par would put each on its own line
  if (a.type === "task" && b.type === "task" && a.args.width != null && b.args.width != null) return false;
  return true;
}

/** Sum of all points nodes below `n`. */
export function sumPoints(n: Node): number {
  if (n.type === "points") return n.args.value ?? 1;
  const cells = tableCells(n).reduce((s, cell) => s + cell.reduce((t, c) => t + sumPoints(c), 0), 0);
  return n.children.reduce((s, c) => s + sumPoints(c), cells);
}

/** Achievable maximum: a section with args.choice counts only its best `select` exercises. */
export function maxPoints(n: Node): number {
  if (n.type !== "section") {
    if (n.type === "exam") return n.children.reduce((s, c) => s + maxPoints(c), 0);
    return sumPoints(n);
  }
  const exercises = n.children.filter((c) => c.type === "exercise").map(sumPoints).sort((a, b) => b - a);
  const counted = n.args.choice ? exercises.slice(0, n.args.choice.select) : exercises;
  const rest = n.children.filter((c) => c.type !== "exercise");
  return counted.reduce((s, p) => s + p, 0) + rest.reduce((s, c) => s + sumPoints(c), 0);
}
