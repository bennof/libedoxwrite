// Grading of an exam rendered by renderer/renderhtml.ts – the one source for
//   - apps (import { attachGrading } from "…/edox/html/grading.js") and
//   - standalone HTML pages: html/standalone.ts turns this module into a classic
//     script (no imports allowed here) that runs initPage().
//
//   const g = attachGrading(root, { onChange });
//   g.values() / g.apply(fields) / g.clear() / g.currentField() / g.activateField(name) / g.destroy()
//
// Keyboard: arrows move between points fields; checkbox: Space toggles,
// 1 checks, 0 unchecks; text field: type the number. Sums, total (respecting
// data-select of a section) and grade are computed live.

const GRADE_WORDS = ["sehr gut", "gut", "befriedigend", "ausreichend", "mangelhaft", "ungenügend"];
const COMPUTED = (name) => name.startsWith("Sum-Points-") || name === "SumPointsTotal" || name === "Grade";

const parseNumber = (s) => {
  const t = s.trim().replace(",", ".");
  if (t === "") return 0;
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
};
const format = (v) => String(Math.round(v * 100) / 100).replace(".", ",");
const list = (s) => (s ?? "").split(",").map((x) => x.trim());

export function attachGrading(root, { onChange = () => {} } = {}) {
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const fields = () => $$('[data-type="points"] input');
  const isPointsField = (el) => el instanceof HTMLInputElement && root.contains(el) && !!el.closest('[data-type="points"]');

  let current = null;

  function activate(el) {
    if (!el) return;
    current = el;
    for (const f of $$("[data-current]")) f.removeAttribute("data-current");
    el.setAttribute("data-current", "");
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  }

  function move(from, step) {
    const all = fields();
    const i = all.indexOf(from);
    activate(i < 0 ? all[0] : all[i + step]);
  }

  /* ---------- sums and grade ---------- */

  function exercisePoints(ex) {
    let sum = 0;
    for (const input of ex.querySelectorAll('[data-type="points"] input')) {
      if (input.type === "checkbox") {
        if (input.checked) sum += 1;
        continue;
      }
      const v = parseNumber(input.value);
      const invalid = Number.isNaN(v) || v > Number(input.dataset.max);
      input.toggleAttribute("data-invalid", invalid);
      if (!invalid) sum += v;
    }
    return sum;
  }

  function grade(total) {
    const exam = $('[data-type="exam"]');
    const max = Number(exam?.dataset.points);
    if (!max) return "";
    const labels = list(exam.dataset.gradeLabels);
    const indices = list(exam.dataset.gradeIndices);
    const i = list(exam.dataset.gradePercentages).map(Number).findIndex((p) => (total / max) * 100 >= p);
    if (i < 0) return "";
    const word = GRADE_WORDS[Number(labels[i].charAt(0)) - 1];
    return [word, `(${labels[i]})`, indices[i] ? `(${indices[i]}P)` : ""].filter(Boolean).join(" ");
  }

  function update() {
    const scores = new Map();
    for (const ex of $$('[data-type="exercise"]')) {
      const v = exercisePoints(ex);
      scores.set(ex, v);
      const out = ex.querySelector(':scope > [data-type="sum"] input');
      if (out) out.value = format(v);
    }
    let total = 0;
    const counted = new Set();
    for (const section of $$('[data-type="section"]')) {
      const own = [...section.querySelectorAll('[data-type="exercise"]')];
      let values = own.map((ex) => scores.get(ex));
      own.forEach((ex) => counted.add(ex));
      const select = Number(section.dataset.select);
      if (select) values = values.sort((a, b) => b - a).slice(0, select);
      total += values.reduce((s, v) => s + v, 0);
    }
    for (const [ex, v] of scores) if (!counted.has(ex)) total += v;

    const totalField = $("#SumPointsTotal");
    if (totalField) totalField.value = format(total);
    const gradeField = $("#Grade");
    const touched = fields().some((f) => (f.type === "checkbox" ? f.checked : f.value.trim() !== ""));
    if (gradeField) gradeField.value = touched ? grade(total) : "";
  }

  /* ---------- events ---------- */

  const onClick = (e) => {
    if (isPointsField(e.target)) activate(e.target);
  };
  const onFocus = (e) => {
    if (!isPointsField(e.target)) return;
    if (e.target !== current) activate(e.target);
    if (e.target.type === "text") e.target.select();
  };
  const onInput = (e) => {
    if (!root.contains(e.target)) return;
    update();
    onChange();
  };
  const onKey = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target;
    if (!isPointsField(target) && target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]")) return;
    if (!isPointsField(target) && current && !root.contains(current)) return;

    const k = e.key;
    const step = k === "ArrowRight" || k === "ArrowDown" ? 1 : k === "ArrowLeft" || k === "ArrowUp" ? -1 : 0;
    const el = isPointsField(target) ? target : current;
    if (!el) {
      if (!step || !root.isConnected) return;
      e.preventDefault();
      activate(fields()[0]);
      return;
    }
    if (step) {
      e.preventDefault();
      move(el, step);
      return;
    }
    const focused = el === target;
    if (el.type === "checkbox") {
      if (k === " " && focused) return; // native toggle -> change event
      if (k === " ") el.checked = !el.checked;
      else if (k === "1") el.checked = true;
      else if (k === "0") el.checked = false;
      else return;
      e.preventDefault();
      activate(el);
      update();
      onChange();
    } else if (!focused && /^[\d,.]$/.test(k)) {
      activate(el);
    }
  };

  root.addEventListener("click", onClick);
  root.addEventListener("focusin", onFocus);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onInput);
  root.addEventListener("submit", (e) => e.preventDefault());
  document.addEventListener("keydown", onKey);

  for (const f of fields()) f.tabIndex = 0;
  for (const el of $$('[data-type="sum"] input, #SumPointsTotal, #Grade')) {
    el.readOnly = true;
    el.tabIndex = -1;
  }
  update();

  return {
    /** all field values by PDF field name */
    values() {
      const out = {};
      for (const el of $$("input[name]")) out[el.name] = el.type === "checkbox" ? el.checked : el.value;
      return out;
    },
    /** set fields (computed ones are recomputed instead) */
    apply(values) {
      for (const [name, value] of Object.entries(values ?? {})) {
        if (COMPUTED(name)) continue;
        for (const el of $$(`input[name="${CSS.escape(name)}"]`)) {
          if (el.type === "checkbox") el.checked = value === true || value === "true";
          else el.value = value == null ? "" : String(value);
        }
      }
      update();
    },
    /** name of the active points field (to keep the position across students) */
    currentField() {
      return current && root.contains(current) ? current.name : null;
    },
    /** make a points field active again, e.g. after loading the next student */
    activateField(name) {
      const el = name && root.querySelector(`input[name="${CSS.escape(name)}"]`);
      if (el && isPointsField(el)) activate(el);
    },
    clear() {
      for (const el of $$("input[name]")) {
        if (el.type === "checkbox") el.checked = false;
        else el.value = "";
      }
      update();
    },
    destroy() {
      document.removeEventListener("keydown", onKey);
    },
  };
}

