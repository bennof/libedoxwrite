/*
 * Standalone HTML export: a page from renderer/renderhtml.ts plus its
 * stylesheet and script, written next to it as <name>.css and <name>.js.
 *
 * The script is grading.js turned into a classic script, because browsers do
 * not run ES modules from pages opened as local files (file://).
 * File contents are passed in, so this works in Node and in the browser.
 */

/** names of the companion files of <name>.html */
export function companionFiles(htmlName: string): { css: string; js: string } {
  const base = htmlName.replace(/^.*\//, "").replace(/\.html?$/i, "");
  return { css: `${base}.css`, js: `${base}.js` };
}

/** grading.js (ES module without imports) -> classic script that wires the page */
export function classicScript(gradingModule: string): string {
  return (
    "// generated from src/shared/edox/html/grading.js – do not edit\n" +
    "(() => {\n" +
    '"use strict";\n' +
    gradingModule.replace(/^export\s+/gm, "") +
    '\nif (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => initPage());\n' +
    "else initPage();\n" +
    "})();\n"
  );
}
