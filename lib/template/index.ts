// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT

// Template engine with Tera-like syntax, working like TeX: a tokenizer turns each
// template into tokens once, an expansion machine with an explicit input stack
// executes them. Only expressions get a small parser of their own.
//
// Tags, with o = openDelimiter and c = closeDelimiter (o must not be `%` or `#`):
//   o o … c c   output       {{ … }}
//   o % … % c   statement    {% … %}
//   o # … # c   comment      {# … #}
//
// Whitespace in template text is normalized by the tokenizer, as TeX does:
// spaces and tabs collapse to one space, a single newline stays a newline
// (without indentation), two or more newlines become one blank line (a paragraph).
// A line holding only a statement or comment vanishes with its newline.
// Values inserted by `{{ … }}` and the content of `raw` stay unchanged.
// `whitespace: "keep"` switches the normalization off.
//
// Components: defined with `{% component ui.img(src: string, width: integer = 800) %}`
// … `{% endcomponent %}`, called as a whole tag, `{{ ui.img(src="a") }}`, or with a
// body, `{% call ui.box(title="t") %} … {% endcall %}`, which the component places
// with `{{ body }}`. A component sees only its parameters and its body.
//
// Inheritance: `{% extends "base" %}` and `{% block name %}`; inside a block,
// `{{ super() }}` renders the same block one template further up.

import { defaultFilters, defaultFunctions } from "./defaults.ts";
import { PARAMETER_TYPES, tokenize } from "./tokenize.ts";

export { tokenize };

type TemplateSource = string;

/** Named arguments, as in Tera: `default(value="")`. */
type Args = Record<string, unknown>;

/**
 * `safe`: the result is finished HTML or TeX and is not escaped again, as
 * `is_safe` in Tera. The filter `safe` marks a single value the same way.
 */
export type Filter = ((value: unknown, args: Args) => unknown) & { safe?: boolean };

export type TemplateFunction = ((args: Args) => unknown) & { safe?: boolean };

/**
 * Escapes the output of `{{ … }}`, never the template text. Optional.
 * HTML: only `& < > " '`; the encoding is UTF-8, so `ä`, `ö`, … stay as they are.
 * TeX: only `& % # _`; `$ \ { }` stay, values may contain formulas.
 */
export type Escape = (text: string) => string;

/**
 * Each field is exclusive: given, it replaces the default completely (no merging);
 * left out, the default applies. `filters: {}` thus starts without any filter.
 * Defaults: `{` `}`, no templates, `defaultFilters`, `defaultFunctions`,
 * no escaping, no globals, `"collapse"`, depth 256.
 */
export interface TemplateConfig {
  /** Outer characters of a tag; `{` `}` gives `{{ }}`, `{% %}`, `{# #}`. */
  openDelimiter?: string;
  closeDelimiter?: string;
  /** Already tokenized, see `tokenize`; the constructor parses nothing. */
  templates?: Record<string, Template>;

  filters?: Record<string, Filter>;
  functions?: Record<string, TemplateFunction>;
  escape?: Escape;

  globals?: Record<string, unknown>;

  /** Default `"collapse"`, see above. */
  whitespace?: "collapse" | "keep";
  /** Maximum depth of the input stack; deeper expansion is an error. Default 256. */
  maxDepth?: number;
  /**
   * Resolves `{{ glue() }}` after rendering: gets up to GLUE_CONTEXT characters of
   * the output before and after the mark and returns what goes in between. For
   * TeX, e.g. a space after a control word before a letter. Without it, marks vanish.
   */
  glue?: (before: string, after: string) => string;
}

/** Characters of output on each side that `glue` gets to see. */
export const GLUE_CONTEXT = 256;

/** Mark for `{{ glue() }}` in the output, resolved at the end of `render`. */
const GLUE = Symbol("glue");

export type Position = { line: number; column: number };

/**
 * Errors are queued and rendering goes on after the faulty element, as in TeX;
 * the element itself gives no output. Examples: unknown variable, filter or
 * template, a component argument of the wrong type, the stack too deep.
 * Warnings and infos give output as usual, e.g. a component that replaces one
 * of the same name from another template.
 */
export type TemplateError = {
  type: "info" | "warning" | "error";
  template: string;
  pos: Position;
  message: string;
};

