import type { Frame, Locator, Page } from "patchright";
import { bestOption, bestPlace, isExactOption, norm, ruledOut } from "./match.js";
import { frameOf, withTimeout, type Field } from "./scan.js";

export interface FillResult { ok: boolean; note?: string; chosen?: string; options?: string[] }

const loc = (fr: Frame, ref: string): Locator => fr.locator(`[data-hx="${ref}"]`).first();
const optLoc = (fr: Frame, ref: string, i: number): Locator => fr.locator(`[data-hx-opt="${ref}.${i}"]`).first();

/** Formats an ISO-ish date (YYYY-MM-DD / YYYY-MM) for the field's placeholder convention. */
export function formatDateFor(field: Field, value: string): string {
  const m = value.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return value;
  const [, y, mo, d = "01"] = m;
  if (field.kind === "date") return `${y}-${mo}-${d}`;
  const ph = (field.placeholder ?? field.label).toLowerCase();
  if (/mm\s*\/\s*yyyy/.test(ph)) return `${mo}/${y}`;
  if (/dd\s*\/\s*mm/.test(ph)) return `${d}/${mo}/${y}`;
  if (/yyyy-mm-dd/.test(ph)) return `${y}-${mo}-${d}`;
  return `${mo}/${d}/${y}`;
}

async function typeInto(l: Locator, page: Page, value: string) {
  await l.click({ timeout: 4000 }).catch(() => {});
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await l.pressSequentially(value, { delay: 15 });
}

export async function fillField(page: Page, field: Field, value: string, files: { resume: string; transcript: string }): Promise<FillResult> {
  const fr = frameOf(page, field);
  const l = loc(fr, field.ref);
  try {
    switch (field.kind) {
      case "file": {
        const path = value === "transcript" ? files.transcript : files.resume;
        await l.setInputFiles(path, { timeout: 8000 });
        return { ok: true, chosen: path.split(/[\\/]/).pop() };
      }
      case "select": {
        const opt = bestOption(value, field.options ?? []);
        if (!opt) return { ok: false, note: `no option matches "${value}"` };
        await l.selectOption({ label: opt }, { timeout: 5000 }).catch(async () => {
          const all = await l.locator("option").allTextContents();
          const raw = all.find((t) => t.trim() === opt);
          await l.selectOption({ label: raw ?? opt });
        });
        return { ok: true, chosen: opt };
      }
      case "radio":
      case "buttons": {
        const opts = field.options ?? [];
        const opt = bestOption(value, opts);
        if (!opt) return { ok: false, note: `no option matches "${value}"` };
        const o = optLoc(fr, field.ref, opts.indexOf(opt));
        if (field.kind === "radio") {
          // Ashby/Lever-style radios are invisible inputs (opacity 0) under a visible label. Force-checking the input can
          // tick it visually without the form's own state noticing, so click the label like a person, then verify.
          await clickLabelOf(fr, o);
          if (!(await o.isChecked().catch(() => false))) await o.check({ force: true, timeout: 4000 }).catch(() => o.click({ force: true, timeout: 4000 }).catch(() => {}));
          if (!(await o.isChecked().catch(() => true))) return { ok: false, note: `"${opt}" did not stay selected` };
        } else {
          // Yes/No buttons (Ashby): the pick shows as aria-pressed="true". Click, confirm it took (once more if not),
          // then move focus off it: Ashby only commits the answer once the button loses focus.
          const pressed = () => o.evaluate((el) => el.getAttribute("aria-pressed") ?? el.getAttribute("aria-checked") ?? (/active|selected|checked/i.test(el.className) ? "true" : null), undefined, { timeout: 3000 }).catch(() => null);
          await o.click({ timeout: 5000 });
          await page.waitForTimeout(150);
          if ((await pressed()) === "false") { await o.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(150); }
          await o.evaluate((el) => (el as HTMLElement).blur(), undefined, { timeout: 2000 }).catch(() => {});
          if ((await pressed()) === "false") return { ok: false, note: `"${opt}" did not stay selected` };
        }
        return { ok: true, chosen: opt };
      }
      case "checkbox": {
        const want = /^(yes|true|checked|check|agree|1)$/i.test(value.trim());
        const isAria = (await l.getAttribute("role")) === "checkbox";
        if (isAria) {
          const cur = (await l.getAttribute("aria-checked")) === "true";
          if (cur !== want) await l.click({ timeout: 5000 });
        } else {
          const state = (fallback: boolean) => l.evaluate((el) => (el as HTMLInputElement).checked || el.getAttribute("aria-checked") === "true", undefined, { timeout: 3000 }).catch(() => fallback);
          if ((await state(!want)) !== want) await l.setChecked(want, { force: true, timeout: 4000 }).catch(() => {});
          await page.waitForTimeout(150);
          if ((await state(!want)) !== want) await clickLabelOf(fr, l);
          await page.waitForTimeout(150);
          // Terms checkboxes that open the terms in a dialog (Oracle): accept it there; that ticks the box.
          if (want && (await state(!want)) !== want) {
            const agree = page.locator('[role="dialog"] button, [role="alertdialog"] button, .oj-dialog button').filter({ hasText: /^\s*(i )?(agree|accept)( and continue)?\s*$/i }).first();
            if (await agree.isVisible().catch(() => false)) { await agree.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(400); }
          }
          // Gone after the click usually means the form re-drew around it (Workday "I have a preferred name"): fine.
          if ((await state(want)) !== want) return { ok: false, note: "checkbox did not change" };
        }
        return { ok: true, chosen: want ? "checked" : "unchecked" };
      }
      case "checkboxes": {
        const opts = field.options ?? [];
        const wanted = value.split(/\s*;;\s*/).map((v) => bestOption(v, opts)).filter((x): x is string => !!x);
        if (!wanted.length) return { ok: false, note: `no options match "${value}"` };
        for (const w of wanted) await optLoc(fr, field.ref, opts.indexOf(w)).check({ force: true, timeout: 5000 }).catch(() => {});
        return { ok: true, chosen: wanted.join(" ;; ") };
      }
      case "combobox":
        return await fillCombobox(page, fr, l, field, value);
      case "date":
        await l.fill(formatDateFor(field, value), { timeout: 5000 });
        return { ok: true };
      default: {
        if (/^dateSection(Month|Day|Year)-input$/.test(field.automationId ?? "")) return await fillWorkdayDate(page, fr, field, value);
        const v = /^\d{4}-\d{2}(-\d{2})?$/.test(value) ? formatDateFor(field, value) : value;
        // Location boxes (Lever, many custom forms) are type-aheads: the value only counts once a suggestion is picked.
        if (v && /location|city|address/i.test(field.label)) {
          const picked = await typeAhead(page, fr, l, field.ref, v);
          if (picked) return { ok: true, chosen: picked };
        }
        await l.fill(v, { timeout: 5000 });
        const got = await l.inputValue().catch(() => v);
        if (norm(got) !== norm(v)) {
          // Masked/segmented inputs (ADP, Workday dates) keep only keystroke entry.
          await typeInto(l, page, v);
          await page.keyboard.press("Tab");
        }
        return { ok: true };
      }
    }
  } catch (e) {
    return { ok: false, note: String((e as Error).message ?? e).split("\n")[0].slice(0, 160) };
  }
}

