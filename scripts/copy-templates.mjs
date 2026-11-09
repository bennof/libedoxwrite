import { cp, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// files tsc does not emit: the templates, and the grading script and stylesheet of HTML pages
for (const [from, filter] of [
  ["lib/edox/templates/tex", undefined],
  ["lib/edox/templates/html", undefined],
  ["lib/edox/html", (f) => !f.endsWith(".ts")],
]) {
  const source = fileURLToPath(new URL(`../${from}`, import.meta.url));
  const target = fileURLToPath(new URL(`../dist/${from}`, import.meta.url));
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, filter });
}
