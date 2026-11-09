// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT

// Tokenizer of the template engine: splits a template into text and tags, applies
// the whitespace rules, parses statements and expressions, checks the nesting and
// collects the component definitions. See index.ts for the rules.

import type {
  BinaryOperator,
  Component,
  ComponentParameter,
  Expression,
  Position,
  Template,
  TemplateError,
  Token,
  TokenizeOptions,
} from "./index.ts";

type TagKind = "output" | "statement" | "comment";

type Segment =
  | { kind: "text"; value: string; offset: number; raw?: boolean }
  | {
      kind: "tag";
      tag: TagKind;
      content: string;
      /** Offset of the tag and of its content in the source. */
      offset: number;
      contentOffset: number;
      trimLeft: boolean;
      trimRight: boolean;
    };

/** Types of component parameters; the engine checks them when a component is called. */
export const PARAMETER_TYPES: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number" && !Number.isNaN(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => {
    if (typeof v !== "object" || v === null) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  },
  any: () => true,
};
const parameterTypes = Object.keys(PARAMETER_TYPES);

/** Whitespace the rules work on; no-break spaces and the like are kept. */
const SPACE = /^[ \t\r\n]*$/;

/**
 * Tokenizes a template without adding it anywhere. A template with errors is
 * still returned, its faulty elements left out.
 */
export function tokenize(
  name: string,
  source: string,
  options: TokenizeOptions = {},
): { template: Template; errors: TemplateError[] } {
  const open = options.openDelimiter ?? "{";
  const close = options.closeDelimiter ?? "}";
  const errors: TemplateError[] = [];
  const position = positions(source);
  const fail = (offset: number, message: string) =>
    errors.push({ type: "error", template: name, pos: position(offset), message });

  const segments = lex(source, open, close, fail);
  trimMarkers(segments);
  if ((options.whitespace ?? "collapse") === "collapse") {
    removeStandaloneLines(segments);
    for (const segment of segments) {
      if (segment.kind === "text" && !segment.raw) segment.value = collapse(segment.value);
    }
  }

  const tokens: Token[] = [];
  for (const segment of segments) {
    if (segment.kind === "text") {
      if (segment.value === "") continue;
      const last = tokens[tokens.length - 1];
      if (last?.type === "text") last.value += segment.value;
      else tokens.push({ type: "text", value: segment.value, pos: position(segment.offset) });
      continue;
    }
    if (segment.tag === "comment") continue;
    try {
      // Inside try: the constructor already splits the expression and may fail.
      const parser = new Parser(segment.content, segment.contentOffset, position);
      const token = segment.tag === "output"
        ? { type: "output" as const, expression: parser.expressionOnly(), pos: position(segment.offset) }
        : parser.statement(position(segment.offset));
      if (token) tokens.push(token);
    } catch (e) {
      const error = e as ParseError;
      fail(error.offset ?? segment.contentOffset, error.message);
      const recovered = segment.tag === "statement" ? recover(segment.content, position(segment.offset)) : undefined;
      if (recovered) tokens.push(recovered);
    }
  }

  const components = checkNesting(name, tokens, errors);
  return { template: { name, source, tokens, components }, errors };
}

// ------------------------------------------------------------
// Positions
// ------------------------------------------------------------

function positions(source: string): (offset: number) => Position {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - starts[low] + 1 };
  };
}

// ------------------------------------------------------------
// Splitting into text and tags
// ------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** End of a tag: index of `closer` from `start` on, skipping string literals. */
function findClose(source: string, start: number, closer: string, quoted: boolean): number {
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quoted && (ch === '"' || ch === "'" || ch === "`")) {
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (source.startsWith(closer, i)) return i;
  }
  return -1;
}