/* ---------- standalone page: form with JSON download / load ---------- */

/** the exam metadata plus all fields, as downloaded (keys = PDF field names) */
function pageData(root, values) {
  const exam = root.querySelector('[data-type="exam"]');
  return {
    examName: exam?.dataset.examName ?? null,
    title: exam?.dataset.title ?? null,
    date: exam?.dataset.date ?? null,
    maxPoints: Number(exam?.dataset.points) || null,
    exported: new Date().toISOString(),
    fields: values,
  };
}

/**
 * Wire a standalone page: grading on the form, "JSON herunterladen" saves all
 * fields as <Name>.json, "JSON laden" reads such a file back.
 */
export function initPage(doc = document) {
  const form = doc.getElementById("exam-form");
  if (!form) return null;
  const g = attachGrading(form);

  doc.querySelector('[data-action="download"]')?.addEventListener("click", () => {
    const data = pageData(form, g.values());
    // "<Name>.json" when a name is entered, otherwise exam name and title
    const person = String(data.fields.Name ?? "").trim();
    const base = person || [data.examName, data.title].filter(Boolean).join("-") || "exam";
    const a = doc.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = base.replace(/[^\p{L}\p{N}._-]+/gu, "_") + ".json";
    doc.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  const input = doc.querySelector('[data-action="load-file"]');
  doc.querySelector('[data-action="load"]')?.addEventListener("click", () => {
    input.value = "";
    input.click();
  });
  input?.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      alert(`Die Datei konnte nicht gelesen werden: ${err.message}`);
      return;
    }
    if (!data || typeof data.fields !== "object" || data.fields === null) {
      alert('Die Datei enthält keine Felddaten ("fields" fehlt).');
      return;
    }
    const exam = form.querySelector('[data-type="exam"]');
    const other = [
      ["Klausur", data.examName, exam?.dataset.examName],
      ["Titel", data.title, exam?.dataset.title],
    ].filter(([, a, b]) => a != null && b != null && a !== b);
    if (other.length) {
      const msg = other.map(([k, a, b]) => `${k}: Datei „${a}“, Seite „${b}“`).join("\n");
      if (!confirm(`Die Datei passt nicht zu dieser Klausur:\n${msg}\n\nTrotzdem laden?`)) return;
    }
    const known = new Set([...form.querySelectorAll("input[name]")].map((el) => el.name));
    const unknown = Object.keys(data.fields).filter((n) => !known.has(n));
    g.apply(data.fields);
    if (unknown.length) alert(`Felder geladen. Unbekannt und ignoriert: ${unknown.join(", ")}`);
  });
  return g;
}
