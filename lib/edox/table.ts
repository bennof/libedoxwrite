// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT

/*
 * Layout of a table node for the templates (TeX and HTML). The node keeps its cells
 * compact in args.rows[row][cell]; a cell spanning columns (\multicolumn) is one
 * entry in its row, args.spans says how many columns it takes.
 *
 * Columns: l, c, r; p{width} (left, wrapped); c{width} and r{width} (centered or
 * right aligned with a fixed width, >{\centering\arraybackslash}p{width} in TeX).
 */
import type { Node } from "./node.ts";

export type Align = "l" | "c" | "r";

/** a cell over several columns: row and cell index in args.rows, number of columns */
export interface Span {
  row: number;
  column: number;
  columns: number;
  align: Align;
}

const ALIGN = { l: "left", c: "center", r: "right" } as const;

/** a column as { align: left|center|right, width or null } */
export function columnInfo(column: string): { align: string; width: string | null } {
  const m = /^([lcrp])(?:\{(.+)\})?$/.exec(column);
  if (!m) return { align: "left", width: null };
  const a = m[1] === "p" ? "l" : (m[1] as Align);
  return { align: ALIGN[a], width: m[2] ?? null };
}

/** a column as written in the column spec of a tabular */
export function texColumn(column: string): string {
  const m = /^([cr])\{(.+)\}$/.exec(column);
  if (!m) return column;
  return `>{${m[1] === "c" ? "\\centering" : "\\raggedleft"}\\arraybackslash}p{${m[2]}}`;
}

/** the column spec of the tabular: |l|c| for grid, @{}lc@{} for compact */
export function tableSpec(args: Record<string, any>): string {
  const cols = (args.columns as string[]).map(texColumn);
  if (args.rules === "grid") return `|${cols.join("|")}|`;
  return args.compact ? `@{}${cols.join("")}@{}` : cols.join("");
}

export interface LayoutCell {
  nodes: Node[];
  align: string;
  width: string | null;
  /** columns of a spanning cell, else null */
  span: number | null;
  /** column spec of \multicolumn, e.g. |c| */
  spanSpec: string | null;
}

/**
 * Rows of the table for the templates: [{ cells, space }]. space is the extra space after
 * the row (\\[space]), "" for none; the last row of a table without rules has no \\.
 */
export function tableLayout(args: Record<string, any>): { cells: LayoutCell[]; space: string }[] {
  const columns = (args.columns as string[]) ?? [];
  const spans = (args.spans as Span[] | undefined) ?? [];
  const rows = (args.rows as Node[][][]) ?? [];
  const grid = args.rules === "grid";
  return rows.map((row, r) => {
    let col = 0;
    const cells = row.map((nodes, i) => {
      const s = spans.find((x) => x.row === r && x.column === i);
      const info = columnInfo(columns[col] ?? "l");
      col += s ? s.columns : 1;
      if (!s) return { nodes, ...info, span: null, spanSpec: null };
      const spec = grid ? `${i === 0 ? "|" : ""}${s.align}|` : s.align;
      return { nodes, align: ALIGN[s.align], width: null, span: s.columns, spanSpec: spec };
    });
    const last = r === rows.length - 1;
    const space = args.rowSpaces?.[r] ?? (grid || !last ? args.rowSpace : undefined) ?? "";
    return { cells, space };
  });
}
