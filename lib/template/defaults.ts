// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT

// Default filters and functions of the template engine, plus the format-specific
// parts for HTML and TeX. Nothing here knows about edox.
//
// A filter or function that cannot work with its input throws; the engine turns
// that into a TemplateError and goes on after the element.

import type { Escape, Filter, TemplateFunction } from "./index.ts";

type Args = Record<string, unknown>;

const LOCALE = "de-DE";
/** Upper limit for `range`, against runaway loops. */
const MAX_RANGE = 100_000;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown, filter: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error(`${filter}: expected an array, got ${typeName(value)}`);
}

function string(value: unknown, filter: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error(`${filter}: expected a string, got ${typeName(value)}`);
}

function number(value: unknown, filter: string): number {
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  throw new Error(`${filter}: expected a number, got ${typeName(value)}`);
}

/** Reads a named argument; `fallback` when it is missing. */
function arg<T>(args: Args, name: string, fallback: T, check: (v: unknown, f: string) => T, filter: string): T {
  const value = args[name];
  return value === undefined ? fallback : check(value, `${filter}(${name})`);
}

/** `a.b.c` on an object; undefined when a step is missing. */
function attribute(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!isObject(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Text of a value as output shows it: null and undefined give "". */
function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

const collator = new Intl.Collator(LOCALE, { numeric: true });

function compare(a: unknown, b: unknown, filter: string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return collator.compare(a, b);
  throw new Error(`${filter}: cannot compare ${typeName(a)} with ${typeName(b)}`);
}

function toDate(value: unknown, filter: string): Date {
  const date =
    value instanceof Date ? value
    : typeof value === "string" || typeof value === "number" ? new Date(value)
    : undefined;
  if (date && !Number.isNaN(date.getTime())) return date;
  throw new Error(`${filter}: not a date: ${text(value)}`);
}

type DateStyle = "full" | "long" | "medium" | "short";

function dateStyle(value: unknown, name: string): DateStyle {
  if (value === "full" || value === "long" || value === "medium" || value === "short") return value;
  throw new Error(`${name}: expected full, long, medium or short, got ${text(value)}`);
}

function safe<F extends Filter | TemplateFunction>(fn: F): F {
  return Object.assign(fn, { safe: true });
}

// ------------------------------------------------------------
// Filters
// ------------------------------------------------------------

export const defaultFilters: Record<string, Filter> = {
  // Control

  /** Marks the value as finished output; it is not escaped. */
  safe: safe((value) => text(value)),

  /** `value` when the input is undefined or null. */
  default: (value, args) => (value === undefined || value === null ? args.value : value),

  // Lists

  length: (value) => {
    if (typeof value === "string" || Array.isArray(value)) return value.length;
    if (isObject(value)) return Object.keys(value).length;
    throw new Error(`length: expected a string, array or object, got ${typeName(value)}`);
  },

  first: (value) => array(value, "first")[0],

  last: (value) => {
    const items = array(value, "last");
    return items[items.length - 1];
  },

  join: (value, args) =>
    array(value, "join").map(text).join(arg(args, "sep", "", string, "join")),

  reverse: (value) => {
    if (typeof value === "string") return Array.from(value).reverse().join("");
    return [...array(value, "reverse")].reverse();
  },

  /** Strings by German collation (numbers inside compare numerically). */
  sort: (value, args) => {
    const path = arg(args, "attribute", "", string, "sort");
    const key = (item: unknown) => (path ? attribute(item, path) : item);
    return [...array(value, "sort")].sort((a, b) => compare(key(a), key(b), "sort"));
  },

  /** Like Array.slice: `end` exclusive, negative values count from the end. */
  slice: (value, args) => {
    const start = arg(args, "start", 0, number, "slice");
    const end = arg<number | undefined>(args, "end", undefined, number, "slice");
    if (typeof value === "string") return Array.from(value).slice(start, end).join("");
    return array(value, "slice").slice(start, end);
  },

  map: (value, args) => {
    const path = arg(args, "attribute", "", string, "map");
    if (!path) throw new Error("map: missing argument attribute");
    return array(value, "map").map((item) => attribute(item, path));
  },

  /** Items whose `attribute` equals `value`; without `value`, whose attribute is truthy. */
  filter: (value, args) => {
    const path = arg(args, "attribute", "", string, "filter");
    if (!path) throw new Error("filter: missing argument attribute");
    const wanted = args.value;
    return array(value, "filter").filter((item) => {
      const found = attribute(item, path);
      return wanted === undefined ? Boolean(found) : found === wanted;
    });
  },

  /** Property `key`; `default` when it is missing, otherwise an error. */
  get: (value, args) => {
    const key = arg(args, "key", "", string, "get");
    if (!isObject(value)) throw new Error(`get: expected an object, got ${typeName(value)}`);
    if (key in value) return value[key];
    if ("default" in args) return args.default;
    throw new Error(`get: no key "${key}"`);
  },

  // Text

  lower: (value) => string(value, "lower").toLocaleLowerCase(LOCALE),

  upper: (value) => string(value, "upper").toLocaleUpperCase(LOCALE),

  /** First character upper case, the rest lower case. */
  capitalize: (value) => {
    const s = string(value, "capitalize");
    return s.charAt(0).toLocaleUpperCase(LOCALE) + s.slice(1).toLocaleLowerCase(LOCALE);
  },

  /** First letter of each word upper case, the rest unchanged. */
  title: (value) =>
    string(value, "title").replace(/(^|[\s\-–(„"'])(\p{L})/gu, (_, before, letter) =>
      before + letter.toLocaleUpperCase(LOCALE),
    ),

  trim: (value) => string(value, "trim").trim(),

  replace: (value, args) => {
    const from = arg(args, "from", "", string, "replace");
    if (!from) throw new Error("replace: missing argument from");
    return string(value, "replace").replaceAll(from, arg(args, "to", "", string, "replace"));
  },

  split: (value, args) => {
    const pat = args.pat;
    if (pat === undefined) throw new Error("split: missing argument pat");
    return string(value, "split").split(string(pat, "split(pat)"));
  },

  /** At most `length` characters, then `end` (default "…"). */
  truncate: (value, args) => {
    const chars = Array.from(string(value, "truncate"));
    const length = arg(args, "length", 255, number, "truncate");
    if (chars.length <= length) return chars.join("");
    return chars.slice(0, length).join("") + arg(args, "end", "…", string, "truncate");
  },

  // Numbers

  abs: (value) => Math.abs(number(value, "abs")),

  /** `method`: common (default), ceil or floor; `precision`: decimal places. */
  round: (value, args) => {
    const x = number(value, "round");
    const factor = 10 ** arg(args, "precision", 0, number, "round");
    const method = arg(args, "method", "common", string, "round");
    const round =
      method === "common" ? Math.round
      : method === "ceil" ? Math.ceil
      : method === "floor" ? Math.floor
      : undefined;
    if (!round) throw new Error(`round: unknown method ${method}`);
    return round(x * factor) / factor;
  },

  /** Whole number from a number or string; `default` when it is none. */
  int: (value, args) => {
    const x = typeof value === "number" ? Math.trunc(value) : parseInt(text(value).trim(), 10);
    if (!Number.isNaN(x)) return x;
    if ("default" in args) return args.default;
    throw new Error(`int: not a number: ${text(value)}`);
  },

  /** Number from a number or string, also with a decimal comma; `default` when it is none. */
  float: (value, args) => {
    const x = typeof value === "number" ? value : Number(text(value).trim().replace(",", "."));
    if (text(value).trim() !== "" && !Number.isNaN(x)) return x;
    if ("default" in args) return args.default;
    throw new Error(`float: not a number: ${text(value)}`);
  },

  /** German number format, e.g. 1,5; `decimals` fixes the decimal places. */
  number: (value, args) => {
    const decimals = arg<number | undefined>(args, "decimals", undefined, number, "number");
    const options =
      decimals === undefined ? {} : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
    return new Intl.NumberFormat(LOCALE, options).format(number(value, "number"));
  },

  // Data

  /** JSON text; `pretty` indents by two spaces. */
  json: (value, args) => JSON.stringify(value ?? null, null, args.pretty ? 2 : undefined),

  // Date

  /**
   * German date from a Date, an ISO string or a timestamp.
   * `format`: full, long, medium (default, 21.10.2026) or short;
   * `time`: the same styles, adds the time.
   */
  date: (value, args) => {
    const date = toDate(value, "date");
    const options: Intl.DateTimeFormatOptions = {
      dateStyle: dateStyle(args.format ?? "medium", "date(format)"),
    };
    if (args.time !== undefined) options.timeStyle = dateStyle(args.time, "date(time)");
    return new Intl.DateTimeFormat(LOCALE, options).format(date);
  },
};

// ------------------------------------------------------------
// Functions
// ------------------------------------------------------------

export const defaultFunctions: Record<string, TemplateFunction> = {
  /** Numbers from `start` (default 0) up to `end` exclusive, in steps of `step` (default 1). */
  range: (args) => {
    const start = arg(args, "start", 0, number, "range");
    const end = arg<number | undefined>(args, "end", undefined, number, "range");
    const step = arg(args, "step", 1, number, "range");
    if (end === undefined) throw new Error("range: missing argument end");
    if (step === 0) throw new Error("range: step must not be 0");
    const count = Math.max(0, Math.ceil((end - start) / step));
    if (count > MAX_RANGE) throw new Error(`range: more than ${MAX_RANGE} numbers`);
    return Array.from({ length: count }, (_, i) => start + i * step);
  },

  /** Current time as ISO string, for the filter `date`. */
  now: () => new Date().toISOString(),

  /** Writes `message` to the error list; the element gives no output. */
  error: (args) => {
    throw new Error(text(args.message) || "error()");
  },
};

// ------------------------------------------------------------
// HTML
// ------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Only `& < > " '`; the encoding is UTF-8. */
export const escapeHtml: Escape = (s) => s.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);

export const htmlFilters: Record<string, Filter> = {
  escape: safe((value) => escapeHtml(text(value))),
  /** Removes tags and comments; entities stay. */
  striptags: (value) =>
    string(value, "striptags").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, ""),
};

// ------------------------------------------------------------
// TeX
// ------------------------------------------------------------

/** Only `& % # _`; `$ \ { }` stay, values may contain formulas. */
export const escapeTex: Escape = (s) => s.replace(/[&%#_]/g, (c) => "\\" + c);

export const texFilters: Record<string, Filter> = {
  tex: safe((value) => escapeTex(text(value))),
};
