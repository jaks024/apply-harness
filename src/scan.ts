import type { Frame, Page } from "patchright";

export type FieldKind =
  | "text" | "textarea" | "email" | "tel" | "url" | "number" | "date" | "password"
  | "select" | "radio" | "checkbox" | "checkboxes" | "combobox" | "buttons" | "file";

export interface Field {
  ref: string;
  frame: number;
  kind: FieldKind;
  label: string;
  options?: string[];
  required: boolean;
  value: string;
  filled: boolean;
  placeholder?: string;
  error?: string;
  automationId?: string;
  /** id / name / automation ids of a name box, for diagnosing mislabelled Workday name fields. */
  marks?: string;
}

export interface Button { ref: string; frame: number; text: string; disabled: boolean }

export interface Snapshot {
  url: string;
  title: string;
  headings: string[];
  errors: string[];
  fields: Field[];
  buttons: Button[];
  text: string;
  captcha: boolean;
}

interface FrameScan { fields: Omit<Field, "frame">[]; buttons: Omit<Button, "frame">[]; headings: string[]; errors: string[]; text: string; captcha: boolean }

/** Runs inside each frame. Must be self-contained. Tags elements with data-hx refs that stay stable across rescans. */
function scanInFrame(prefix: string): FrameScan {
  const w = window as unknown as { __hxN?: number };
  w.__hxN = w.__hxN ?? 0;
  const tag = (el: Element, ref?: string) => {
    let r = el.getAttribute("data-hx");
    if (!r) { r = ref ?? `${prefix}-${++w.__hxN!}`; el.setAttribute("data-hx", r); }
    return r;
  };
  const txt = (el: Element | null | undefined) => ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    return el.getClientRects().length > 0;
  };
  const clean = (s: string) => s.replace(/\s*[*✱]\s*$/, "").replace(/\s*\(required\)\s*$/i, "").replace(/\s+/g, " ").trim().slice(0, 300);
  const isReqText = (s: string) => /\*\s*$|\(required\)/i.test(s.trim());
  // Open shadow roots too (SmartRecruiters OneClick, other web-component forms): every query below looks in all of them.
  const ROOTS: (Document | ShadowRoot)[] = [document];
  for (let i = 0; i < ROOTS.length; i++) for (const e of Array.from(ROOTS[i].querySelectorAll("*"))) { const sr = (e as HTMLElement).shadowRoot; if (sr) ROOTS.push(sr); }
  const qa = (sel: string): Element[] => (ROOTS.length === 1 ? Array.from(document.querySelectorAll(sel)) : ROOTS.flatMap((r) => Array.from(r.querySelectorAll(sel))));
  const q1 = (sel: string): Element | null => { for (const r of ROOTS) { const e = r.querySelector(sel); if (e) return e; } return null; };
  const byId = (id: string): Element | null => { for (const r of ROOTS) { const e = r.getElementById(id); if (e) return e; } return null; };
  /** label[for=id], looked up in the element's own (shadow) root first. */
  const labelFor = (el: Element, id: string): Element | null => (el.getRootNode() as Document | ShadowRoot).querySelector?.(`label[for="${CSS.escape(id)}"]`) ?? q1(`label[for="${CSS.escape(id)}"]`);
  /** Text of a shadow-DOM button whose label is slotted in from its host. */
  const hostText = (el: Element) => { const r = el.getRootNode(); return r instanceof ShadowRoot ? txt(r.host) : ""; };
  const containerSel = '[data-automation-id^="formField"], fieldset, [role="group"], [role="radiogroup"], .field, .form-group, .application-question, .application-field, [class*="question" i], [class*="formfield" i], [class*="FormField"], [class*="field-wrapper" i], [class*="field-entry" i], [class*="fieldEntry"], li';

  /** Everything that can name a Workday name box's part: id, name, its own and its wrapper's data-automation-id. */
  function nameMarks(el: Element): string {
    const wrap = el.closest('[data-automation-id^="formField"]');
    return `${(el as HTMLElement).id} ${el.getAttribute("name") ?? ""} ${el.getAttribute("data-automation-id") ?? ""} ${wrap?.getAttribute("data-automation-id") ?? ""}`;
  }

  function labelOf(el: Element): string {
    let base = labelOf0(el);
    // Workday name boxes: the ids say which part it is. Some tenants' label lookup lands on the neighbouring box's
    // label, so Last Name read "Middle Name" (and got "N/A"), or Middle Name read "Last Name" (and got the last name
    // twice). Tenants mark the part in the id ("name--legalName--lastName"), the name, the input's data-automation-id
    // ("legalNameSection_middleName") or the field wrapper's ("formField-legalName--middleName"). Trust those.
    const marks = nameMarks(el);
    const part = marks.match(/(?:Name--|NameSection_|Name_)(firstName|middleName|lastName|secondaryLastName)\b/i)?.[1].toLowerCase();
    if (part) {
      const want: Record<string, [string, RegExp]> = { firstname: ["First Name", /first|given/i], middlename: ["Middle Name", /middle/i], lastname: ["Last Name", /last|family|surname/i], secondarylastname: ["Second Last Name", /second/i] };
      const [name, ok] = want[part];
      // A borrowed label's star belongs to the neighbour; a "required" Middle Name would bypass its skip rule.
      if (!ok.test(base)) base = /[*✱]\s*$/.test(base) && part !== "middlename" ? `${name} *` : name;
    }
    // Workday's preferred-name boxes are labelled just "First Name"/"Last Name"; only their ids say preferredName.
    if (/preferredName/i.test(marks) && !/preferred/i.test(base)) return `Preferred ${base.trim()}`;
    // Workday dates: two spin boxes labelled "Month" and "Year" inside a fieldset whose legend says From / To.
    if (/^(month|year|day)$/i.test(base.trim())) {
      const lg = el.closest("fieldset")?.querySelector("legend");
      const t = lg ? txt(lg).replace(/[*✱]\s*$/, "").trim() : "";
      if (t && t.length < 60) return `${t} ${base.trim()}`;
    }
    return base;
  }

  /** Lever-style question blocks: the question is the block's text minus its answer area ("Yes No", the textarea). */
  function questionText(el: Element): string {
    const q = el.closest('.application-question, [class*="custom-question" i]');
    if (!q) return "";
    let t = txt(q);
    const box = el.closest(".application-field");
    if (box && q.contains(box)) { const bt = txt(box); if (bt) t = t.split(bt).join(" "); }
    t = t.replace(/\s+/g, " ").trim();
    return t.replace(/[*✱\s]/g, "") && t.length < 400 ? t : "";
  }

  function labelOf0(el: Element): string {
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((id) => byId(id)).filter(Boolean).map((e) => txt(e)).join(" ");
      if (t.replace(/[*✱\s]/g, "")) return t;
    }
    const id = (el as HTMLElement).id;
    if (id) {
      const l = labelFor(el, id);
      if (l && txt(l).replace(/[*✱\s]/g, "")) return txt(l);
    }
    const wrap = el.closest("label");
    if (wrap && txt(wrap).replace(/[*✱\s]/g, "")) return txt(wrap);
    // Workday dropdown buttons carry aria-label "Select One Required": a placeholder, not the question.
    const al = el.getAttribute("aria-label");
    if (al && !/^(select( one)?|choose( one)?|please select|search)\b/i.test(al.trim())) return al;
    const qt = questionText(el);
    if (qt) return qt;
    const c = el.closest(containerSel);
    if (c) {
      const l = c.querySelector('label, legend, [class*="label" i], [data-automation-id="formLabel"]');
      if (l && !l.contains(el) && txt(l).replace(/[*✱\s]/g, "")) return txt(l);
    }
    // Web components: the label lives inside the component's shadow root, on a host as label="…"/aria-label="Select …",
    // or (SmartRecruiters screening questions) on the question component several levels up. Climb the composed tree
    // (parent, or the host of a shadow root) so slotted and shadow elements both get there.
    const root = el.getRootNode();
    if (root instanceof ShadowRoot) {
      // A label that is only the required marker ("*") names nothing.
      const labs = Array.from(root.querySelectorAll("label")).filter((x) => txt(x).replace(/[*✱\s]/g, ""));
      if (labs.length === 1) return txt(labs[0]);
    }
    const upc = (e: Element): Element | null => e.parentElement ?? (e.getRootNode() instanceof ShadowRoot ? (e.getRootNode() as ShadowRoot).host : null);
    {
      for (let a: Element | null = upc(el), d = 0; a && d < 16; a = upc(a), d++) {
        if (!a.tagName.includes("-")) continue;
        // Checkbox components carry their text as slotted content (SmartRecruiters consent box).
        if ((el as HTMLInputElement).type === "checkbox" && /checkbox/i.test(a.tagName)) { const t = txt(a); if (t.replace(/[*✱\s]/g, "") && t.length < 400) return t; }
        const attr = (a.getAttribute("label") || a.getAttribute("aria-label") || "").replace(/^select\s+/i, "").trim();
        if (attr) return attr + (a.hasAttribute("required") && !/\*\s*$/.test(attr) ? " *" : "");
        if (/^sr-question/i.test(a.tagName)) {
          const line = ((a as HTMLElement).innerText ?? "").split("\n").map((x) => x.trim()).find((x) => x && x !== "*" && !/^\d+\s*\/\s*\d+$/.test(x));
          if (line) return line;
        }
      }
    }
    const ph = el.getAttribute("placeholder");
    if (ph) return ph;
    const prev = el.previousElementSibling;
    if (prev && txt(prev) && txt(prev).length < 200) return txt(prev);
    return el.getAttribute("name") ?? id ?? "";
  }

  function groupLabel(els: Element[]): string {
    const qt = questionText(els[0]);
    if (qt) return qt;
    let anc: Element | null = els[0].parentElement;
    while (anc && !els.every((e) => anc!.contains(e))) anc = anc.parentElement;
    for (let a: Element | null = anc, depth = 0; a && depth < 4; a = a.parentElement, depth++) {
      const lb = a.getAttribute("aria-labelledby");
      if (lb) { const t = lb.split(/\s+/).map((i) => byId(i)).filter(Boolean).map((e) => txt(e)).join(" "); if (t) return t; }
      const cands = Array.from(a.querySelectorAll('legend, label, [class*="label" i], [data-automation-id="formLabel"], p, span, div'))
        .filter((l) => !l.querySelector("input,select,textarea,button") && !els.some((e) => l.contains(e) || e.closest("label") === l) && txt(l).length > 2);
      if (cands.length) return txt(cands[0]);
      const al = a.getAttribute("aria-label");
      if (al) return al;
    }
    return "";
  }

  const fields: FrameScan["fields"] = [];
  const seen = new Set<Element>();

  // Native inputs, textareas, selects
  const radiosByName = new Map<string, HTMLInputElement[]>();
  const checksByName = new Map<string, HTMLInputElement[]>();
  for (const el of qa("input, textarea, select") as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[]) {
    const type = (el.getAttribute("type") ?? (el.tagName === "TEXTAREA" ? "textarea" : el.tagName === "SELECT" ? "select" : "text")).toLowerCase();
    if (["hidden", "submit", "button", "image", "reset", "search"].includes(type) && !(type === "search" && el.closest('[data-automation-id="multiselectInputContainer"]'))) continue;
    // Comboboxes and Workday search prompts (School, Field of Study, "How did you hear"): typing alone picks nothing,
    // or lets Workday pick its first hit; they're filled as search-and-choose below.
    if (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") || el.getAttribute("data-automation-id") === "searchBox" || el.closest('[data-automation-id="multiselectInputContainer"]')) continue;
    if (type === "file") {
      seen.add(el);
      // Upload buttons are usually all labelled "Attach"; the slot's own heading ("Resume/CV", "Cover Letter") sits higher up.
      let slot = "";
      // Parent steps cross shadow-root boundaries (SmartRecruiters puts the dropzone in a component under "Resume *").
      // Inside web components (SmartRecruiters): climb through the components; the first short text that isn't the
      // dropzone's own ("Choose a file…", "10MB size limit") names the slot, e.g. "Resume *". An apply-with-resume
      // component is the autofill box.
      const start: Element = el;
      if (el.getRootNode() instanceof ShadowRoot) {
        const upc = (e: Element): Element | null => e.parentElement ?? (e.getRootNode() instanceof ShadowRoot ? (e.getRootNode() as ShadowRoot).host : null);
        for (let a: Element | null = upc(el), d = 0; a && d < 10 && !slot; a = upc(a), d++) {
          if (/apply-with-resume|autofill|resume-pars/i.test(a.tagName)) { slot = "Autofill from resume"; break; }
          const t = txt(a);
          if (t && t.length < 60 && !/drop (it|them|files?)|choose a file|size limit|^or\b/i.test(t)) slot = t;
        }
      }
      for (let a: Element | null = el.parentElement, d = 0; a && d < 7 && !slot; a = a.parentElement, d++) {
        const head = Array.from(a.querySelectorAll('label, legend, [class*="label" i], h3, h4, [class*="title" i], [class*="header" i]')).find((h) => !h.closest("button, [role=button]") && !h.contains(el) && !h.contains(start) && !start.contains(h) && !/size limit/i.test(txt(h)) && !/^(attach|upload|browse|choose (a )?file|enter manually)|drop (it|them|files?|your)|choose a file/i.test(txt(h)) && txt(h).length > 2 && txt(h).length < 80);
        if (head) slot = txt(head);
      }
      const label = [slot, labelOf(el), el.id, el.getAttribute("name")].filter((x) => x && !/^(attach|upload)$/i.test(x)).join(" ") || txt(el.closest(containerSel)) || "file upload";
      fields.push({ ref: tag(el), kind: "file", label: clean(label), required: (el as HTMLInputElement).required || isReqText(label), value: (el as HTMLInputElement).files?.length ? (el as HTMLInputElement).files![0].name : "", filled: !!(el as HTMLInputElement).files?.length, automationId: el.getAttribute("data-automation-id") ?? undefined });
      continue;
    }
    // Hidden helper inputs (react-select "requiredInput", honeypots) are not questions.
    if (/requiredinput|honeypot|dummy/i.test(String((el as HTMLElement).className)) || (el.getAttribute("aria-hidden") === "true" && el.getAttribute("tabindex") === "-1")) continue;
    if (type !== "radio" && type !== "checkbox" && getComputedStyle(el).opacity === "0" && (el as HTMLElement).offsetWidth <= 2) continue;
    const lab = el.closest("label");
    const shown = visible(el) || (lab ? visible(lab) : false) || (type === "radio" || type === "checkbox" ? !!el.parentElement && visible(el.parentElement) : false);
    if (!shown || (el as HTMLInputElement).disabled) continue;
    if (type === "radio") { const k = el.getAttribute("name") ?? tag(el); radiosByName.set(k, [...(radiosByName.get(k) ?? []), el as HTMLInputElement]); continue; }
    if (type === "checkbox" && el.closest('[class*="yesno" i]')) continue; // Ashby Yes/No: the buttons are the field
    if (type === "checkbox") { const k = el.getAttribute("name") ?? tag(el); checksByName.set(k, [...(checksByName.get(k) ?? []), el as HTMLInputElement]); continue; }
    seen.add(el);
    const label = labelOf(el);
    const required = el.required || el.getAttribute("aria-required") === "true" || isReqText(label);
    if (el.tagName === "SELECT") {
      const s = el as HTMLSelectElement;
      const options = Array.from(s.options).map((o) => o.text.trim()).filter((t) => t && !/^(select|choose|--|please select)/i.test(t));
      const cur = s.selectedIndex >= 0 ? s.options[s.selectedIndex].text.trim() : "";
      const filled = !!s.value && !/^(select|choose|--|please select)/i.test(cur);
      fields.push({ ref: tag(el), kind: "select", label: clean(label), options, required, value: filled ? cur : "", filled });
      continue;
    }
    const kind = (["email", "tel", "url", "number", "date", "password", "textarea"].includes(type) ? type : "text") as FieldKind;
    const v = (el as HTMLInputElement).value ?? "";
    fields.push({ ref: tag(el), kind, label: clean(label), required, value: kind === "password" ? (v ? "••••" : "") : v, filled: !!v.trim(), placeholder: el.getAttribute("placeholder") ?? undefined, automationId: el.getAttribute("data-automation-id") ?? undefined, error: el.getAttribute("aria-invalid") === "true" ? "invalid" : undefined, marks: /name/i.test(label) ? nameMarks(el).replace(/\s+/g, " ").trim() || undefined : undefined });
  }

  const optLabel = (o: HTMLInputElement) => {
    const id = o.id; const l = id ? labelFor(o, id) : null;
    const real = (t: string) => (t.replace(/[*✱\s]/g, "") ? t : "");
    return real(txt(l)) || real(txt(o.closest("label"))) || o.getAttribute("aria-label") || (/^on$/i.test(o.value) ? labelOf(o) : o.value);
  };
  for (const [, group] of radiosByName) {
    const ref = tag(group[0].closest('[role="radiogroup"], fieldset') ?? group[0], undefined);
    group.forEach((o, i) => o.setAttribute("data-hx-opt", `${ref}.${i}`));
    const label = groupLabel(group);
    const checked = group.find((o) => o.checked);
    fields.push({ ref, kind: "radio", label: clean(label), options: group.map(optLabel), required: group.some((o) => o.required) || isReqText(label), value: checked ? optLabel(checked) : "", filled: !!checked });
  }
  for (const [, group] of checksByName) {
    if (group.length === 1) {
      const o = group[0];
      fields.push({ ref: tag(o), kind: "checkbox", label: clean(optLabel(o) || labelOf(o)), required: o.required || o.getAttribute("aria-required") === "true" || isReqText(optLabel(o)), value: o.checked ? "checked" : "", filled: o.checked });
    } else {
      const ref = tag(group[0].closest("fieldset, [role=group]") ?? group[0].parentElement ?? group[0]);
      group.forEach((o, i) => o.setAttribute("data-hx-opt", `${ref}.${i}`));
      const label = groupLabel(group);
      fields.push({ ref, kind: "checkboxes", label: clean(label), options: group.map(optLabel), required: isReqText(label), value: group.filter((o) => o.checked).map(optLabel).join(" ;; "), filled: group.some((o) => o.checked) });
    }
  }

  // ARIA checkboxes/radios (custom widgets)
  for (const el of qa('[role="checkbox"]')) {
    if (!visible(el) || el.querySelector("input")) continue;
    const label = labelOf(el) || txt(el);
    fields.push({ ref: tag(el), kind: "checkbox", label: clean(label), required: el.getAttribute("aria-required") === "true" || isReqText(label), value: el.getAttribute("aria-checked") === "true" ? "checked" : "", filled: el.getAttribute("aria-checked") === "true" });
  }

  // Comboboxes: ARIA comboboxes, autocomplete inputs, Workday listbox buttons
  const combos = qa('[role="combobox"], input[aria-autocomplete], button[aria-haspopup="listbox"], [data-automation-id="multiselectInputContainer"] input, input[data-automation-id="searchBox"]');
  for (const el of combos) {
    if (seen.has(el) || !visible(el)) continue;
    seen.add(el);
    const label = labelOf(el);
    let value = "";
    if (el.tagName === "BUTTON") value = txt(el);
    else {
      value = (el as HTMLInputElement).value ?? "";
      // The control wraps both the input and the chosen value; the input's own wrapper ("select__input-container") does not.
      const ctl = el.closest('[class*="__control"], [class*="-control"], [data-automation-id="multiselectInputContainer"]') ?? el.closest('[class*="select" i]')?.parentElement;
      const chosen = Array.from(ctl?.querySelectorAll('[class*="single-value" i], [class*="singleValue"], [data-automation-id="selectedItem"], [class*="multi-value__label" i], [class*="multiValue"] [class*="label" i]') ?? []);
      if (chosen.length) value = chosen.map((c) => txt(c)).join(" ;; ");
    }
    const empty = !value || /^(select( one)?|choose|--|please select|start typing|search)\b/i.test(value) || value === "0 items selected";
    fields.push({ ref: tag(el), kind: "combobox", label: clean(label), required: el.getAttribute("aria-required") === "true" || isReqText(label), value: empty ? "" : value, filled: !empty, automationId: el.getAttribute("data-automation-id") ?? undefined, error: el.getAttribute("aria-invalid") === "true" ? "invalid" : undefined });
  }

  // ARIA radio groups built from buttons (Oracle Recruiting "pills"): the group's aria-label is the question.
  for (const g of qa('[role="radiogroup"]')) {
    const opts = Array.from(g.querySelectorAll('[role="radio"]')).filter((o) => o.tagName !== "INPUT" && visible(o));
    if (opts.length < 2 || opts.some((o) => o.hasAttribute("data-hx-opt"))) continue;
    const ref = tag(g);
    opts.forEach((o, i) => o.setAttribute("data-hx-opt", `${ref}.${i}`));
    const label = g.getAttribute("aria-label") || groupLabel(opts);
    const sel = opts.find((o) => o.getAttribute("aria-checked") === "true");
    fields.push({ ref, kind: "buttons", label: clean(label), options: opts.map((o) => txt(o)), required: g.getAttribute("aria-required") === "true" || isReqText(label), value: sel ? txt(sel) : "", filled: !!sel });
  }

  // Yes/No button groups (Ashby and similar)
  for (const c of qa(containerSel)) {
    const btns = Array.from(c.querySelectorAll(":scope button, :scope [role=button]")).filter((b) => visible(b) && b.closest(containerSel) === c);
    if (btns.length < 2 || btns.length > 5) continue;
    const opts = btns.map((b) => txt(b));
    if (!opts.every((t) => /^(yes|no|n\/a|maybe|prefer not to say)$/i.test(t))) continue;
    const ref = tag(c);
    btns.forEach((b, i) => b.setAttribute("data-hx-opt", `${ref}.${i}`));
    const label = groupLabel(btns);
    const sel = btns.find((b) => b.getAttribute("aria-pressed") === "true" || /active|selected|checked/i.test(b.className));
    fields.push({ ref, kind: "buttons", label: clean(label), options: opts, required: isReqText(label), value: sel ? txt(sel) : "", filled: !!sel });
  }

  // Buttons
  const buttons: FrameScan["buttons"] = [];
  for (const b of qa('button, [role="button"], input[type="submit"], input[type="button"], a[class*="button" i], a[class*="btn" i], a[href*="apply" i], [data-automation-id="click_filter"]')) {
    if (b.hasAttribute("data-hx-opt") || b.getAttribute("aria-haspopup") === "listbox") continue;
    if (!visible(b)) continue;
    const t = (txt(b) || (b as HTMLInputElement).value || b.getAttribute("aria-label") || hostText(b) || "").slice(0, 80);
    if (!t || t.length > 60) continue;
    buttons.push({ ref: tag(b), text: t, disabled: (b as HTMLButtonElement).disabled || b.getAttribute("aria-disabled") === "true" });
  }

  const headings = qa('h1, h2, h3, [data-automation-id="progressBarActiveStep"], [aria-current="step"]').filter(visible).map((h) => txt(h)).filter((t) => t && t.length < 120).slice(0, 12);
  const errors = qa('[role="alert"], [data-automation-id="errorMessage"], [class*="error" i]:not(input):not(form):not(body), [class*="invalid" i]:not(input)')
    .filter((e) => visible(e) && txt(e).length > 2 && txt(e).length < 300 && !e.querySelector("input,select,textarea")).map((e) => txt(e)).slice(0, 15);
  const captcha = !!document.querySelector('iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"][src*="challenge"], iframe[src*="challenges.cloudflare.com"]') &&
    Array.from(document.querySelectorAll('iframe[src*="bframe"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"]')).some(visible);
  return { fields, buttons, headings, errors: Array.from(new Set(errors)), text: (document.body?.innerText ?? "").slice(0, 6000), captcha };
}

