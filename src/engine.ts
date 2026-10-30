import type { Page } from "patchright";
import { adapterFor } from "./adapters/index.js";
import { settle } from "./adapters/simple.js";
import type { JobCtx } from "./adapters/types.js";
import { config } from "./config.js";
import { noSponsorship, advanceButton, finalSubmitButton, hardStop, isConfirmation, pageSignature } from "./engine-rules.js";
import { clickRef, fillField, peekComboOptions } from "./fill.js";
import { platformOf } from "./jobkey.js";
import { bestOption, isExactOption } from "./match.js";
import { accounts, eduKind, needsSponsorship, remember, resolveLocal, resolveWithLLM, resolveWithLLMParts, schools, type Decision } from "./resolve.js";
import { scan, withTimeout, type Field, type Snapshot } from "./scan.js";

export type FillOutcome =
  | { state: "at_review"; page: Page }
  | { state: "already_submitted"; page: Page }
  | { state: "handoff"; page: Page; reason: string }
  | { state: "ineligible"; page: Page; reason: string };

/** One fill pass over the current page: resolve every unfilled field and fill it. Returns how many fields changed. */
async function fillPage(page: Page, ctx: JobCtx, snap: Snapshot, done: Set<string>): Promise<number> {
  // Fields already handled on this page are never redone in later passes (a just-selected dropdown can keep its
  // error styling until blur). After a failed Next click, invalid fields get one more try via the stuck path.
  const todo = snap.fields.filter((f) => !done.has(f.ref) && (!f.filled || (f.error && f.kind !== "file" && snap.errors.length > 0)));
  // Resume parsers (Lever, Workday, Greenhouse) pre-fill fields, sometimes wrongly (a "Current company" that isn't).
  // Pre-filled fields with a definite saved answer (rule/builtin, never memory or the model) that disagrees get corrected.
  const loose = (s: string) => s.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[^a-z0-9]/g, "");
  for (const f of snap.fields) {
    // Ticked boxes are corrected too when a rule decides them (race checkboxes left ticked in a saved Workday draft).
    if (done.has(f.ref) || todo.includes(f) || ["file", "password", "checkboxes", "radio", "buttons"].includes(f.kind)) continue;
    if (f.kind === "checkbox") {
      const [cd] = resolveLocal([f], { resumeUploaded: true }).decided;
      if (cd?.source === "rule" && cd.action === "fill" && cd.value !== undefined && /^(yes|true|checked)$/i.test(cd.value) !== f.filled) { ctx.log(`correcting ${f.filled ? "ticked" : "unticked"} "${f.label.slice(0, 50)}"`); todo.push(f); }
      continue;
    }
    if (!f.filled) continue;
    const [d] = resolveLocal([f], { resumeUploaded: true, eduIndex: undefined }).decided;
    // Rules only: education builtins don't know which school block a pre-filled field belongs to (a second school's
    // entry once got "corrected" to the first school's name, major and dates).
    if (!d || d.action !== "fill" || d.value === undefined || d.source !== "rule") continue;
    // Dropdowns: correct only toward an answer the field actually offers; a rule that doesn't fit leaves it alone.
    // (options known: the answer must be one of them; not known, e.g. Workday Country: anything but a bare number,
    // so a phone number never "corrects" a dial-code box).
    if (["select", "combobox", "radio", "buttons"].includes(f.kind) && (f.options?.length ? !bestOption(d.value, f.options) : /^[+\d\s().-]+$/.test(d.value))) continue;
    const same = loose(d.value) === loose(f.value) || isExactOption(d.value, f.value) || ((["select", "combobox", "radio", "buttons"].includes(f.kind) || !!f.options?.length) && !!bestOption(d.value, [f.value]));
    const differs = !same;
    // Once per field per job: a correction that doesn't stick isn't retried on every pass.
    const corrected = ((ctx as JobCtx & { corrected?: Set<string> }).corrected ??= new Set<string>());
    if (differs && !corrected.has(f.label)) { corrected.add(f.label); ctx.log(`correcting pre-filled "${f.label.slice(0, 50)}": "${f.value.slice(0, 40)}"`); todo.push(f); }
  }
  if (!todo.length) return 0;
  // Country first, alone: it decides which State/Province list the form shows (Workday defaults some tenants to
  // Canada). Fill it, then rescan, instead of answering a provinces list.
  // Once per page, and never the phone's country-code picker (Greenhouse labels that one "Country" too).
  const isPhoneCountry = (f: Field) => /phone|dial|code/i.test(`${f.label} ${f.placeholder ?? ""}`) || (f.options ?? []).some((o) => /\+\d/.test(o)) || /\+\d/.test(f.value);
  const country = done.has("#country-first") ? undefined : todo.find((f) => /^country( \/ territory)?$|^country\b(?!.*(code|phone))/i.test(f.label.trim()) && f.kind !== "file" && !isPhoneCountry(f));
  if (country && todo.length > 1 && todo.some((f) => /state|province|region/i.test(f.label))) {
    done.add("#country-first");
    const [d] = resolveLocal([country], { resumeUploaded: ctx.resumeUploaded }).decided;
    if (d?.action === "fill" && d.value) {
      const r = await fillField(page, country, d.value, ctx.files);
      done.add(country.ref);
      ctx.log(`${d.source.padEnd(7)} "${country.label.slice(0, 60)}" = ${r.ok ? r.chosen ?? d.value : `FAILED (${r.note})`}  (first; other fields depend on it)`);
      if (r.ok) return 1;
    }
  }
  // n-th School/Degree/Discipline/date field on the page belongs to the n-th school.
  const eduIndex = new Map<string, number>();
  const seen: Record<string, number> = {};
  for (const f of snap.fields) { const k = eduKind(f.label); if (k) { eduIndex.set(f.ref, seen[k] ?? 0); seen[k] = (seen[k] ?? 0) + 1; } }
  const { decided, pending } = resolveLocal(todo, {
    eduIndex,
    resumeUploaded: ctx.resumeUploaded,
    password: ctx.useAltPassword ? altPassword() : ctx.useShortPassword ? accounts.short_password : accounts.password,
    accountEmail: ctx.useFallbackEmail ? accounts.fallback_email : undefined,
  });
  const host = new URL(snap.url).hostname;
  let changed = 0;
  let stale = 0;
  // Saved answers that don't fit a dropdown's actual options (e.g. "2" for a Yes/No) get a second opinion from the model.
  // Asked the moment a saved answer doesn't fit, while the rest of the page keeps filling.
  const llmJob = { company: ctx.company, role: ctx.role, url: snap.url, pageText: snap.text, errors: snap.errors, priorApplications: ctx.priorApplications, postingText: ctx.postingText };
  const askAgain: { f: Field; answer: Promise<Decision[]> }[] = [];
  const apply = async (list: Decision[]) => {
    for (const d of list) {
      const f = todo.find((x) => x.ref === d.ref)!;
      done.add(d.ref);
      if (stale) continue; // the form was redrawn: the rest of these handles are dead too; rescan first
      if (d.action === "skip") continue;
      if (d.action === "flag") {
        if (!ctx.decisions.some((x) => x.label === d.label && x.action === "flag")) { ctx.decisions.push(d); ctx.log(`FLAG "${d.label.slice(0, 70)}": ${d.reason ?? ""}`); }
        continue;
      }
      if (d.value === undefined) continue;
      if (!f.required && !isChoiceKind(f) && /^(n\/?a|none|not applicable)\.?$/i.test(d.value.trim())) { ctx.log(`skip    "${f.label.slice(0, 60)}" (optional, doesn't apply)`); continue; }
      const r = await fillField(page, f, d.value, ctx.files);
      if (r.ok) {
        changed++;
        if (f.kind === "file" && d.value === "resume") ctx.resumeUploaded = true;
        const shown = f.kind === "password" ? "(account password)" : r.chosen ?? d.value;
        for (let i = ctx.decisions.length - 1; i >= 0; i--) if (ctx.decisions[i].action === "flag" && ctx.decisions[i].label === f.label) ctx.decisions.splice(i, 1);
        ctx.decisions.push({ ...d, value: shown });
        remember(f, r.chosen ?? d.value, d.source, host);
        ctx.log(`${d.source.padEnd(7)} "${f.label.slice(0, 60)}" = ${String(shown).slice(0, 60)}${d.review ? "  (review)" : ""}`);
      } else if (d.alternates?.length && (!r.options?.length || d.alternates.some((a) => bestOption(a, r.options!)))) {
        const alt = r.options?.length ? d.alternates.map((a) => bestOption(a, r.options!)).find(Boolean)! : d.alternates[0];
        const r2 = await fillField(page, f, alt, ctx.files);
        ctx.log(`${d.source.padEnd(7)} "${f.label.slice(0, 60)}" = ${r2.ok ? r2.chosen ?? alt : `FAILED (${r2.note})`}  (fallback answer)`);
        if (r2.ok) { changed++; ctx.decisions.push({ ...d, value: r2.chosen ?? alt }); }
        else if (f.required) ctx.decisions.push({ ...d, action: "flag", reason: `Fill failed: ${r2.note}` });
      } else if (d.source === "builtin" && !f.required && eduKind(f.label)) {
        ctx.log(`no fitting option for optional "${f.label.slice(0, 50)}" (wanted ${d.value}); leaving it blank`);
      } else if (d.source !== "llm" && r.options?.length) {
        ctx.log(`no option fits "${d.value.slice(0, 40)}" for "${f.label.slice(0, 50)}"; asking the model with the real options`);
        const withOpts = { ...f, options: r.options };
        askAgain.push({ f: withOpts, answer: resolveWithLLM([withOpts], llmJob).catch(() => [] as Decision[]) });
      } else if (/timeout/i.test(r.note ?? "") && (await page.locator(`[data-hx="${f.ref}"]`).count().catch(() => 1)) === 0) {
        // The form redrew itself (Ashby after autofill): this box is gone. The next pass rescans and fills the new one.
        stale++;
        ctx.log(`redrawn "${f.label.slice(0, 60)}"; will refill after a rescan`);
      } else {
        ctx.log(`FAILED  "${f.label.slice(0, 60)}" -> ${f.kind === "password" ? "(account password)" : d.value.slice(0, 40)}: ${r.note}`);
        if (f.required) ctx.decisions.push({ ...d, action: "flag", reason: `Fill failed: ${r.note}` });
      }
      await page.waitForTimeout(80);
    }
  };
  // 0. Resume first: Lever/Ashby/Workday parse it and pre-fill the form. Wait for that, then rescan (the next pass
  //    sees the parser's values and corrects the wrong ones) instead of racing it.
  const uploads = decided.filter((d) => d.action === "fill" && d.value === "resume" && todo.find((x) => x.ref === d.ref)?.kind === "file");
  // Only the first upload on a page waits; Ashby re-renders its resume box after autofill and asks for it again.
  if (uploads.length && !done.has("#resume-parsed") && decided.length + pending.length > uploads.length) {
    await apply(uploads);
    if (changed) { done.add("#resume-parsed"); await waitForResumeParse(page, ctx); return changed; }
  }
  // 1. Read the options of the dropdowns the model must answer (quick, before anything is typed).
  for (const f of pending) {
    if (f.kind === "combobox" && !f.options?.length) f.options = await peekComboOptions(page, f);
  }
  // 2. Send those questions to the model, 3. fill the rule/memory answers while it thinks, 4. fill its answers.
  const t = Date.now();
  const parts = resolveWithLLMParts(pending, { company: ctx.company, role: ctx.role, url: snap.url, pageText: snap.text, errors: snap.errors, priorApplications: ctx.priorApplications, postingText: ctx.postingText });
  const quick = parts.quick.catch((e) => { ctx.log(`model field call failed: ${(e as Error).message}`); return [] as Decision[]; });
  await apply(decided);
  if (pending.length) {
    const fromLlm = (await quick).filter((d) => !done.has(d.ref));
    if (fromLlm.length) ctx.log(`the model answered ${fromLlm.length} field(s) in ${((Date.now() - t) / 1000).toFixed(1)}s (asked before the ${decided.length} known fields were filled)`);
    await apply(fromLlm);
    const fromWriter = await parts.written;
    if (fromWriter.length) ctx.log(`the writer wrote ${fromWriter.length} answer(s) in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    await apply(fromWriter);
    // Anything the model left unanswered (call failed, field dropped): flag if required so the user sees it.
    const left = pending.filter((f) => !done.has(f.ref));
    await apply(left.map((f): Decision => ({ ref: f.ref, label: f.label, action: f.required ? "flag" : "skip", source: "llm", reason: "LLM unavailable" })));
  }
  if (askAgain.length) {
    for (const { f } of askAgain) { done.delete(f.ref); const k = todo.findIndex((x) => x.ref === f.ref); if (k >= 0) todo[k] = f; }
    for (const { answer } of askAgain) await apply(await answer);
  }
  // Fields redrawn under us: report progress so the caller rescans and fills the new copies.
  return stale ? Math.max(changed, 1) : changed;
}

const PARSING = /analy[sz]ing (your )?(resume|cv)|parsing (your )?(resume|cv)|reading (your )?(resume|cv)|(autofilling|extracting) (from|details from|information from) (your )?(resume|cv)|uploading\.\.\.|uploading…/i;

/** After a resume upload: give the site's parser time to start, then wait (max ~25s) until its spinner text is gone. */
async function waitForResumeParse(page: Page, ctx: JobCtx) {
  const t = Date.now();
  await page.waitForTimeout(1500);
  const busy = async () => PARSING.test(await withTimeout(page.evaluate(() => document.body?.innerText ?? ""), 5000, "parse check").catch(() => ""));
  let saw = false;
  while (Date.now() - t < 25000 && (await busy())) { saw = true; await page.waitForTimeout(700); }
  // Ashby shows no progress text, only "Autofill completed!" at the end, and then redraws the whole form.
  const body = () => withTimeout(page.evaluate(() => document.body?.innerText ?? ""), 5000, "parse check").catch(() => "");
  if (!saw && /autofill from resume/i.test(await body())) {
    while (Date.now() - t < 30000 && !/autofill completed|review the information we filled|couldn.?t (read|parse|autofill)|autofill failed|unable to (parse|autofill)/i.test(await body())) await page.waitForTimeout(700);
    saw = true;
  }
  if (saw) { await page.waitForTimeout(1200); ctx.log(`waited ${((Date.now() - t) / 1000).toFixed(1)}s for the site to read the resume`); }
}

const isChoiceKind = (f: Field) => ["select", "radio", "buttons", "combobox", "checkbox", "checkboxes"].includes(f.kind);

const PASSWORD_HAS_EMAIL = /password[^.]{0,60}(must not|cannot|can't|may not|should not|shouldn't) (contain|include|match|be similar to)[^.]{0,30}(e-?mail|user ?name|login)|(e-?mail|user ?name)[^.]{0,30}(not allowed|cannot be used) in (the |your )?password/i;
/** Password for an account under `email` on sites that refuse one containing it: the other email + "A". */
/** For sites that refuse a password containing the email: accounts.alt_password (the main one if unset). */
export const altPassword = () => accounts.alt_password || accounts.password;

const PASSWORD_TOO_LONG = /password[^.]{0,80}(too long|maximum|no more than|at most|cannot exceed|exceeds|less than \d+|between \d+ and \d+)|(max(imum)?|up to) (of )?\d+ characters/i;
const ACCOUNT_EXISTS = /already (exists|registered|in use|taken|associated)|account (with this e-?mail )?already exists|e-?mail (address )?(is )?already (in use|registered|taken)/i;

/**
 * Account policy: primary email + password; short password if the site says it's too long;
 * if the primary email already has an account we can't sign into, the fallback email with the same password rule.
 * Reads validation errors only — page copy like "Already have an account? Sign in" must not trigger it.
 */
async function handleAccountErrors(page: Page, ctx: JobCtx, snap: Snapshot): Promise<boolean> {
  const passwords = snap.fields.filter((f) => f.kind === "password");
  // Password rules often show as live hint text, not an error: check those for the contains-email rule too.
  if (!passwords.length || (!snap.errors.length && !PASSWORD_HAS_EMAIL.test(snap.text))) return false;
  const msg = snap.errors.join(" | ");
  // Sites that refuse a password containing the email (UKG/Auth0): use accounts.alt_password.
  const policy = `${msg} ${snap.text}`;
  if (!ctx.useAltPassword && PASSWORD_HAS_EMAIL.test(policy)) {
    ctx.useAltPassword = true;
    ctx.log("site won't take a password containing the email; using the alternate password");
    for (const f of passwords) await fillField(page, f, altPassword(), ctx.files);
    return true;
  }
  if (!ctx.useShortPassword && PASSWORD_TOO_LONG.test(msg)) {
    ctx.useShortPassword = true;
    ctx.log("password too long for this site; using the short password");
    for (const f of passwords) await fillField(page, f, accounts.short_password, ctx.files);
    return true;
  }
  if (!ctx.useFallbackEmail && ACCOUNT_EXISTS.test(msg)) {
    ctx.log("an account already exists for the primary email; trying sign-in, then the fallback email");
    const r = await ctx.rescue("An account already exists for EMAIL on this site. Sign in with EMAIL and PASSWORD (if that password is rejected, try SHORT_PASSWORD). If sign-in still fails, go back to account creation and create the account with FALLBACK_EMAIL and PASSWORD (SHORT_PASSWORD if PASSWORD is too long). Then continue to the application form and finish(state='advanced').");
    if (r !== "advanced" && r !== "at_review") ctx.useFallbackEmail = true;
    return true;
  }
  return false;
}

// ---------- stuck tabs ----------
// Some sites (Workday after Create Account / Sign In especially) leave a tab spinning forever after a click. Reloading
// that tab doesn't help; closing it and opening the same address in a fresh tab does (sign-in cookies live in the
// browser profile, so the new tab is still signed in). A page counts as stuck only when it has no form fields, almost
// no buttons and almost no text, or doesn't answer at all.
// Spinners that mean "busy" even when the old form is still on screen; a generic progressbar only counts on an empty page.
const BUSY = '[data-automation-id="loadingSpinner"], [data-automation-id="wd-LoadingPanel"], body[aria-busy="true"], main[aria-busy="true"]';
const WEAK_SPINNER = '[role="progressbar"], [aria-busy="true"]';
const CHROME_BUTTONS = /^(back|cancel|close|menu|skip to main content|sign (in|out)|english|search|careers|home|log ?in)$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Main-frame navigations that started but never finished (the tab's own loading spinner). The old page stays on
// screen meanwhile, so the page content alone can't reveal this.
const navState = new WeakMap<Page, { pending: Set<object>; since: number }>();
export function trackNavigation(page: Page) {
  if (navState.has(page)) return;
  const st = { pending: new Set<object>(), since: 0 };
  navState.set(page, st);
  const isMain = (r: import("patchright").Request) => { try { return r.isNavigationRequest() && r.frame() === page.mainFrame(); } catch { return false; } };
  page.on("request", (r) => { if (isMain(r)) { if (!st.pending.size) st.since = Date.now(); st.pending.add(r); } });
  const done = (r: import("patchright").Request) => { st.pending.delete(r); };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) st.pending.clear(); });
}
function navigationHangingFor(page: Page): number {
  const st = navState.get(page);
  return st && st.pending.size ? Date.now() - st.since : 0;
}

async function looksStuck(page: Page): Promise<string | null> {
  if (page.isClosed()) return "tab closed";
  const hang = navigationHangingFor(page);
  if (hang > 15_000) return `page load pending for ${Math.round(hang / 1000)}s`;
  const s = await scan(page).catch(() => null);
  if (!s || (!s.fields.length && !s.buttons.length && !s.text)) return "page not responding";
  if (isConfirmation(s)) return null;
  const busy = await withTimeout(page.locator(BUSY).first().isVisible(), 5_000, "spinner check").catch(() => false);
  if (busy) return "loading spinner still showing";
  const realButtons = s.buttons.filter((b) => !CHROME_BUTTONS.test(b.text.trim()));
  if (s.fields.length > 0 || realButtons.length >= 2) return null;
  const weak = await withTimeout(page.locator(WEAK_SPINNER).first().isVisible(), 5_000, "spinner check").catch(() => false);
  if (weak) return "loading spinner on an empty page";
  return s.text.replace(/\s+/g, " ").trim().length < 250 ? "page is empty" : null;
}

/** Opens the same address in a fresh tab, closes the stuck one, and hands the new tab to the job. */
export async function reopenInFreshTab(page: Page, ctx: JobCtx, why: string, preferLastGood = false): Promise<Page> {
  const here = page.isClosed() ? "" : page.url();
  // A hung navigation's target may hang again; the last address that loaded is the safe bet (like reopening the job link).
  const url = (preferLastGood && ctx.lastGoodUrl) || (/^https?:/.test(here) ? here : ctx.lastGoodUrl ?? ctx.url);
  ctx.log(`${why}; reopening ${url} in a fresh tab`);
  const fresh = await page.context().newPage();
  ctx.replacePage?.(fresh);
  void withTimeout(page.close({ runBeforeUnload: false }), 5_000, "closing stuck tab").catch(() => {});
  await fresh.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) => ctx.log(`fresh tab load: ${(e as Error).message.split("\n")[0]}`));
  await settle(fresh);
  return fresh;
}

/** Waits for the page to show real content; if it stays stuck for waitMs, reopens it in a fresh tab (at most twice). */
export async function ensureLoaded(page: Page, ctx: JobCtx, waitMs = 20_000): Promise<Page> {
  trackNavigation(page);
  for (let reopens = 0; ; reopens++) {
    const start = Date.now();
    let why: string | null = null;
    while (Date.now() - start < waitMs) {
      why = await looksStuck(page);
      if (!why) {
        if (/^https?:/.test(page.url())) ctx.lastGoodUrl = page.url();
        return page;
      }
      await sleep(2_000);
    }
    if (reopens >= 2) { ctx.log(`page still stuck (${why}) after 2 fresh tabs; continuing`); return page; }
    page = await reopenInFreshTab(page, ctx, `${why} for ${waitMs / 1000}s+ (${reopens + 1}/2)`, /pending|not responding/.test(why ?? ""));
    trackNavigation(page);
  }
}


/** Clicks the Education section's "Add another" once if the form has fewer school blocks than the candidate has schools. */
async function addEducationIfMissing(page: Page, snap: Snapshot, ctx: JobCtx): Promise<boolean> {
  const blocks = snap.fields.filter((f) => eduKind(f.label) === "school").length;
  if (!blocks || blocks >= schools.length) return false;
  for (const b of snap.buttons.filter((x) => /^\+?\s*add (another|education|school|more)\b/i.test(x.text.trim()))) {
    const inEducation = await page.frames()[b.frame]?.locator(`[data-hx="${b.ref}"]`).evaluate((el) => {
      let a = el.parentElement;
      for (let i = 0; i < 6 && a; i++, a = a.parentElement) {
        const t = (a as HTMLElement).innerText || "";
        if (/employer|company name|job title|work experience/i.test(t)) return false;
        if (/\bschool\b|education|degree/i.test(t)) return true;
      }
      return false;
    }).catch(() => false);
    if (inEducation) {
      ctx.log(`adding education block ${blocks + 1} (${schools[blocks].school})`);
      await clickRef(page, b).catch(() => {});
      await page.waitForTimeout(800);
      return true;
    }
  }
  return false;
}

export async function runJob(page: Page, ctx: JobCtx): Promise<FillOutcome> {
  let adapter = adapterFor(ctx.platform);
  ctx.log(`adapter: ${adapter.name}`);
  await settle(page);
  page = await adapter.start(page, ctx);
  // Employer career sites often hand off to a real ATS; switch adapters when the URL says so.
  const real = platformOf(page.url());
  if (real !== ctx.platform && real !== "other") {
    ctx.platform = real;
    adapter = adapterFor(real);
    ctx.log(`landed on ${real}; adapter: ${adapter.name}`);
    page = await adapter.start(page, ctx);
  }

  let lastSig = "";
  let stuck = 0;
  // Adapter special steps (account, My Experience…) are capped per page, not per job: a sign-in that took several
  // tries must not use up the budget My Experience needs later.
  const handled = new Map<string, number>();
  let waitedForLoad = "";
  // The page limit counts distinct pages (step headings), not retries: a Save and Continue that didn't move the
  // form is the same page. Retries have their own, looser cap.
  const pagesSeen = new Set<string>();
  // New tabs opened by this job's page (an "APPLY THROUGH WORKDAY" button on a careers site) are followed, not clicked again.
  const popups: Page[] = [];
  const watched = new WeakSet<Page>();
  const watch = (p: Page) => { if (!watched.has(p)) { watched.add(p); p.on("popup", (np) => popups.push(np)); } };
  watch(page);
  for (let n = 1; n <= config.fill.maxPages * 4; n++) {
    const fresh = popups.splice(0).filter((p) => !p.isClosed()).pop();
    if (fresh) {
      page = fresh;
      watch(page);
      ctx.replacePage?.(page);
      ctx.log(`followed the new tab: ${page.url().slice(0, 100)}`);
    }
    await settle(page);
    page = await ensureLoaded(page, ctx);
    watch(page);
    // Moved onto a known ATS mid-application (the agent clicked through from a company page): its adapter takes over,
    // which means Apply Manually and its account flow on Workday, never the resume autofill.
    const nowOn = platformOf(page.url());
    if (nowOn !== ctx.platform && nowOn !== "other") {
      ctx.platform = nowOn;
      adapter = adapterFor(nowOn);
      ctx.log(`now on ${nowOn}; adapter: ${adapter.name}`);
      ctx.resumeUploaded = false; // a new site: an upload on the company page doesn't count here
      page = await adapter.start(page, ctx);
      watch(page);
    }
    let snap = await scan(page);
    pagesSeen.add(`${new URL(snap.url).pathname}|${snap.headings.slice(0, 3).join("|")}`);
    if (pagesSeen.size > config.fill.maxPages) return { state: "handoff", page, reason: `Exceeded ${config.fill.maxPages} pages` };
    const done = new Set<string>();
    if (isConfirmation(snap)) return { state: "already_submitted", page };
    // The posting or the form says the role won't sponsor: a candidate who needs sponsorship skips those.
    const noSponsor = needsSponsorship ? noSponsorship([snap.text, ...snap.fields.map((f) => f.label)].join(" . ")) : null;
    if (noSponsor && !ctx.ignoreNoSponsorship) return { state: "ineligible", page, reason: noSponsor };

    const stop = hardStop(snap);
    if (stop) {
      const cleared = await ctx.waitForUser(stop);
      if (!cleared) return { state: "handoff", page, reason: stop };
      continue;
    }

    const stepKey = `${new URL(snap.url).pathname}|${snap.text.match(/current step \d+ of \d+\s*[^\n]*/i)?.[0] ?? snap.headings.slice(0, 2).join("|")}`;
    if (adapter.beforePage && (handled.get(stepKey) ?? 0) < 4 && (await adapter.beforePage(page, snap, ctx)) === "handled") { handled.set(stepKey, (handled.get(stepKey) ?? 0) + 1); n--; lastSig = ""; continue; }

    for (let pass = 0; pass < config.fill.passesPerPage; pass++) {
      const changed = await fillPage(page, ctx, snap, done);
      snap = await scan(page);
      if (!changed) break; // dependent fields (e.g. visa type after sponsorship = Yes) show up on the next pass
    }
    if (await handleAccountErrors(page, ctx, snap)) { lastSig = ""; snap = await scan(page); }
    if (await addEducationIfMissing(page, snap, ctx)) {
      snap = await scan(page);
      for (let pass = 0; pass < config.fill.passesPerPage; pass++) {
        const changed = await fillPage(page, ctx, snap, done);
        snap = await scan(page);
        if (!changed) break;
      }
    }

    if (finalSubmitButton(snap) && !advanceButton(snap)) {
      const missing = snap.fields.filter((f) => f.required && !f.filled);
      for (const m of missing) if (!ctx.decisions.some((d) => d.label === m.label)) ctx.decisions.push({ ref: m.ref, label: m.label, action: "flag", source: "builtin", reason: "Required and still empty" });
      return { state: "at_review", page };
    }

    const sig = pageSignature(snap);
    if (sig === lastSig) {
      stuck++;
      ctx.log(`no progress on this page (try ${stuck}); errors: ${snap.errors.join(" | ").slice(0, 200)}`);
      if (stuck > config.fill.stuckRetries) {
        ctx.log("calling rescue agent");
        const r = await ctx.rescue("The form will not advance past this page. Fix the validation errors or missing answers, then click the page's Next/Continue/Save and Continue button once and finish(state='advanced'). If the final Submit is the next step, finish(state='at_review').");
        if (r === "at_review") return { state: "at_review", page };
        if (r === "advanced") { stuck = 0; lastSig = ""; continue; }
        const cleared = await ctx.waitForUser("Stuck on this page; fix it and click Next, I'll continue from there");
        if (!cleared) return { state: "handoff", page, reason: "Stuck page" };
        stuck = 0;
        lastSig = "";
        continue;
      }
    } else stuck = 0;
    lastSig = sig;

    const next = advanceButton(snap);
    // Per step, not per address: Workday keeps one URL for every step of the application.
    const loadKey = `${snap.url}|${snap.text.match(/current step \d+ of \d+/i)?.[0] ?? snap.headings.slice(0, 2).join("|")}`;
    if (!next && waitedForLoad !== loadKey) {
      // Slow pages (Workday right after sign-in, between steps) draw their form and buttons late. ~15s before the agent.
      waitedForLoad = loadKey;
      let grew = false;
      for (let w = 0; w < 6 && !grew; w++) {
        await page.waitForTimeout(2500);
        const s2 = await scan(page);
        grew = !!advanceButton(s2) || s2.fields.length > snap.fields.length;
      }
      if (grew) { ctx.log("page finished loading; filling it"); lastSig = ""; n--; continue; }
    }
    if (!next) {
      ctx.log("no Next/Continue button found; calling rescue agent");
      const r = await ctx.rescue("Find the way forward in this application (a Next/Continue/Apply step, a tab, or a section to expand). Fill what is required. Do not click the final Submit. finish(state='advanced') after moving forward, or finish(state='at_review') if the final Submit is next.");
      if (r === "at_review") return { state: "at_review", page };
      if (r === "advanced") continue;
      return { state: "handoff", page, reason: "Could not find how to advance" };
    }
    ctx.log(`click "${next.text}"`);
    await clickRef(page, next).catch((e) => ctx.log(`click failed: ${(e as Error).message.split("\n")[0]}`));
    await page.waitForTimeout(1200);
  }
  return { state: "handoff", page, reason: `Still not at the Submit page after ${config.fill.maxPages * 4} tries` };
}