/**
 * Options of the menu that belongs to this combobox, in page order. Runs in the page so hidden or other open lists
 * (the phone widget's 240 countries, a menu left open by another field) can't be mistaken for this one's.
 * Marks each with data-hx-optc for clicking.
 */
function optionsInPage(ref: string): string[] {
  const ROOTS: (Document | ShadowRoot)[] = [document];
  for (let i = 0; i < ROOTS.length; i++) for (const e of Array.from(ROOTS[i].querySelectorAll("*"))) { const sr = (e as HTMLElement).shadowRoot; if (sr) ROOTS.push(sr); }
  const qa = (sel: string): Element[] => ROOTS.flatMap((r) => Array.from(r.querySelectorAll(sel)));
  const q1 = (sel: string): Element | null => { for (const r of ROOTS) { const e = r.querySelector(sel); if (e) return e; } return null; };

  const vis = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden" && getComputedStyle(e).display !== "none";
  qa("[data-hx-optc]").forEach((e) => e.removeAttribute("data-hx-optc"));
  const el = q1(`[data-hx="${ref}"]`);
  const OPT = '[role="option"], [data-automation-id="promptOption"], [data-automation-id="menuItem"], [class*="__option"], [class*="-option"]';
  let opts: Element[] = [];
  // 1. ARIA wiring: aria-controls / aria-owns points at the listbox (react-select, Workday, most ARIA comboboxes)
  const id = el?.getAttribute("aria-controls") || el?.getAttribute("aria-owns");
  const lb = id ? ((el?.getRootNode() as Document | ShadowRoot | undefined)?.getElementById?.(id) ?? q1(`#${CSS.escape(id)}`)) : null;
  if (lb) opts = Array.from(lb.querySelectorAll(OPT));
  // 2. react-select and similar: the menu lives in the same container as the control
  const cont = el?.closest('[class*="select__container"], [class*="-container"]:not([class*="input-container"]), [class*="select-container"]') ?? el?.closest('[class*="select" i]')?.parentElement ?? null;
  if (!opts.length && cont) {
    const menu = cont.querySelector('[class*="menu" i]');
    if (menu) opts = Array.from(menu.querySelectorAll(OPT));
  }
  // 3. Only for widgets with no container of their own (portal menus): the single visible listbox, if exactly one
  if (!opts.length && !cont) {
    // Not other fields' lists: Workday shows each prompt's chosen items (the school already picked…) in a listbox of its own.
    const own = el?.closest('[data-automation-id^="formField"]') ?? null;
    const boxes = qa('[role="listbox"], [data-automation-id="activeListContainer"]').filter(vis)
      .filter((b, i, all) => !all.some((o) => o !== b && o.contains(b)))
      .filter((b) => !b.closest(".iti__country-list, .iti__dropdown-content"))
      .filter((b) => !b.querySelector('[data-automation-id="selectedItem"]') && b.getAttribute("data-automation-id") !== "selectedItemList")
      .filter((b) => { const ff = b.closest('[data-automation-id^="formField"]'); return !ff || ff === own; });
    if (boxes.length === 1) opts = Array.from(boxes[0].querySelectorAll(OPT));
  }
  const out: string[] = [];
  for (const o of opts) {
    if (!vis(o) || o.querySelector(OPT)) continue;
    const t = ((o as HTMLElement).innerText ?? o.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!t || /^(no options|no results|no items|no matches|loading|searching)/i.test(t)) continue;
    o.setAttribute("data-hx-optc", String(out.length));
    out.push(t);
    if (out.length >= 400) break; // Workday country lists run ~250 long; United States is near the end
  }
  return out;
}
const OPTIONS_SRC = `(() => { const __name = (t) => t; return (${optionsInPage.toString()})(__REF__); })()`;