// tsx/esbuild wraps named functions in __name(...) calls that don't exist in the page; define a no-op there.
const SCAN_SRC = `(() => { const __name = (t) => t; return (${scanInFrame.toString()})(__PREFIX__); })()`;

export async function scan(page: Page): Promise<Snapshot> {
  const frames = page.frames();
  const out: Snapshot = { url: page.url(), title: await page.title().catch(() => ""), headings: [], errors: [], fields: [], buttons: [], text: "", captcha: false };
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.isDetached()) continue;
    const u = f.url();
    if (i > 0 && (!u || u === "about:blank" || /recaptcha|hcaptcha|cloudflare|doubleclick|google\.com\/maps|youtube|facebook|linkedin\.com\/px/.test(u))) continue;
    let r: FrameScan;
    // A hung renderer never answers; give each frame 10s so a stuck tab can't freeze the job.
    try { r = await withTimeout(f.evaluate(SCAN_SRC.replace("__PREFIX__", JSON.stringify(`f${i}`))), 10_000, `scan of frame ${i}`); } catch { continue; }
    out.fields.push(...r.fields.map((x) => ({ ...x, frame: i })));
    out.buttons.push(...r.buttons.map((x) => ({ ...x, frame: i })));
    out.headings.push(...r.headings);
    out.errors.push(...r.errors);
    out.text += (out.text ? "\n" : "") + r.text;
    out.captcha ||= r.captcha;
  }
  out.text = out.text.slice(0, 12000);
  return out;
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export function frameOf(page: Page, f: { frame: number }): Frame {
  return page.frames()[f.frame] ?? page.mainFrame();
}

/** Compact text view for the LLM rescue agent. */
export function renderSnapshot(s: Snapshot): string {
  const lines = [`URL: ${s.url}`, `Title: ${s.title}`];
  if (s.headings.length) lines.push(`Headings: ${s.headings.join(" | ")}`);
  if (s.captcha) lines.push("CAPTCHA challenge is visible.");
  if (s.errors.length) lines.push(`Errors: ${s.errors.join(" | ")}`);
  lines.push("Fields:");
  for (const f of s.fields) {
    const opts = f.options?.length ? ` options=[${f.options.slice(0, 25).join(" / ")}]` : "";
    lines.push(`  [${f.ref}] ${f.kind}${f.required ? " *required*" : ""} "${f.label}"${opts} value="${f.value.slice(0, 80)}"${f.error ? " INVALID" : ""}`);
  }
  lines.push("Buttons:");
  for (const b of s.buttons) lines.push(`  [${b.ref}] "${b.text}"${b.disabled ? " (disabled)" : ""}`);
  return lines.join("\n");
}
