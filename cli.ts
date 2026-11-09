#!/usr/bin/env node
// Copyright (c) 2026 Benjamin Benno Falkner
// SPDX-License-Identifier: MIT
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createConverter, type Format, type Diagnostic } from "./lib/index.ts";

const HELP = `Usage: edoxwrite <input|-> --to <tex|json|md> [options]
       edoxwrite <tex|json|md>-to-<tex|json|md> <input|-> [output]

  --from <tex|json|md>   Input format (otherwise inferred from extension)
  --to <tex|json|md>     Output format
  -o, --output <path>   Output file (default: stdout; - also means stdout)
  --diagnostics <path>  JSON diagnostic report, in addition to stderr
  --format <name>       Document format, e.g. exam_q-phase
  --template <name>     TeX output template, e.g. worksheet.tex
  --template-dir <path> Load and override templates from this folder
  --strict              Return exit code 1 for warnings too
  -h, --help            Show this help

Output is written even when conversion reports errors.
Exit codes: 0 = success/warnings, 1 = conversion errors, 2 = usage or I/O error.
`;
const formats = new Set(["tex", "json", "md"]);
const asFormat = (value: string | undefined): Format => {
  if (!value || !formats.has(value)) throw new Error(`expected tex, json or md, got ${value ?? "nothing"}`);
  return value as Format;
};

async function main(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(HELP); return; }
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--strict") { strict = true; continue; }
    if (arg === "-o" || ["--from", "--to", "--output", "--diagnostics", "--format", "--template", "--template-dir"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
      opts[arg === "-o" ? "output" : arg.slice(2)] = value;
    } else if (arg.startsWith("-") && arg !== "-") throw new Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  const command = /^(tex|json|md)-to-(tex|json|md)$/.exec(positional[0] ?? "");
  if (command) {
    positional.shift();
    if ((opts.from && opts.from !== command[1]) || (opts.to && opts.to !== command[2])) throw new Error("command conflicts with --from/--to");
    opts.from = command[1]; opts.to = command[2];
  }
  const [input, positionalOutput] = positional;
  if (!input || positional.length > 2) throw new Error(HELP);
  if (positionalOutput && opts.output) throw new Error("specify output only once");
  const output = opts.output ?? positionalOutput;
  const from = asFormat(opts.from ?? (input === "-" ? undefined : extname(input).slice(1).replace(/^markdown$/, "md")));
  const to = asFormat(opts.to);
  const paths = [input === "-" ? undefined : input, output === "-" ? undefined : output, opts.diagnostics].filter((p): p is string => !!p).map(p => resolve(p));
  if (new Set(paths).size !== paths.length) throw new Error("input, output and diagnostics must use different paths");
  const source = input === "-" ? await readStdin() : await readFile(input, "utf8");
  const converter = createConverter({}, { templateDirectory: opts["template-dir"] ? resolve(opts["template-dir"]) : undefined });
  const result = converter.convert(source, { from, to, format: opts.format, template: opts.template });
  for (const d of result.diagnostics) process.stderr.write(diagnosticText(d) + "\n");
  if (output && output !== "-") await writeFile(output, result.output);
  else process.stdout.write(result.output);
  if (opts.diagnostics) await writeFile(opts.diagnostics, JSON.stringify({ input, from, to, ok: result.ok, diagnostics: result.diagnostics }, null, 2) + "\n");
  process.exitCode = !result.ok || (strict && result.diagnostics.some(d => d.severity === "warning")) ? 1 : 0;
}
function diagnosticText(d: Diagnostic): string {
  const location = [d.template ?? d.path, d.line, d.column].filter(v => v !== undefined).join(":");
  return `${d.severity}: ${d.stage}${location ? ` ${location}` : ""}: ${d.message}`;
}
async function readStdin(): Promise<string> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}
main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