export type RenderResult = {
  output: string;
  /** In order of occurrence, oldest first. */
  errors: TemplateError[];
};

/**
 * Returned by a function to have the engine call a component, e.g. one chosen
 * by the type of a node: `{{ render(node=c) }}`. The engine makes the call like
 * `{{ name(…) }}`, through its stack; only allowed as a whole tag.
 */
export class ComponentCall {
  readonly name: string;
  readonly args: Record<string, unknown>;

  constructor(name: string, args: Record<string, unknown>) {
    this.name = name;
    this.args = args;
  }
}

export function componentCall(name: string, args: Record<string, unknown>): ComponentCall {
  return new ComponentCall(name, args);
}

/** True if the list holds at least one error. */
export function hasError(errors: TemplateError[]): boolean {
  return errors.some((error) => error.type === "error");
}

/** True if the list holds at least one error or warning. */
export function hasWarning(errors: TemplateError[]): boolean {
  return errors.some((error) => error.type === "error" || error.type === "warning");
}

// ------------------------------------------------------------
// Expressions (parsed once by the tokenizer)
// ------------------------------------------------------------

export type BinaryOperator =
  | "or" | "and"
  | "==" | "!=" | "<" | "<=" | ">" | ">="
  | "in"
  | "+" | "-" | "*" | "/" | "%"
  | "~";

export type Expression = { pos: Position } & (
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "array"; items: Expression[] }
  /** `node.args.title` → `["node", "args", "title"]` */
  | { type: "path"; path: string[] }
  | { type: "unary"; operator: "not" | "-"; operand: Expression }
  | { type: "binary"; operator: BinaryOperator; left: Expression; right: Expression }
  | { type: "filter"; name: string; input: Expression; args: Record<string, Expression> }
  | { type: "call"; name: string; args: Record<string, Expression> }
);

// ------------------------------------------------------------
// Tokens
// ------------------------------------------------------------

/**
 * `type` is checked when the component is called: string, integer, number,
 * boolean, array, object or any; only any accepts null. Without a type: any.
 */
export type ComponentParameter = {
  name: string;
  type?: string;
  default?: Expression;
};

/**
 * Comments are dropped by the tokenizer; `raw … endraw` becomes a `text` token.
 * Statements are flat: `if` … `endif` are separate tokens, matched while expanding
 * by counting nesting, like `\if` … `\fi` in TeX.
 */
export type Token = { pos: Position } & (
  | { type: "text"; value: string }
  | { type: "output"; expression: Expression }
  | { type: "if"; test: Expression }
  | { type: "elif"; test: Expression }
  | { type: "else" }
  | { type: "endif" }
  | { type: "for"; key?: string; value: string; iterable: Expression }
  | { type: "endfor" }
  | { type: "set"; name: string; value: Expression }
  | { type: "include"; name: string }
  | { type: "extends"; name: string }
  | { type: "block"; name: string }
  | { type: "endblock"; name?: string }
  | { type: "component"; name: string; parameters: ComponentParameter[] }
  | { type: "endcomponent"; name?: string }
  /** `{% call ui.box(title="…") %} … {% endcall %}`: a component call with a body. */
  | { type: "call"; name: string; args: Record<string, Expression> }
  | { type: "endcall"; name?: string }
);

export type Template = {
  name: string;
  source: string;
  tokens: Token[];
  /** Components defined in the template, found by `tokenize`. */
  components: Component[];
};

/** A component is a macro: parameters and the tokens of its body. */
export type Component = {
  name: string;
  parameters: ComponentParameter[];
  body: Token[];
  template: string;
  /** Where the component is defined in its template. */
  pos: Position;
};

// ------------------------------------------------------------
// Expansion
// ------------------------------------------------------------

/** Variables; lookup walks up the parents. */
type Scope = { vars: Map<string, unknown>; parent?: Scope };

/** A block body that replaces the block of the same name in a parent template. */
type BlockDefinition = {
  template: string;
  tokens: Token[];
  /** The same block one template further up; what `{{ super() }}` renders. */
  parent?: BlockDefinition;
};

