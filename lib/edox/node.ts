/*
 * Generic document tree of an edox document (exam):
 * every element is { type, args, children }.
 * Produced by parser/texparser.ts, rendered by renderer/rendertemplate.ts (TeX, with the
 * templates in templates/) and renderer/renderhtml.ts.
 * The stored form (NodeJson) is described by document.schema.json.
 */
export interface Node {
  type: string;
  args: Record<string, any>;
  children: Node[];
}

/** A node as stored in JSON: empty `args` and `children` are left out. */
export interface NodeJson {
  type: string;
  args?: Record<string, any>;
  children?: NodeJson[];
}

/**
 * A table keeps its cells in args.rows[row][column], each a list of inline nodes;
 * `mapCells` applies `f` to every cell node and returns the new args.
 */
export function mapCells<T, U>(type: string, args: Record<string, any> | undefined, f: (n: T) => U) {
  if (type !== "table" || !Array.isArray(args?.rows)) return args;
  return { ...args, rows: args.rows.map((r: T[][]) => r.map((c) => c.map(f))) };
}

/** The cells of a table (lists of inline nodes), none for other nodes. */
export const tableCells = (n: Node): Node[][] =>
  n.type === "table" && Array.isArray(n.args.rows) ? n.args.rows.flat() : [];

/** For saving: drops empty `args` ({}) and `children` ([]) throughout the tree. */
export function compactNode(node: Node | NodeJson): NodeJson {
  const out: NodeJson = { type: node.type };
  if (node.args && Object.keys(node.args).length > 0) out.args = mapCells(node.type, node.args, compactNode);
  if (node.children && node.children.length > 0) out.children = node.children.map(compactNode);
  return out;
}

/** For loading: adds missing `args` and `children`, so code can rely on both. */
export function normalizeNode(node: NodeJson): Node {
  return {
    type: node.type,
    args: mapCells(node.type, node.args, normalizeNode) ?? {},
    children: (node.children ?? []).map(normalizeNode),
  };
}