/** What the combobox shows as chosen right now (react-select single/multi values, Workday chips, button text, input). */
function valueInPage(ref: string): string {
  const ROOTS: (Document | ShadowRoot)[] = [document];
  for (let i = 0; i < ROOTS.length; i++) for (const e of Array.from(ROOTS[i].querySelectorAll("*"))) { const sr = (e as HTMLElement).shadowRoot; if (sr) ROOTS.push(sr); }
  const qa = (sel: string): Element[] => ROOTS.flatMap((r) => Array.from(r.querySelectorAll(sel)));
  const q1 = (sel: string): Element | null => { for (const r of ROOTS) { const e = r.querySelector(sel); if (e) return e; } return null; };

  const el = q1(`[data-hx="${ref}"]`) as HTMLElement | null;
  if (!el) return "";
  const txt = (e: Element) => ((e as HTMLElement).innerText ?? e.textContent ?? "").replace(/\s+/g, " ").trim();
  if (el.tagName === "BUTTON") return txt(el);
  const ctl = el.closest('[class*="__control"], [class*="-control"], [data-automation-id="multiselectInputContainer"]') ?? el.closest('[class*="select" i]')?.parentElement;
  const chosen = Array.from(ctl?.querySelectorAll('[class*="single-value" i], [class*="singleValue"], [data-automation-id="selectedItem"], [class*="multi-value__label" i], [class*="multiValue"] [class*="label" i]') ?? []);
  if (chosen.length) return chosen.map(txt).join(" ;; ");
  // Workday search prompts list the picked item next to the box, inside the same form field.
  const wdField = el.closest('[data-automation-id^="formField"]');
  const wdChosen = Array.from(wdField?.querySelectorAll('[data-automation-id="selectedItem"], [data-automation-id="promptSelectionLabel"]') ?? []);
  if (wdChosen.length) return wdChosen.map(txt).join(" ;; ");
  return (el as HTMLInputElement).value ?? "";
}
const VALUE_SRC = `(() => { const __name = (t) => t; return (${valueInPage.toString()})(__REF__); })()`;

async function visibleOptions(fr: Frame, ref: string): Promise<{ text: string; idx: number }[]> {
  const texts = (await withTimeout(fr.evaluate(OPTIONS_SRC.replace("__REF__", JSON.stringify(ref))), 8_000, "reading options").catch(() => [])) as string[];
  return texts.map((text, idx) => ({ text, idx }));
}

async function shownValue(fr: Frame, ref: string): Promise<string> {
  return (await withTimeout(fr.evaluate(VALUE_SRC.replace("__REF__", JSON.stringify(ref))), 5_000, "reading value").catch(() => "")) as string;
}