/** The body of a `call`: rendered where the component writes `{{ body }}`, in the caller's world. */
type Body = {
  template: string;
  tokens: Token[];
  scope: Scope;
  blocks: Map<string, BlockDefinition>;
  body?: Body;
  block?: BlockDefinition;
};

/** One entry of the input stack: tokens being read and their scope. */
type Frame = {
  template: string;
  tokens: Token[];
  index: number;
  scope: Scope;
  /** Block overrides from the templates that extend this one. */
  blocks: Map<string, BlockDefinition>;
  /** `if`s opened in this frame and not yet closed. */
  conditionals: number;
  /** What `{{ body }}` renders inside a component. */
  body?: Body;
  /** The block override being rendered, for `{{ super() }}`. */
  block?: BlockDefinition;
  /** Set while the frame is the body of a `for`. */
  loop?: {
    key?: string;
    value: string;
    entries: [unknown, unknown][];
    index: number;
    /** Scope around the loop; each pass gets a fresh child of it. */
    outer: Scope;
  };
};

const OPENERS = new Set(["if", "for", "block", "component", "call"]);
const CLOSERS = new Set(["endif", "endfor", "endblock", "endcomponent", "endcall"]);


/**
 * Index of the first token from `start` on, at nesting depth 0, whose type is
 * in `stop`; -1 if there is none.
 */
function find(tokens: Token[], start: number, stop: string[]): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const type = tokens[i].type;
    if (depth === 0 && stop.includes(type)) return i;
    if (OPENERS.has(type)) depth++;
    else if (CLOSERS.has(type)) depth--;
    if (depth < 0) return -1;
  }
  return -1;
}

