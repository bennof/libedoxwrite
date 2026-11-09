import { cp, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../lib/edox/templates/tex", import.meta.url));
const target = fileURLToPath(new URL("../dist/lib/edox/templates/tex", import.meta.url));
await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