const showsChoice = (shown: string, pick: string) => {
  const a = norm(shown), b = norm(pick);
  return !!a && (a.includes(b) || b.includes(a));
};

/** Scrolls the open menu's list one window down. Returns false at the bottom (or when the list doesn't scroll). */
function scrollMenuInPage(where: string): boolean {
  const ROOTS: (Document | ShadowRoot)[] = [document];
  for (let i = 0; i < ROOTS.length; i++) for (const e of Array.from(ROOTS[i].querySelectorAll("*"))) { const sr = (e as HTMLElement).shadowRoot; if (sr) ROOTS.push(sr); }
  const qa = (sel: string): Element[] => ROOTS.flatMap((r) => Array.from(r.querySelectorAll(sel)));
  const q1 = (sel: string): Element | null => { for (const r of ROOTS) { const e = r.querySelector(sel); if (e) return e; } return null; };

  const first = q1('[data-hx-optc="0"]');
  let box: Element | null = first?.parentElement ?? null;
  while (box && !(box.scrollHeight > box.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  if (!box || box === document.body || box === document.documentElement) return false;
  const before = box.scrollTop;
  box.scrollTop = where === "top" ? 0 : before + Math.max(40, box.clientHeight * 0.8);
  box.dispatchEvent(new Event("scroll", { bubbles: true }));
  return where === "top" ? true : box.scrollTop > before;
}
const SCROLL_SRC = `(() => { const __name = (t) => t; return (${scrollMenuInPage.toString()})(__WHERE__); })()`;
const scrollMenu = (fr: Frame, where: "down" | "top") =>
  withTimeout(fr.evaluate(SCROLL_SRC.replace("__WHERE__", JSON.stringify(where))), 4_000, "scrolling menu").catch(() => false) as Promise<boolean>;

/**
 * Lists that render only a window of their options (Workday's 250-country list shows ~8 at a time): scroll through,
 * stop on an exact match, otherwise pick the best of everything seen and scroll back to it. Returns the options as
 * currently rendered (with the pick among them) plus everything seen.
 */
async function scrollForOption(page: Page, fr: Frame, ref: string, value: string, label: string) {
  const seen: string[] = [];
  const add = (os: { text: string }[]) => { for (const o of os) if (!seen.includes(o.text)) seen.push(o.text); };
  let opts = await visibleOptions(fr, ref);
  add(opts);
  for (let i = 0; i < 80; i++) {
    const exact = opts.find((o) => isExactOption(value, o.text));
    if (exact) return { opts, pick: exact.text, seen };
    if (!(await scrollMenu(fr, "down"))) break;
    await page.waitForTimeout(120);
    opts = await visibleOptions(fr, ref);
    add(opts);
  }
  const best = (/location|city/i.test(label) ? bestPlace(value, seen) : null) ?? bestOption(value, seen);
  if (!best) return { opts, pick: null, seen };
  if (!opts.some((o) => o.text === best)) {
    await scrollMenu(fr, "top");
    for (let i = 0; i < 80; i++) {
      await page.waitForTimeout(120);
      opts = await visibleOptions(fr, ref);
      if (opts.some((o) => o.text === best) || !(await scrollMenu(fr, "down"))) break;
    }
  }
  return { opts, pick: opts.some((o) => o.text === best) ? best : null, seen };
}

/** Click the marked option; if something covers it, force the click; last resort, choose it by keyboard. */
async function chooseOption(page: Page, fr: Frame, l: Locator, idx: number, pick: string, typeable: boolean) {
  const o = fr.locator(`[data-hx-optc="${idx}"]`).first();
  try { await o.click({ timeout: 3000 }); return; } catch { /* covered or re-rendered */ }
  try { await o.click({ timeout: 2000, force: true }); return; } catch { /* still not clickable */ }
  if (typeable) {
    await l.fill("").catch(() => {});
    await l.pressSequentially(pick.slice(0, 60), { delay: 15 });
    await page.waitForTimeout(700);
    await page.keyboard.press("Enter");
  }
}

/** Suggestion items that appeared next to a plain text input after typing (Lever location, Google Places, etc.). */
function suggestionsInPage(ref: string): string[] {
  const ROOTS: (Document | ShadowRoot)[] = [document];
  for (let i = 0; i < ROOTS.length; i++) for (const e of Array.from(ROOTS[i].querySelectorAll("*"))) { const sr = (e as HTMLElement).shadowRoot; if (sr) ROOTS.push(sr); }
  const qa = (sel: string): Element[] => ROOTS.flatMap((r) => Array.from(r.querySelectorAll(sel)));
  const q1 = (sel: string): Element | null => { for (const r of ROOTS) { const e = r.querySelector(sel); if (e) return e; } return null; };

  const vis = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden" && getComputedStyle(e).display !== "none";
  qa("[data-hx-sugg]").forEach((e) => e.removeAttribute("data-hx-sugg"));
  const el = q1(`[data-hx="${ref}"]`);
  const ITEM = '.dropdown-location, [role="option"], .pac-item, [class*="suggestion" i] li, [class*="suggestion" i] > div, [class*="autocomplete" i] li, [class*="dropdown-results" i] > div';
  let scope: Element | null = el?.parentElement ?? null;
  let items: Element[] = [];
  for (let i = 0; i < 3 && scope && !items.length; i++, scope = scope.parentElement) items = Array.from(scope.querySelectorAll(ITEM)).filter(vis);
  if (!items.length) items = qa(".pac-container .pac-item").filter(vis); // Google Places renders at <body>
  const out: string[] = [];
  for (const it of items.slice(0, 15)) {
    const t = ((it as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    it.setAttribute("data-hx-sugg", String(out.length));
    out.push(t);
  }
  return out;
}
const SUGG_SRC = `(() => { const __name = (t) => t; return (${suggestionsInPage.toString()})(__REF__); })()`;

/** Types into a type-ahead and clicks the best suggestion. Returns the chosen text, or null if no suggestions showed up. */
async function typeAhead(page: Page, fr: Frame, l: Locator, ref: string, value: string): Promise<string | null> {
  for (const q of [value, value.split(",")[0].trim()]) {
    await l.click({ timeout: 4000 }).catch(() => {});
    await l.fill("").catch(() => {});
    await l.pressSequentially(q.slice(0, 50), { delay: 30 });
    await page.waitForTimeout(1300);
    const items = (await withTimeout(fr.evaluate(SUGG_SRC.replace("__REF__", JSON.stringify(ref))), 5_000, "suggestions").catch(() => [])) as string[];
    if (!items.length) continue;
    const pick = bestPlace(value, items) ?? bestOption(value, items) ?? items[0];
    await fr.locator(`[data-hx-sugg="${items.indexOf(pick)}"]`).first().click({ timeout: 3000 }).catch(() => page.keyboard.press("Enter"));
    await page.waitForTimeout(400);
    return pick;
  }
  return null;
}

/**
 * Workday dates are two spin boxes (Month, Year) that hold "6" while showing "06", sit outside the viewport, and
 * jump from month to year as you type. Click the shown month, type MM then YYYY, and read both back.
 * Accepts "2026-06", "06/2026", "062026", "6/2026", or just "06" / "2026" for a single box.
 */
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "2027-03-15", "03/15/2027", "March 15, 2027", "2026-06", "06/2026", "062026", "2026", "06" → parts. */
function dateParts(value: string): { mm: string | null; dd: string | null; yyyy: string | null } | null {
  const v = value.trim();
  let m: RegExpMatchArray | null;
  if ((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return { yyyy: m[1], mm: m[2], dd: m[3] };
  if ((m = v.match(/^(\d{4})-(\d{1,2})$/))) return { yyyy: m[1], mm: m[2], dd: null };
  if ((m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return { mm: m[1], dd: m[2], yyyy: m[3] };
  if ((m = v.match(/^(\d{1,2})\s*[\/.-]?\s*(\d{4})$/))) return { mm: m[1], dd: null, yyyy: m[2] };
  if ((m = v.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i))) {
    const i = MONTH_NAMES.indexOf(m[1].slice(0, 3).toLowerCase());
    if (i >= 0) return { mm: String(i + 1), dd: m[2], yyyy: m[3] };
  }
  if ((m = v.match(/^([a-z]{3,9})\.?,?\s+(\d{4})$/i))) {
    const i = MONTH_NAMES.indexOf(m[1].slice(0, 3).toLowerCase());
    if (i >= 0) return { mm: String(i + 1), dd: null, yyyy: m[2] };
  }
  if (/^\d{4}$/.test(v)) return { mm: null, dd: null, yyyy: v };
  if (/^\d{1,2}$/.test(v)) return { mm: v, dd: null, yyyy: null };
  return null;
}

async function fillWorkdayDate(page: Page, fr: Frame, field: Field, value: string): Promise<FillResult> {
  let parts = dateParts(value);
  const box = (field.automationId ?? "").match(/^dateSection(Month|Day|Year)-input$/)?.[1];
  // A lone number goes in the box it was meant for ("19" into Day is a day, not a month).
  if (parts && /^\d{1,2}$/.test(value.trim()) && box === "Day") parts = { mm: null, dd: value.trim(), yyyy: null };
  if (!parts) return { ok: false, note: `not a date: "${value}"` };
  let { mm, dd, yyyy } = parts;
  if (mm && (Number(mm) < 1 || Number(mm) > 12)) return { ok: false, note: `bad month "${mm}"` };
  const id = await loc(fr, field.ref).getAttribute("id", { timeout: 3000 }).catch(() => null);
  if (!id) return { ok: false, note: "date box has no id" };
  const base = id.replace(/-dateSection(Month|Day|Year)-input$/, "");
  const esc = (s: string) => s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  const monthIn = fr.locator(`#${esc(base)}-dateSectionMonth-input`);
  const dayIn = fr.locator(`#${esc(base)}-dateSectionDay-input`);
  const yearIn = fr.locator(`#${esc(base)}-dateSectionYear-input`);
  // Month/Year-only dates (work history) have no day box: drop the day. A full date into a single box fills them all.
  const hasDay = (await dayIn.count().catch(() => 0)) > 0;
  const hasMonth = (await monthIn.count().catch(() => 0)) > 0;
  if (!hasDay) dd = null;
  // Workday only types reliably from the month box onward: a lone day or year is re-typed with the other parts as
  // they stand (typing just a year into a M/D/Y date gave "2006").
  if (hasMonth && (!mm || (hasDay && !dd))) {
    const cur = async (l: Locator) => (await l.inputValue({ timeout: 2000 }).catch(() => "")).trim();
    mm = mm ?? ((await cur(monthIn)) || null);
    if (hasDay) dd = dd ?? ((await cur(dayIn)) || null);
    yyyy = yyyy ?? ((await cur(yearIn)) || null);
  }
  // Focus the spin box itself (it sits outside the viewport, so clicks miss); click its section as a fallback.
  const typeInto = async (box: Locator, section: string, digits: string) => {
    await box.focus({ timeout: 3000 }).catch(async () => { await fr.locator(`#${esc(base)}-${section}`).click({ force: true, timeout: 3000 }).catch(() => {}); });
    await page.waitForTimeout(100);
    await page.keyboard.type(digits, { delay: 60 });
  };
  if (mm) await typeInto(monthIn, "dateSectionMonth", mm.padStart(2, "0"));
  if (dd) {
    await page.waitForTimeout(150);
    await typeInto(dayIn, "dateSectionDay", dd.padStart(2, "0"));
  }
  if (yyyy) {
    await page.waitForTimeout(150);
    // After two digits Workday has already moved to the next box; focusing it again is harmless.
    await typeInto(yearIn, "dateSectionYear", yyyy);
  }
  await page.keyboard.press("Tab");
  await page.waitForTimeout(350);
  const gotM = mm ? await monthIn.inputValue({ timeout: 3000 }).catch(() => "") : "";
  const gotD = dd ? await dayIn.inputValue({ timeout: 3000 }).catch(() => "") : "";
  const gotY = yyyy ? await yearIn.inputValue({ timeout: 3000 }).catch(() => "") : "";
  const ok = (!mm || Number(gotM) === Number(mm)) && (!dd || Number(gotD) === Number(dd)) && (!yyyy || gotY === yyyy);
  const two = (x: string) => String(Number(x) || "?").padStart(2, "0");
  const shown = [mm ? two(gotM) : null, dd ? two(gotD) : null, yyyy ? gotY || "?" : null].filter(Boolean).join("/");
  const wanted = [mm?.padStart(2, "0"), dd?.padStart(2, "0"), yyyy].filter(Boolean).join("/");
  return ok ? { ok: true, chosen: shown } : { ok: false, note: `date shows ${shown}, wanted ${wanted}` };
}

/** Click the visible <label> of a radio/checkbox input (label[for=id] or a wrapping label). False if there is none. */
async function clickLabelOf(fr: Frame, input: Locator): Promise<boolean> {
  const id = await input.getAttribute("id", { timeout: 3000 }).catch(() => null);
  const byFor = id ? fr.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first() : null;
  const wrap = input.locator("xpath=ancestor::label[1]");
  for (const lab of [byFor, wrap]) {
    if (!lab || !(await lab.isVisible().catch(() => false))) continue;
    if (await lab.click({ timeout: 4000 }).then(() => true, () => false)) { await fr.page().waitForTimeout(120); return true; }
  }
  return false;
}

/** Search strings to try in a type-to-search box, most specific first: "San Diego, CA" → "San Diego, CA", "San Diego", "San". */
function queryVariants(value: string): string[] {
  const v = value.trim();
  const words = v.split(/\s+/);
  // last word too: "Supply Chain Analytics" → "Analytics" when the catalog has no "Supply Chain Analytics"
  const out = [v, v.split(/[,(\/|]/)[0].trim(), words.slice(0, 2).join(" "), words.length > 1 ? words[words.length - 1] : "", words[0]];
  // "Master's" vs "Masters"/"Master" (Oracle): also search without the apostrophe and without the 's.
  if (/['’]/.test(v)) { out.splice(1, 0, v.replace(/['’]/g, ""), v.replace(/['’]s\b/gi, "")); }
  if (/master/i.test(v)) out.push("Master", "Masters");
  if (/bachelor/i.test(v)) out.push("Bachelor", "Bachelors");
  return [...new Set(out.filter((q) => q.length >= 2))];
}

async function openMenu(page: Page, l: Locator) {
  await l.click({ timeout: 4000 }).catch(async () => {
    // Inputs inside react-select are tiny; clicking the control (or forcing) opens the menu.
    await l.locator('xpath=ancestor::*[contains(@class,"control")][1]').click({ timeout: 3000 }).catch(() => l.click({ force: true, timeout: 3000 }));
  });
  await page.waitForTimeout(350);
}

export async function fillCombobox(page: Page, fr: Frame, l: Locator, field: Field, value: string): Promise<FillResult> {
  try {
    await openMenu(page, l);
    let opts = await visibleOptions(fr, field.ref);
    const typeable0 = await l.evaluate((el) => el.tagName === "INPUT" || (el as HTMLElement).isContentEditable).catch(() => false);
    if (!opts.length && typeable0) { await page.waitForTimeout(900); opts = await visibleOptions(fr, field.ref); }
    if (!opts.length && !typeable0) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(700);
      await openMenu(page, l);
      await page.waitForTimeout(400);
      opts = await visibleOptions(fr, field.ref);
    }
    const shownAtOpen = opts.map((o) => o.text);
    // Static lists: choose from what the menu offers before typing anything.
    let pick = (/location|city/i.test(field.label) ? bestPlace(value, opts.map((o) => o.text)) : null) ?? bestOption(value, opts.map((o) => o.text));
    const typeable = await l.evaluate((el) => el.tagName === "INPUT" || (el as HTMLElement).isContentEditable).catch(() => false);
    // A short list shown on open is the whole list; typing would only filter it to nothing. Search only long or empty lists.
    // Workday search prompts open on a short category list ("Job Board", "Social Media") but search the whole catalog.
    // Same for any typeable Workday box ("How did you hear": categories on open, LinkedIn only by search).
    const searchable = shownAtOpen.length === 0 || shownAtOpen.length >= 40 || field.automationId === "searchBox" || (typeable && /myworkday/i.test(page.url()));
    // A short list that scrolls is really a long list drawn a window at a time: an exact match may be further down.
    if (shownAtOpen.length && shownAtOpen.length < 40 && !(pick && isExactOption(value, pick))) {
      const r = await scrollForOption(page, fr, field.ref, value, field.label);
      if (r.seen.length > shownAtOpen.length) {
        shownAtOpen.splice(0, shownAtOpen.length, ...r.seen);
        pick = r.pick; opts = r.opts; // the list moved, so only a pick that is drawn right now can be clicked
      }
    }
    if (process.env.HX_DEBUG) console.error(`[combo] "${field.label}" want="${value}" typeable=${typeable} aid=${field.automationId} shown=${shownAtOpen.length} all=${JSON.stringify(shownAtOpen)} pick=${pick}`);
    if (!pick && typeable && searchable) {
      // Search boxes: progressively shorter queries, then match the full intended answer against the results.
      for (const q of queryVariants(value)) {
        await l.fill("").catch(() => {});
        await l.pressSequentially(q.slice(0, 40), { delay: 20 });
        await page.waitForTimeout(1100);
        const before = opts.map((o) => o.text).join("|");
        opts = await visibleOptions(fr, field.ref);
        // Workday prompts (School, Field of Study) only search on Enter; typing alone leaves "No Items." or the old list.
        // Workday only: on other sites Enter in a box with no results could submit the form.
        if (field.automationId === "searchBox" || (/myworkday/i.test(page.url()) && (!opts.length || opts.map((o) => o.text).join("|") === before))) {
          await page.keyboard.press("Enter");
          await page.waitForTimeout(1200);
          opts = await visibleOptions(fr, field.ref);
        }
        pick = (/location|city/i.test(field.label) ? bestPlace(value, opts.map((o) => o.text)) : null) ?? bestOption(value, opts.map((o) => o.text)) ?? (opts.length === 1 && !ruledOut(value, opts[0].text) ? opts[0].text : null);
        if (pick) break;
      }
    }
    if (!pick) {
      // Workday prompts choose the lone search hit on Enter and close the list: the field already shows the answer.
      const nowShows = await shownValue(fr, field.ref);
      if (nowShows && (isExactOption(value, nowShows) || bestOption(value, [nowShows]))) return { ok: true, chosen: nowShows };
      await l.fill("").catch(() => {});
      const seen = shownAtOpen.length ? shownAtOpen : opts.map((o) => o.text);
      return { ok: false, note: `no option matches "${value}" (saw: ${seen.slice(0, 8).join(" / ")})`, options: seen };
    }
    const listBefore = opts.map((o) => o.text).join("|");
    await chooseOption(page, fr, l, opts.find((o) => o.text === pick)!.idx, pick, typeable);
    await page.waitForTimeout(300);
    // Never trust the click: read the field back. One keyboard retry, then report what it actually shows.
    let shown = await shownValue(fr, field.ref);
    // Two-level menus (Workday "How did you hear": Job Board → LinkedIn / Indeed / Other Job Board): the click opened
    // a sub-list instead of choosing. Pick the wanted answer there, else its "Other…" entry.
    if (!showsChoice(shown, pick)) {
      const sub = await visibleOptions(fr, field.ref);
      const subTexts = sub.map((o) => o.text);
      if (process.env.HX_DEBUG) console.error(`[combo-sub] "${field.label}" after "${pick}" shown="${shown}" sub=${JSON.stringify(subTexts.slice(0, 12))} changed=${subTexts.join("|") !== listBefore}`);
      if (sub.length && subTexts.join("|") !== listBefore) {
        const wants = [value, ...(/how did you (hear|learn|find)|source|referr/i.test(field.label) ? ["LinkedIn"] : []), ...(pick !== value ? [pick] : [])];
        let subOpts = sub;
        let subPick: string | null = null;
        for (const w of wants) {
          const r = await scrollForOption(page, fr, field.ref, w, field.label);
          if (r.pick && isExactOption(w, r.pick)) { subPick = r.pick; subOpts = r.opts; break; }
        }
        if (!subPick) {
          const r = await scrollForOption(page, fr, field.ref, "Other", field.label);
          const other = r.opts.find((o) => /^other\b/i.test(o.text)) ?? null;
          if (other) { subPick = other.text; subOpts = r.opts; }
          else if (sub.length === 1) subPick = subTexts[0];
        }
        if (subPick) {
          await chooseOption(page, fr, l, subOpts.find((o) => o.text === subPick)!.idx, subPick, false);
          await page.waitForTimeout(300);
          shown = await shownValue(fr, field.ref);
          if (showsChoice(shown, subPick)) return { ok: true, chosen: `${pick} › ${subPick}` };
        }
      }
    }
    if (!showsChoice(shown, pick) && typeable) {
      await openMenu(page, l);
      await l.fill("").catch(() => {});
      await l.pressSequentially(pick.slice(0, 60), { delay: 15 });
      await page.waitForTimeout(800);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      shown = await shownValue(fr, field.ref);
    }
    if (!showsChoice(shown, pick) && !typeable) {
      // Button listboxes (Workday Country) select by type-ahead: open, type the option's name, Enter.
      await openMenu(page, l);
      await page.keyboard.type(pick.slice(0, 40), { delay: 25 });
      await page.waitForTimeout(500);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      shown = await shownValue(fr, field.ref);
    }
    if (!showsChoice(shown, pick)) return { ok: false, note: `chose "${pick}" but the field shows "${shown || "nothing"}"; check it` };
    return { ok: true, chosen: pick };
  } finally {
    // Never leave a menu open: the next field would read its options or receive its keystrokes.
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(80);
  }
}

/** Opens a combobox briefly to read its options, so the resolver can pick among them. */
export async function peekComboOptions(page: Page, field: Field): Promise<string[]> {
  const fr = frameOf(page, field);
  const l = loc(fr, field.ref);
  try {
    await openMenu(page, l);
    const opts = (await visibleOptions(fr, field.ref)).map((o) => o.text);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    return opts.slice(0, 80);
  } catch { return []; }
}

export async function clickRef(page: Page, b: { ref: string; frame: number }) {
  const fr = frameOf(page, b);
  await loc(fr, b.ref).click({ timeout: 8000 });
}