function lex(source: string, open: string, close: string, fail: (offset: number, message: string) => void): Segment[] {
  const segments: Segment[] = [];
  const closers: Record<TagKind, string> = { output: close + close, statement: "%" + close, comment: "#" + close };
  const endraw = new RegExp(`${escapeRegExp(open)}%(-?)\\s*endraw\\s*(-?)%${escapeRegExp(close)}`, "g");
  let textStart = 0;
  let i = source.indexOf(open);

  const pushText = (end: number, raw = false) => {
    if (end > textStart) segments.push({ kind: "text", value: source.slice(textStart, end), offset: textStart, raw });
  };

  while (i >= 0 && i < source.length) {
    const marker = source[i + open.length];
    const tag: TagKind | undefined =
      marker === open ? "output" : marker === "%" ? "statement" : marker === "#" ? "comment" : undefined;
    if (!tag) {
      i = source.indexOf(open, i + open.length);
      continue;
    }
    let start = i + open.length + 1;
    const trimLeft = source[start] === "-";
    if (trimLeft) start++;
    const closer = closers[tag];
    const end = findClose(source, start, closer, tag !== "comment");
    if (end < 0) {
      fail(i, `unclosed tag, ${closer} missing`);
      break; // the rest stays text
    }
    const trimRight = end > start && source[end - 1] === "-";
    const content = source.slice(start, trimRight ? end - 1 : end);
    pushText(i);
    segments.push({ kind: "tag", tag, content, offset: i, contentOffset: start, trimLeft, trimRight });
    textStart = end + closer.length;

    if (tag === "statement" && content.trim() === "raw") {
      endraw.lastIndex = textStart;
      const match = endraw.exec(source);
      if (!match) {
        fail(i, "missing endraw");
        pushText(source.length, true);
        textStart = source.length;
        break;
      }
      pushText(match.index, true);
      segments.push({
        kind: "tag", tag: "statement", content: "endraw", offset: match.index,
        contentOffset: match.index + open.length + 1, trimLeft: match[1] === "-", trimRight: match[2] === "-",
      });
      textStart = match.index + match[0].length;
    }
    i = source.indexOf(open, textStart);
  }
  pushText(source.length);
  return segments;
}

// ------------------------------------------------------------
// Whitespace
// ------------------------------------------------------------

/** `-` inside a tag removes all whitespace on that side, as in Tera. */
function trimMarkers(segments: Segment[]) {
  segments.forEach((segment, i) => {
    if (segment.kind !== "tag") return;
    const before = segments[i - 1];
    const after = segments[i + 1];
    if (segment.trimLeft && before?.kind === "text") before.value = before.value.replace(/[ \t\r\n]+$/, "");
    if (segment.trimRight && after?.kind === "text") after.value = after.value.replace(/^[ \t\r\n]+/, "");
  });
}

/**
 * A line holding only statements and comments vanishes with its newline. All
 * lines are judged on the original text, then the cuts are made.
 */
function removeStandaloneLines(segments: Segment[]) {
  const isBlockTag = (s: Segment | undefined) => s?.kind === "tag" && s.tag !== "output";
  const isGap = (s: Segment | undefined) => s?.kind === "text" && /^[ \t]*$/.test(s.value);
  // Cuts per text segment: keep value.slice(from, to).
  const cuts = new Map<Segment, { from: number; to: number }>();
  const cut = (s: Segment) => {
    const value = (s as { value: string }).value;
    let c = cuts.get(s);
    if (!c) cuts.set(s, (c = { from: 0, to: value.length }));
    return c;
  };

  let i = 0;
  while (i < segments.length) {
    if (!isBlockTag(segments[i])) {
      i++;
      continue;
    }
    // The run: block tags, with only spaces and tabs between them.
    let last = i;
    for (let k = i + 1; k < segments.length; k++) {
      if (isBlockTag(segments[k])) last = k;
      else if (!isGap(segments[k])) break;
    }
    const first = i;
    i = last + 1;

    const before = segments[first - 1];
    const after = segments[last + 1];
    const startsLine =
      first === 0 ||
      (before.kind === "text" && /[ \t]*$/.exec(before.value)!.index === before.value.lastIndexOf("\n") + 1 &&
        (before.value.includes("\n") || first - 1 === 0));
    const endsLine =
      after === undefined ||
      (after.kind === "text" &&
        (/^[ \t]*\r?\n/.test(after.value) || (last + 1 === segments.length - 1 && SPACE.test(after.value))));
    if (!startsLine || !endsLine) continue;

    if (before?.kind === "text") cut(before).to = before.value.lastIndexOf("\n") + 1;
    for (let k = first; k <= last; k++) if (segments[k].kind === "text") cut(segments[k]).to = 0;
    if (after?.kind === "text") {
      // Up to and including the newline, plus the indentation of the next line.
      const rest = /^[^\n]*\n[ \t]*/.exec(after.value);
      cut(after).from = rest ? rest[0].length : after.value.length;
    }
  }

  for (const [segment, { from, to }] of cuts) {
    const text = segment as { value: string };
    text.value = from < to ? text.value.slice(from, to) : "";
  }
}