function lookup(scope: Scope, name: string): unknown {
  for (let s: Scope | undefined = scope; s; s = s.parent) {
    if (s.vars.has(name)) return s.vars.get(name);
  }
  return undefined;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** As in Tera: false, 0, "", null, undefined, empty arrays and objects are false. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function expectNumber(value: unknown, operator: string): number {
  if (typeof value === "number") return value;
  throw new Error(`${operator}: expected a number, got ${typeName(value)}`);
}

function describe(expression: Expression): string {
  if (expression.type === "path") return expression.path.join(".");
  if (expression.type === "filter") return `${describe(expression.input)} | ${expression.name}`;
  if (expression.type === "call") return `${expression.name}()`;
  return "expression";
}

/** Options that change how a template is tokenized. */
export type TokenizeOptions = Pick<TemplateConfig, "openDelimiter" | "closeDelimiter" | "whitespace">;

/** One character, not `%`, `#`, `-` or whitespace. Wrong delimiters are a programming error. */
function checkDelimiter(delimiter: string, name: string): string {
  if (Array.from(delimiter).length !== 1 || /[%#\-\s]/u.test(delimiter)) {
    throw new Error(`${name}: one character, not %, #, - or whitespace, got "${delimiter}"`);
  }
  return delimiter;
}

export class TemplateEngine {
  private openDelimiter: string;
  private closeDelimiter: string;
  private templates = new Map<string, Template>();
  /** Collected from the templates. */
  private components = new Map<string, Component>();

  private filters: Map<string, Filter>;
  private functions: Map<string, TemplateFunction>;
  private escape?: Escape;
  private globals: Map<string, unknown>;

  private whitespace: "collapse" | "keep";
  private maxDepth: number;
  private glue?: (before: string, after: string) => string;

  /** Parses nothing and cannot fail on templates; see `TemplateConfig` for the rules. */
  constructor(config: TemplateConfig = {}) {
    this.openDelimiter = checkDelimiter(config.openDelimiter ?? "{", "openDelimiter");
    this.closeDelimiter = checkDelimiter(config.closeDelimiter ?? "}", "closeDelimiter");
    if (this.openDelimiter === this.closeDelimiter) {
      throw new Error(`openDelimiter and closeDelimiter must differ, both are "${this.openDelimiter}"`);
    }

    for (const [name, template] of Object.entries(config.templates ?? {})) {
      this.templates.set(name, template);
      for (const component of template.components) this.components.set(component.name, component);
    }

    // Own maps, so changes to this engine do not reach the config or a clone.
    this.filters = new Map(Object.entries(config.filters ?? defaultFilters));
    this.functions = new Map(Object.entries(config.functions ?? defaultFunctions));
    this.escape = config.escape;
    this.globals = new Map(Object.entries(config.globals ?? {}));

    this.whitespace = config.whitespace ?? "collapse";
    this.maxDepth = config.maxDepth ?? 256;
    this.glue = config.glue;
  }

  clone(): TemplateEngine {
    return new TemplateEngine({
      openDelimiter: this.openDelimiter,
      closeDelimiter: this.closeDelimiter,
      templates: Object.fromEntries(this.templates),
      filters: Object.fromEntries(this.filters),
      functions: Object.fromEntries(this.functions),
      escape: this.escape,
      // Deep copy, so objects in globals are not shared with the clone.
      globals: structuredClone(Object.fromEntries(this.globals)),
      whitespace: this.whitespace,
      maxDepth: this.maxDepth,
      glue: this.glue,
    });
  }

  /**
   * Tokenizes the template with this engine's options, adds it and returns the
   * errors, oldest first; empty means success.
   */
  addTemplate(name: string, source: TemplateSource): TemplateError[] {
    const { template, errors } = tokenize(name, source, {
      openDelimiter: this.openDelimiter,
      closeDelimiter: this.closeDelimiter,
      whitespace: this.whitespace,
    });
    // A replaced template takes its components with it.
    for (const [key, component] of this.components) {
      if (component.template === name) this.components.delete(key);
    }
    this.templates.set(name, template);
    for (const component of template.components) {
      const replaced = this.components.get(component.name);
      if (replaced) {
        errors.push({
          type: "warning",
          template: name,
          pos: component.pos,
          message: `component ${component.name} replaces the one from template ${replaced.template}`,
        });
      }
      this.components.set(component.name, component);
    }
    return errors;
  }

  hasComponent(name: string): boolean {
    return this.components.has(name);
  }

  /** Adds or replaces a filter; `null` removes it. */
  addFilter(name: string, filter: Filter | null) {
    if (filter === null) this.filters.delete(name);
    else this.filters.set(name, filter);
  }

  /** Adds or replaces a function. */
  addFunction(name: string, fn: TemplateFunction) {
    this.functions.set(name, fn);
  }

  /** Adds or replaces a global; it must survive `structuredClone` for `clone()`. */
  addGlobal(name: string, value: unknown) {
    this.globals.set(name, value);
  }

  /**
   * Renders template `name`. Lookup order for variables: `set` and loop variables,
   * then `context`, then the globals.
   */
  render(name: string, context: Record<string, unknown>): RenderResult {
    const output: (string | typeof GLUE)[] = [];
    const errors: TemplateError[] = [];
    const stack: Frame[] = [];
    const error = (template: string, pos: Position, message: string) =>
      errors.push({ type: "error", template, pos, message });

    const template = this.templates.get(name);
    if (!template) {
      error(name, { line: 0, column: 0 }, `unknown template ${name}`);
      return { output: "", errors };
    }
    const globals: Scope = { vars: new Map(this.globals) };
    const root: Scope = { vars: new Map(Object.entries(context)), parent: globals };
    this.enter(stack, template, root, new Map(), errors, { line: 0, column: 0 });

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];

      if (frame.index >= frame.tokens.length) {
        const loop = frame.loop;
        if (loop && ++loop.index < loop.entries.length) {
          frame.index = 0;
          frame.conditionals = 0;
          frame.scope = this.loopScope(loop);
          continue;
        }
        if (frame.conditionals > 0) {
          error(frame.template, frame.tokens[frame.tokens.length - 1]?.pos ?? { line: 0, column: 0 }, "missing endif");
        }
        stack.pop();
        continue;
      }

      const token = frame.tokens[frame.index++];
      const fail = (message: string) => error(frame.template, token.pos, message);
      /** Skips to the token after the one at nesting depth 0 whose type is in `stop`. */
      const skipTo = (stop: string[], what: string): Token | undefined => {
        const end = find(frame.tokens, frame.index, stop);
        if (end < 0) {
          fail(`missing ${what}`);
          frame.index = frame.tokens.length;
          return undefined;
        }
        frame.index = end + 1;
        return frame.tokens[end];
      };

      switch (token.type) {
        case "text":
          output.push(token.value);
          break;

        case "output": {
          const expression = token.expression;
          // `{{ body }}` inside a component: the caller's body, rendered in its world.
          if (expression.type === "path" && expression.path.length === 1 && expression.path[0] === "body" && frame.body) {
            const body = frame.body;
            if (!this.checkDepth(stack, frame.template, token.pos, errors)) break;
            stack.push({
              template: body.template, tokens: body.tokens, index: 0, scope: body.scope,
              blocks: body.blocks, conditionals: 0, body: body.body, block: body.block,
            });
            break;
          }
          if (expression.type === "call" && expression.name === "glue") {
            output.push(GLUE);
            break;
          }
          // `{{ super() }}` inside a block override: the same block one template up.
          if (expression.type === "call" && expression.name === "super") {
            const parent = frame.block?.parent;
            if (!frame.block) fail("super() outside a block of a template that extends another");
            else if (!parent) fail("super(): the block has no content further up");
            else if (this.checkDepth(stack, frame.template, token.pos, errors)) {
              stack.push({ ...this.frame(frame, parent.tokens, frame.scope), template: parent.template, block: parent });
            }
            break;
          }
          if (expression.type === "call" && this.components.has(expression.name)) {
            const args = expression.args;
            this.callComponent(stack, frame, expression.name, () => this.evaluateArgs(args, frame.scope), undefined, token.pos, errors);
            break;
          }
          try {
            const value = this.evaluate(expression, frame.scope);
            if (value instanceof ComponentCall && expression.type === "call") {
              this.callComponent(stack, frame, value.name, () => value.args, undefined, token.pos, errors);
              break;
            }
            if (value === undefined) throw new Error(`${describe(expression)} is undefined`);
            const text = this.toText(value);
            output.push(this.escape && !this.isSafe(expression) ? this.escape(text) : text);
          } catch (e) {
            fail((e as Error).message);
          }
          break;
        }

        case "if": {
          frame.conditionals++;
          let test: Expression | undefined = token.test;
          // Look for the branch to take, as TeX skips to \else or \fi.
          while (test) {
            let taken: boolean;
            try {
              taken = truthy(this.evaluate(test, frame.scope));
            } catch (e) {
              fail((e as Error).message);
              frame.conditionals--;
              skipTo(["endif"], "endif");
              break;
            }
            if (taken) break;
            const next = skipTo(["elif", "else", "endif"], "endif");
            if (!next || next.type === "endif") {
              frame.conditionals--;
              break;
            }
            test = next.type === "elif" ? next.test : undefined;
          }
          break;
        }

        // Reached at the end of a taken branch: the rest of the `if` is skipped.
        case "elif":
        case "else":
          if (frame.conditionals === 0) {
            fail(`${token.type} without if`);
            break;
          }
          frame.conditionals--;
          skipTo(["endif"], "endif");
          break;

        case "endif":
          if (frame.conditionals === 0) fail("endif without if");
          else frame.conditionals--;
          break;

        case "for": {
          const start = frame.index;
          const end = find(frame.tokens, start, ["endfor"]);
          if (end < 0) {
            fail("missing endfor");
            frame.index = frame.tokens.length;
            break;
          }
          frame.index = end + 1;
          const elseAt = find(frame.tokens.slice(0, end), start, ["else"]);
          const body = frame.tokens.slice(start, elseAt < 0 ? end : elseAt);
          const otherwise = elseAt < 0 ? [] : frame.tokens.slice(elseAt + 1, end);

          let entries: [unknown, unknown][];
          try {
            entries = this.entries(this.evaluate(token.iterable, frame.scope), describe(token.iterable));
          } catch (e) {
            fail((e as Error).message);
            break;
          }
          if (!this.checkDepth(stack, frame.template, token.pos, errors)) break;
          if (entries.length === 0) {
            if (otherwise.length > 0) stack.push(this.frame(frame, otherwise, { vars: new Map(), parent: frame.scope }));
            break;
          }
          const loop = { key: token.key, value: token.value, entries, index: 0, outer: frame.scope };
          stack.push({ ...this.frame(frame, body, this.loopScope(loop)), loop });
          break;
        }

        case "set":
          try {
            frame.scope.vars.set(token.name, this.evaluate(token.value, frame.scope));
          } catch (e) {
            fail((e as Error).message);
          }
          break;

        case "include": {
          const included = this.templates.get(token.name);
          if (!included) {
            fail(`unknown template ${token.name}`);
            break;
          }
          if (!this.checkDepth(stack, frame.template, token.pos, errors)) break;
          this.enter(stack, included, frame.scope, new Map(), errors, token.pos);
          break;
        }

        case "extends":
          fail("extends must be the first statement of a template");
          break;

        case "block": {
          const replacement = frame.blocks.get(token.name);
          if (!replacement) break; // the template's own body follows
          if (!skipTo(["endblock"], "endblock")) break;
          if (!this.checkDepth(stack, frame.template, token.pos, errors)) break;
          stack.push({ ...this.frame(frame, replacement.tokens, frame.scope), template: replacement.template, block: replacement });
          break;
        }

        // Definitions give no output; they are collected by `tokenize`.
        case "component":
          skipTo(["endcomponent"], "endcomponent");
          break;

        case "endblock":
          break;

        case "call": {
          const end = find(frame.tokens, frame.index, ["endcall"]);
          if (end < 0) {
            fail("missing endcall");
            frame.index = frame.tokens.length;
            break;
          }
          const tokens = frame.tokens.slice(frame.index, end);
          frame.index = end + 1;
          if (!token.name) break; // broken call, reported by tokenize
          const body: Body = {
            template: frame.template, tokens, scope: frame.scope, blocks: frame.blocks, body: frame.body, block: frame.block,
          };
          const args = token.args;
          this.callComponent(stack, frame, token.name, () => this.evaluateArgs(args, frame.scope), body, token.pos, errors);
          break;
        }

        case "endfor":
        case "endcomponent":
        case "endcall":
          fail(`${token.type} without ${token.type.slice(3)}`);
          break;
      }
    }

    return { output: this.resolveGlue(output), errors };
  }

  /** Joins the output; each glue mark becomes what `glue` returns for its neighbours. */
  private resolveGlue(output: (string | typeof GLUE)[]): string {
    let result = "";
    output.forEach((piece, i) => {
      if (piece !== GLUE) {
        result += piece;
        return;
      }
      if (!this.glue) return;
      let after = "";
      for (let k = i + 1; k < output.length && after.length < GLUE_CONTEXT; k++) {
        const next = output[k];
        if (next !== GLUE) after += next;
      }
      result += this.glue(result.slice(-GLUE_CONTEXT), after.slice(0, GLUE_CONTEXT));
    });
    return result;
  }

  /**
   * Pushes the frame for `template`. If it extends another template, its blocks
   * are collected and the parent is entered instead, up the whole chain.
   */
  private enter(
    stack: Frame[],
    template: Template,
    scope: Scope,
    blocks: Map<string, BlockDefinition>,
    errors: TemplateError[],
    pos: Position,
  ) {
    const seen = new Set<string>();
    let current = template;
    const overrides = new Map(blocks);
    // Least derived definition so far per block; the next one up becomes its parent.
    const tails = new Map(blocks);
    const chain = (definitions: Map<string, BlockDefinition>, add: boolean) => {
      for (const [name, definition] of definitions) {
        const tail = tails.get(name);
        if (tail) tail.parent = definition;
        else if (add) overrides.set(name, definition);
        else continue;
        tails.set(name, definition);
      }
    };
    for (;;) {
      const first = current.tokens.find((t) => t.type !== "text" || t.value.trim() !== "");
      if (first?.type !== "extends") break;
      if (seen.has(current.name)) {
        errors.push({ type: "error", template: current.name, pos: first.pos, message: "extends loop" });
        return;
      }
      seen.add(current.name);
      const parent = this.templates.get(first.name);
      if (!parent) {
        errors.push({ type: "error", template: current.name, pos: first.pos, message: `unknown template ${first.name}` });
        return;
      }
      // Blocks of the more derived template win; the others stay reachable by super().
      chain(collectBlocks(current), true);
      current = parent;
    }
    // The base template's own blocks: only as parents of overrides.
    if (tails.size > 0) chain(collectBlocks(current), false);
    if (!this.checkDepth(stack, current.name, pos, errors)) return;
    stack.push({
      template: current.name,
      tokens: current.tokens,
      index: 0,
      scope: { vars: new Map(), parent: scope },
      blocks: overrides,
      conditionals: 0,
    });
  }

  /**
   * Pushes the frame of component `name`. It sees only its parameters and its
   * body: no context, no globals, no variables of the caller.
   */
  private callComponent(
    stack: Frame[],
    caller: Frame,
    name: string,
    /** Evaluated inside, so a failing argument becomes an error of the call. */
    args: () => Record<string, unknown>,
    body: Body | undefined,
    pos: Position,
    errors: TemplateError[],
  ) {
    const report = (type: TemplateError["type"], message: string) =>
      errors.push({ type, template: caller.template, pos, message });
    const component = this.components.get(name);
    if (!component) {
      report("error", `unknown component ${name}`);
      return;
    }
    if (this.functions.has(name)) report("warning", `component ${name} hides the function of the same name`);

    let values: Record<string, unknown>;
    try {
      values = args();
    } catch (e) {
      report("error", (e as Error).message);
      return;
    }
    const known = new Set(component.parameters.map((p) => p.name));
    for (const arg of Object.keys(values)) {
      if (!known.has(arg)) report("warning", `component ${name} has no parameter ${arg}; ignored`);
    }

    const vars = new Map<string, unknown>();
    const world: Scope = { vars };
    for (const parameter of component.parameters) {
      let value = values[parameter.name];
      if (value === undefined) {
        if (!parameter.default) {
          report("error", `component ${name}: missing argument ${parameter.name}`);
          return;
        }
        try {
          // Defaults see the parameters before them, nothing else.
          value = this.evaluate(parameter.default, world);
        } catch (e) {
          report("error", `component ${name}, default of ${parameter.name}: ${(e as Error).message}`);
          return;
        }
      }
      const type = parameter.type ?? "any";
      const check = PARAMETER_TYPES[type];
      if (!check) {
        report("error", `component ${name}: unknown type ${type} of ${parameter.name}`);
        return;
      }
      if (!check(value) || (value === null && type !== "any")) {
        report("error", `component ${name}: ${parameter.name} must be ${type}, got ${typeName(value)}`);
        return;
      }
      vars.set(parameter.name, value);
    }

    if (!this.checkDepth(stack, caller.template, pos, errors)) return;
    stack.push({
      template: component.template,
      tokens: component.body,
      index: 0,
      scope: world,
      blocks: new Map(),
      conditionals: 0,
      // Without `call` the body is empty, so `{{ body }}` gives nothing.
      body: body ?? { template: component.template, tokens: [], scope: world, blocks: new Map() },
    });
  }

  /** A new frame for `tokens`, inside `parent`'s template and blocks. */
  private frame(parent: Frame, tokens: Token[], scope: Scope): Frame {
    return {
      template: parent.template, tokens, index: 0, scope, blocks: parent.blocks, conditionals: 0,
      body: parent.body, block: parent.block,
    };
  }

  private loopScope(loop: NonNullable<Frame["loop"]>): Scope {
    const [key, value] = loop.entries[loop.index];
    const vars = new Map<string, unknown>([
      [loop.value, value],
      ["loop", {
        index: loop.index + 1,
        index0: loop.index,
        first: loop.index === 0,
        last: loop.index === loop.entries.length - 1,
      }],
    ]);
    if (loop.key) vars.set(loop.key, key);
    return { vars, parent: loop.outer };
  }

  private checkDepth(stack: Frame[], template: string, pos: Position, errors: TemplateError[]): boolean {
    if (stack.length < this.maxDepth) return true;
    errors.push({ type: "error", template, pos, message: `stack deeper than ${this.maxDepth}` });
    return false;
  }

  /** Arrays give index and item, objects key and value. */
  private entries(value: unknown, what: string): [unknown, unknown][] {
    if (Array.isArray(value)) return value.map((item, i) => [i, item]);
    if (isPlainObject(value)) return Object.entries(value);
    throw new Error(`${what}: cannot loop over ${typeName(value)}`);
  }

  private toText(value: unknown): string {
    if (value === null) return "";
    if (value instanceof ComponentCall) {
      throw new Error(`call of component ${value.name} can only be used as a whole tag`);
    }
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    throw new Error(`cannot output ${typeName(value)}; use a filter like join or json`);
  }

  /** Output of a filter or function marked `safe` is not escaped. */
  private isSafe(expression: Expression): boolean {
    if (expression.type === "filter") return this.filters.get(expression.name)?.safe === true;
    if (expression.type === "call") return this.functions.get(expression.name)?.safe === true;
    return false;
  }

  private evaluate(expression: Expression, scope: Scope): unknown {
    switch (expression.type) {
      case "literal":
        return expression.value;

      case "array":
        return expression.items.map((item) => this.evaluate(item, scope));

      case "path": {
        const [first, ...rest] = expression.path;
        let value = lookup(scope, first);
        for (const key of rest) {
          // Own properties only: no way to `constructor` or `__proto__`.
          if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined;
          value = (value as Record<string, unknown>)[key];
        }
        return value;
      }

      case "unary": {
        const operand = this.evaluate(expression.operand, scope);
        return expression.operator === "not" ? !truthy(operand) : -expectNumber(operand, "-");
      }

      case "binary": {
        const { operator } = expression;
        const left = this.evaluate(expression.left, scope);
        if (operator === "and") return truthy(left) && truthy(this.evaluate(expression.right, scope));
        if (operator === "or") return truthy(left) || truthy(this.evaluate(expression.right, scope));
        const right = this.evaluate(expression.right, scope);
        switch (operator) {
          // null and undefined count as equal: `x == null` also holds for a missing x.
          case "==": return left === right || (left == null && right == null);
          case "!=": return !(left === right || (left == null && right == null));
          case "<": case "<=": case ">": case ">=": {
            const comparable =
              (typeof left === "number" && typeof right === "number") ||
              (typeof left === "string" && typeof right === "string");
            if (!comparable) throw new Error(`${operator}: cannot compare ${typeName(left)} with ${typeName(right)}`);
            const [a, b] = [left as number | string, right as number | string];
            return operator === "<" ? a < b : operator === "<=" ? a <= b : operator === ">" ? a > b : a >= b;
          }
          case "in":
            if (Array.isArray(right)) return right.includes(left);
            if (typeof right === "string") return typeof left === "string" && right.includes(left);
            if (typeof right === "object" && right !== null) return typeof left === "string" && Object.hasOwn(right, left);
            throw new Error(`in: cannot search in ${typeName(right)}`);
          case "~":
            return this.toText(left ?? null) + this.toText(right ?? null);
          default: {
            const a = expectNumber(left, operator);
            const b = expectNumber(right, operator);
            if ((operator === "/" || operator === "%") && b === 0) throw new Error(`${operator}: division by zero`);
            return operator === "+" ? a + b
              : operator === "-" ? a - b
              : operator === "*" ? a * b
              : operator === "/" ? a / b
              : a % b;
          }
        }
      }

      case "filter": {
        const filter = this.filters.get(expression.name);
        if (!filter) throw new Error(`unknown filter ${expression.name}`);
        return filter(this.evaluate(expression.input, scope), this.evaluateArgs(expression.args, scope));
      }

      case "call": {
        const fn = this.functions.get(expression.name);
        if (expression.name === "super" || expression.name === "glue") {
          throw new Error(`${expression.name}() can only be used as a whole tag`);
        }
        if (this.components.has(expression.name)) {
          throw new Error(`component ${expression.name} can only be called as a whole tag`);
        }
        if (!fn) throw new Error(`unknown function ${expression.name}`);
        return fn(this.evaluateArgs(expression.args, scope));
      }
    }
  }

  private evaluateArgs(args: Record<string, Expression>, scope: Scope): Record<string, unknown> {
    return Object.fromEntries(Object.entries(args).map(([name, arg]) => [name, this.evaluate(arg, scope)]));
  }
}

/** All blocks of a template, nested ones too: name → body. */
function collectBlocks(template: Template): Map<string, BlockDefinition> {
  const blocks = new Map<string, BlockDefinition>();
  template.tokens.forEach((token, i) => {
    if (token.type !== "block") return;
    const end = find(template.tokens, i + 1, ["endblock"]);
    if (end >= 0) blocks.set(token.name, { template: template.name, tokens: template.tokens.slice(i + 1, end) });
  });
  return blocks;
}
