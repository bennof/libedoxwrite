import type { Node } from "../node.ts";
import { defaultPar } from "../tex.ts";

/*
 * Handler-based renderer of the document tree, used by renderhtml.ts.
 *
 * One handler per node type. A handler gets the node and the renderer, which
 * offers render(node), inline(children) and blocks(children). Unknown types fall
 * back to the "*" handler; override or add handlers with renderer.extend({...}).
 */

export type Handler = (n: Node, r: Renderer) => string;
export type Separator = (a: Node, b: Node) => string;

/** Line break or blank line between two sibling blocks. */
const separator: Separator = (a, b) => (defaultPar(a, b) ? "\n\n" : "\n");

export class Renderer {
  readonly handlers: Record<string, Handler>;
  readonly separator: Separator;

  constructor(handlers: Record<string, Handler>, sep: Separator = separator) {
    this.handlers = handlers;
    this.separator = sep;
  }

  extend(overrides: Record<string, Handler>): Renderer {
    return new Renderer({ ...this.handlers, ...overrides }, this.separator);
  }

  render = (n: Node): string => {
    const h = this.handlers[n.type] ?? this.handlers["*"];
    if (!h) throw new Error(`no handler for node type "${n.type}"`);
    return h(n, this);
  };

  /** Inline children, concatenated. */
  inline(nodes: Node[]): string {
    return nodes.map(this.render).join("");
  }

  /** Block children, separated by `separator`. */
  blocks(nodes: Node[]): string {
    let out = "";
    nodes.forEach((n, i) => {
      if (i > 0) out += this.separator(nodes[i - 1], n);
      out += this.render(n);
    });
    return out;
  }
}