/** Spaces and tabs → one space, one newline → newline, more → one blank line. */
function collapse(text: string): string {
  return text.replace(/[ \t\r\n]+/g, (space) => {
    const newlines = space.split("\n").length - 1;
    return newlines === 0 ? " " : newlines === 1 ? "\n" : "\n\n";
  });
}

// ------------------------------------------------------------
// Expressions and statements
// ------------------------------------------------------------

type ParseError = Error & { offset?: number };

function parseError(message: string, offset: number): ParseError {
  return Object.assign(new Error(message), { offset });
}

type Lexeme =
  | { type: "number"; value: number; offset: number }
  | { type: "string"; value: string; offset: number }
  | { type: "name"; value: string; offset: number }
  | { type: "op"; value: string; offset: number }
  | { type: "end"; value: ""; offset: number };

const OPERATORS = ["==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "~", "|", "(", ")", "[", "]", ",", "=", ":", "."];
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r" };

function lexExpression(content: string, base: number): Lexeme[] {
  const lexemes: Lexeme[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (/[ \t\r\n]/.test(ch)) {
      i++;
      continue;
    }
    const offset = base + i;
    const afterDot = lexemes[lexemes.length - 1]?.value === ".";
    const number = /^\d+(\.\d+)?/.exec(content.slice(i));
    if (number) {
      // After a dot only an index: `items.0.title`.
      const text = afterDot ? /^\d+/.exec(number[0])![0] : number[0];
      lexemes.push({ type: "number", value: Number(text), offset });
      i += text.length;
      continue;
    }
    const name = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(content.slice(i));
    if (name) {
      lexemes.push({ type: "name", value: name[0], offset });
      i += name[0].length;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let value = "";
      let j = i + 1;
      for (; j < content.length && content[j] !== ch; j++) {
        if (content[j] === "\\" && j + 1 < content.length) {
          j++;
          value += ESCAPES[content[j]] ?? content[j];
        } else value += content[j];
      }
      if (j >= content.length) throw parseError("unclosed string", offset);
      lexemes.push({ type: "string", value, offset });
      i = j + 1;
      continue;
    }
    const op = OPERATORS.find((o) => content.startsWith(o, i));
    if (!op) throw parseError(`unexpected character ${ch}`, offset);
    lexemes.push({ type: "op", value: op, offset });
    i += op.length;
  }
  lexemes.push({ type: "end", value: "", offset: base + content.length });
  return lexemes;
}

const COMPARISONS = new Set(["==", "!=", "<", "<=", ">", ">="]);
const KEYWORDS = new Set(["and", "or", "not", "in", "true", "false", "null"]);

class Parser {
  private lexemes: Lexeme[];
  private index = 0;
  private position: (offset: number) => Position;

  constructor(content: string, base: number, position: (offset: number) => Position) {
    this.lexemes = lexExpression(content, base);
    this.position = position;
  }

  // Helpers

  private peek(ahead = 0): Lexeme {
    return this.lexemes[Math.min(this.index + ahead, this.lexemes.length - 1)];
  }

  private next(): Lexeme {
    const lexeme = this.peek();
    if (lexeme.type !== "end") this.index++;
    return lexeme;
  }

  private is(type: Lexeme["type"], value?: string): boolean {
    const lexeme = this.peek();
    return lexeme.type === type && (value === undefined || lexeme.value === value);
  }

  private accept(type: Lexeme["type"], value?: string): boolean {
    if (!this.is(type, value)) return false;
    this.next();
    return true;
  }

  private expect(type: Lexeme["type"], value?: string): Lexeme {
    if (!this.is(type, value)) throw this.unexpected(value ?? type);
    return this.next();
  }

  private unexpected(wanted: string): ParseError {
    const lexeme = this.peek();
    const found = lexeme.type === "end" ? "end of tag" : String(lexeme.value);
    return parseError(`expected ${wanted}, found ${found}`, lexeme.offset);
  }

  private name(): string {
    const lexeme = this.expect("name");
    if (KEYWORDS.has(lexeme.value as string)) throw parseError(`${lexeme.value} is a keyword`, lexeme.offset);
    return lexeme.value as string;
  }

  /** `ui.img` */
  private qualifiedName(): string {
    let name = this.name();
    while (this.accept("op", ".")) name += "." + this.name();
    return name;
  }

  private end() {
    if (!this.is("end")) throw this.unexpected("end of tag");
  }

  private pos(lexeme: Lexeme): Position {
    return this.position(lexeme.offset);
  }

  // Statements

  statement(pos: Position): Token | undefined {
    const keyword = this.expect("name");
    let token: Token | undefined;
    switch (keyword.value) {
      case "if":
      case "elif":
        token = { type: keyword.value, test: this.expression(), pos };
        break;
      case "else":
      case "endif":
      case "endfor":
        token = { type: keyword.value, pos };
        break;
      case "raw":
      case "endraw":
        break; // handled while splitting
      case "for": {
        let value = this.name();
        let key: string | undefined;
        if (this.accept("op", ",")) {
          key = value;
          value = this.name();
        }
        this.expect("name", "in");
        token = { type: "for", key, value, iterable: this.expression(), pos };
        break;
      }
      case "set": {
        const name = this.name();
        this.expect("op", "=");
        token = { type: "set", name, value: this.expression(), pos };
        break;
      }
      case "include":
      case "extends":
        token = { type: keyword.value, name: this.expect("string").value as string, pos };
        break;
      case "block":
        token = { type: "block", name: this.name(), pos };
        break;
      case "endblock":
        token = { type: "endblock", name: this.is("end") ? undefined : this.name(), pos };
        break;
      case "component":
        token = { type: "component", name: this.qualifiedName(), parameters: this.parameters(), pos };
        break;
      case "endcomponent":
        token = { type: "endcomponent", name: this.is("end") ? undefined : this.qualifiedName(), pos };
        break;
      case "call":
        token = { type: "call", name: this.qualifiedName(), args: this.is("op", "(") ? this.namedArgs() : {}, pos };
        break;
      case "endcall":
        token = { type: "endcall", name: this.is("end") ? undefined : this.qualifiedName(), pos };
        break;
      default:
        throw parseError(`unknown statement ${keyword.value}`, keyword.offset);
    }
    this.end();
    return token;
  }

  /** `(src: string, width: integer = 800)` */
  private parameters(): ComponentParameter[] {
    const parameters: ComponentParameter[] = [];
    this.expect("op", "(");
    while (!this.accept("op", ")")) {
      const parameter: ComponentParameter = { name: this.name() };
      if (this.accept("op", ":")) {
        const at = this.peek();
        parameter.type = this.name();
        if (!parameterTypes.includes(parameter.type)) {
          throw parseError(`unknown type ${parameter.type}, expected ${parameterTypes.join(", ")}`, at.offset);
        }
      }
      if (this.accept("op", "=")) parameter.default = this.expression();
      parameters.push(parameter);
      if (!this.is("op", ")")) this.expect("op", ",");
    }
    return parameters;
  }

  // Expressions, lowest precedence first

  expressionOnly(): Expression {
    const expression = this.expression();
    this.end();
    return expression;
  }

  private expression(): Expression {
    return this.or();
  }

  private binary(operator: BinaryOperator, left: Expression, right: Expression, at: Lexeme): Expression {
    return { type: "binary", operator, left, right, pos: this.pos(at) };
  }

  private or(): Expression {
    let left = this.and();
    while (this.is("name", "or")) {
      const at = this.next();
      left = this.binary("or", left, this.and(), at);
    }
    return left;
  }

  private and(): Expression {
    let left = this.not();
    while (this.is("name", "and")) {
      const at = this.next();
      left = this.binary("and", left, this.not(), at);
    }
    return left;
  }

  private not(): Expression {
    if (this.is("name", "not")) {
      const at = this.next();
      return { type: "unary", operator: "not", operand: this.not(), pos: this.pos(at) };
    }
    return this.comparison();
  }

  private comparison(): Expression {
    let left = this.concat();
    for (;;) {
      const at = this.peek();
      if (at.type === "op" && COMPARISONS.has(at.value)) {
        this.next();
        left = this.binary(at.value as BinaryOperator, left, this.concat(), at);
      } else if (this.is("name", "in")) {
        this.next();
        left = this.binary("in", left, this.concat(), at);
      } else if (this.is("name", "not") && this.peek(1).type === "name" && this.peek(1).value === "in") {
        this.next();
        this.next();
        const test = this.binary("in", left, this.concat(), at);
        left = { type: "unary", operator: "not", operand: test, pos: this.pos(at) };
      } else return left;
    }
  }

  private concat(): Expression {
    let left = this.additive();
    while (this.is("op", "~")) {
      const at = this.next();
      left = this.binary("~", left, this.additive(), at);
    }
    return left;
  }

  private additive(): Expression {
    let left = this.multiplicative();
    while (this.is("op", "+") || this.is("op", "-")) {
      const at = this.next();
      left = this.binary(at.value as BinaryOperator, left, this.multiplicative(), at);
    }
    return left;
  }

  private multiplicative(): Expression {
    let left = this.unary();
    while (this.is("op", "*") || this.is("op", "/") || this.is("op", "%")) {
      const at = this.next();
      left = this.binary(at.value as BinaryOperator, left, this.unary(), at);
    }
    return left;
  }

  private unary(): Expression {
    if (this.is("op", "-")) {
      const at = this.next();
      return { type: "unary", operator: "-", operand: this.unary(), pos: this.pos(at) };
    }
    return this.filtered();
  }

  /** Filters bind to the value right before them, as in Jinja: `a + b | f` is `a + f(b)`. */
  private filtered(): Expression {
    let input = this.primary();
    while (this.is("op", "|")) {
      const at = this.next();
      const name = this.name();
      const args = this.is("op", "(") ? this.namedArgs() : {};
      input = { type: "filter", name, input, args, pos: this.pos(at) };
    }
    return input;
  }

  /** `(name=expr, …)`; Tera knows named arguments only. */
  private namedArgs(): Record<string, Expression> {
    const args: Record<string, Expression> = {};
    this.expect("op", "(");
    while (!this.accept("op", ")")) {
      const at = this.peek();
      const name = this.name();
      if (!this.is("op", "=")) throw parseError(`argument ${name} needs a name: ${name}=…`, at.offset);
      this.next();
      if (name in args) throw parseError(`argument ${name} given twice`, at.offset);
      args[name] = this.expression();
      if (!this.is("op", ")")) this.expect("op", ",");
    }
    return args;
  }

  private primary(): Expression {
    const at = this.peek();
    const pos = this.pos(at);
    if (at.type === "number" || at.type === "string") {
      this.next();
      return { type: "literal", value: at.value, pos };
    }
    if (this.accept("op", "(")) {
      const inner = this.expression();
      this.expect("op", ")");
      return inner;
    }
    if (this.accept("op", "[")) {
      const items: Expression[] = [];
      while (!this.accept("op", "]")) {
        items.push(this.expression());
        if (!this.is("op", "]")) this.expect("op", ",");
      }
      return { type: "array", items, pos };
    }
    if (at.type === "name") {
      if (at.value === "true" || at.value === "false") {
        this.next();
        return { type: "literal", value: at.value === "true", pos };
      }
      if (at.value === "null") {
        this.next();
        return { type: "literal", value: null, pos };
      }
      const path = [this.name()];
      // Only names, no index: `ui.img(…)` may still become a call.
      let plain = true;
      for (;;) {
        if (this.accept("op", ".")) {
          const part = this.peek();
          if (part.type === "number") {
            path.push(String(this.next().value));
            plain = false;
          } else path.push(this.name());
        } else if (this.is("op", "(") && plain) {
          return { type: "call", name: path.join("."), args: this.namedArgs(), pos };
        } else if (this.accept("op", "[")) {
          plain = false;
          const part = this.next();
          if (part.type !== "number" && part.type !== "string") {
            throw parseError("only a number or string literal may stand in [ ]", part.offset);
          }
          path.push(String(part.value));
          this.expect("op", "]");
        } else return { type: "path", path, pos };
      }
    }
    throw this.unexpected("a value");
  }
}

/**
 * Keeps the nesting intact when a statement cannot be parsed: a broken `if` or
 * `elif` becomes false, a broken `for` loops over nothing, so its body is
 * skipped and the matching end does not stand alone.
 */
function recover(content: string, pos: Position): Token | undefined {
  const keyword = /^\s*([\p{L}_]+)/u.exec(content)?.[1];
  const never: Expression = { type: "literal", value: false, pos };
  switch (keyword) {
    case "if":
    case "elif":
      return { type: keyword, test: never, pos };
    case "for":
      return { type: "for", value: "_", iterable: { type: "array", items: [], pos }, pos };
    case "block":
      return { type: "block", name: "", pos };
    case "component":
      return { type: "component", name: "", parameters: [], pos };
    case "call":
      return { type: "call", name: "", args: {}, pos };
  }
  return undefined;
}

// ------------------------------------------------------------
// Nesting
// ------------------------------------------------------------

const ENDS: Record<string, string> = {
  if: "endif", for: "endfor", block: "endblock", component: "endcomponent", call: "endcall",
};

/** Reports wrong nesting and returns the components with their bodies. */
function checkNesting(template: string, tokens: Token[], errors: TemplateError[]): Component[] {
  const components: Component[] = [];
  const open: { token: Token; index: number; sawElse: boolean }[] = [];
  const fail = (pos: Position, message: string) => errors.push({ type: "error", template, pos, message });

  tokens.forEach((token, index) => {
    const top = open[open.length - 1];
    switch (token.type) {
      case "if":
      case "for":
      case "block":
      case "component":
      case "call":
        open.push({ token, index, sawElse: false });
        break;
      case "elif":
      case "else":
        if (top?.token.type === "if" || (token.type === "else" && top?.token.type === "for")) {
          if (top.sawElse) fail(token.pos, `${token.type} after else`);
          if (token.type === "else") top.sawElse = true;
        } else fail(token.pos, `${token.type} without ${token.type === "else" ? "if or for" : "if"}`);
        break;
      case "endif":
      case "endfor":
      case "endblock":
      case "endcomponent":
      case "endcall": {
        const opener = token.type.slice(3);
        if (top?.token.type !== opener) {
          fail(token.pos, top ? `${token.type} where ${ENDS[top.token.type]} is expected` : `${token.type} without ${opener}`);
          break;
        }
        open.pop();
        const name = "name" in token ? token.name : undefined;
        const openName = "name" in top.token ? (top.token.name as string) : undefined;
        if (name !== undefined && name !== openName) fail(token.pos, `${token.type} ${name} closes ${opener} ${openName}`);
        if (top.token.type === "component" && top.token.name) {
          components.push({
            name: top.token.name,
            parameters: top.token.parameters,
            body: tokens.slice(top.index + 1, index),
            template,
            pos: top.token.pos,
          });
        }
        break;
      }
    }
  });
  for (const { token } of open) fail(token.pos, `missing ${ENDS[token.type]}`);
  return components;
}
