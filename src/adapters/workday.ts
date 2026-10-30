import { finalSubmitButton } from "../engine-rules.js";
import type { Page } from "patchright";
import { accounts, answers, schools } from "../resolve.js";
import { withTimeout, type Snapshot } from "../scan.js";
import { getAccount, saveAccount, type Account } from "../store.js";
import { settle } from "./simple.js";
import type { Adapter, JobCtx } from "./types.js";

const aid = (id: string) => `[data-automation-id="${id}"]`;

function tenantOf(url: string): string {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);
  // https://<tenant>.wd5.myworkdayjobs.com/<lang?>/<site>/job/...  → tenant + site (accounts are per tenant site)
  const site = parts.find((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p)) ?? "";
  // wd5.myworkdaysite.com/<lang?>/recruiting/<tenant>/<site>/…: the host is shared, the tenant is in the path.
  if (site === "recruiting" && u.hostname.includes("myworkdaysite.com")) {
    const i = parts.indexOf("recruiting");
    return `${u.hostname}/recruiting/${parts[i + 1] ?? ""}/${parts[i + 2] ?? ""}`.toLowerCase();
  }
  return `${u.hostname}/${site}`.toLowerCase();
}

async function clickAid(page: Page, id: string, label?: string): Promise<boolean> {
  // Workday puts an invisible click_filter div over many buttons; clicking it is what registers.
  const filter = label ? page.locator(`${aid("click_filter")}[aria-label="${label}"]`).first() : null;
  if (filter && (await filter.isVisible().catch(() => false))) { await filter.click(); return true; }
  const el = page.locator(aid(id)).first();
  if (!(await el.isVisible().catch(() => false))) return false;
  // Newer tenants label the overlay "Submit" (not "Sign In"/"Create Account"): click the button's own spot, which
  // lands on whatever overlay covers it.
  // (If the first click worked, the button is gone and the forced retry just times out quietly.)
  await el.click({ timeout: 4000 }).catch(() => el.click({ force: true, timeout: 4000 }).catch(() => {}));
  return true;
}

async function fillAid(page: Page, id: string, value: string) {
  const el = page.locator(aid(id)).first();
  if (await el.isVisible().catch(() => false)) { await el.fill(value); return true; }
  return false;
}

// On a hung tab these checks would never return; 5s and treat as "not there" (the engine then reopens the tab).
const visible = (page: Page, id: string) => withTimeout(page.locator(aid(id)).first().isVisible(), 5_000, "visibility check").catch(() => false);
const pageErrors = async (page: Page) =>
  ((await withTimeout(page.locator(`${aid("errorMessage")}, [role="alert"]`).allInnerTexts(), 5_000, "error check").catch(() => [])) as string[]).join(" | ").toLowerCase();

async function toForm(page: Page, form: "signIn" | "create") {
  const onCreate = await visible(page, "verifyPassword");
  if (form === "signIn" && onCreate) { await clickAid(page, "signInLink", "Sign In"); await settle(page, 600); }
  if (form === "create" && !onCreate) {
    const link = page.locator(`${aid("createAccountLink")}, button:has-text("Create Account"), a:has-text("Create Account")`).first();
    if (await link.isVisible().catch(() => false)) { await link.click(); await settle(page, 600); }
  }
}

/** True when the sign-in form went away (signed in). Tries the long password, then the short one. */
async function signIn(page: Page, email: string, ctx: JobCtx): Promise<string | null> {
  for (const pw of [accounts.password, accounts.short_password]) {
    await toForm(page, "signIn");
    if (!(await visible(page, "password"))) return null;
    await fillAid(page, "email", email);
    await fillAid(page, "password", pw);
    await clickAid(page, "signInSubmitButton", "Sign In");
    await settle(page, 1500);
    if (!(await visible(page, "password"))) { ctx.log(`workday: signed in as ${email}`); return pw; }
    if (process.env.HX_DEBUG) console.error(`[wd-signin] ${email.replace(/@.*/, "@…")} errs="${(await pageErrors(page)).slice(0, 200)}"`);
  }
  return null;
}

type CreateResult = { result: "created" | "verify" | "exists" | "failed"; password: string };
async function create(page: Page, email: string, ctx: JobCtx): Promise<CreateResult> {
  let password = accounts.password;
  for (const pw of [accounts.password, accounts.short_password]) {
    password = pw;
    await toForm(page, "create");
    if (!(await visible(page, "verifyPassword"))) return { result: "failed", password };
    await fillAid(page, "email", email);
    await fillAid(page, "password", pw);
    await fillAid(page, "verifyPassword", pw);
    const agree = page.locator(aid("createAccountCheckbox")).first();
    if (await agree.isVisible().catch(() => false) && !(await agree.isChecked().catch(() => false))) await agree.check({ force: true }).catch(() => agree.click());
    await clickAid(page, "createAccountSubmitButton", "Create Account");
    await settle(page, 1800);
    const errs = await pageErrors(page);
    const body = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    if (process.env.HX_DEBUG) console.error(`[wd-create] ${email.replace(/@.*/, "@…")} errs="${errs.slice(0, 200)}" body="${body.replace(/\s+/g, " ").slice(0, 400)}" url=${page.url()}`);
    if (/password/.test(errs) && /too long|maximum|no more than|at most|cannot exceed|exceeds/.test(errs)) { ctx.log("workday: password too long; retrying with the short password"); continue; }
    if (/already (exists|in use|registered)|account with this email/.test(errs + body)) return { result: "exists", password };
    if (/verify your account|verification email|email has been sent/.test(body)) return { result: "verify", password };
    if (!(await visible(page, "verifyPassword"))) return { result: "created", password };
    return { result: "failed", password };
  }
  return { result: "failed", password };
}

const VERIFY_TEXT = /verify your (email|account)|verification (email|link)|confirm your (email|account)|activate your account|check your (email|inbox)|email has been sent|sent you an email/i;

/** Newer tenants open with "Sign in with LinkedIn / Sign in with email"; the email form appears after choosing. */
async function revealEmailForm(page: Page): Promise<boolean> {
  for (let i = 0; i < 8; i++) {
    if ((await visible(page, "password")) || (await visible(page, "verifyPassword"))) return true;
    const withEmail = page.locator(`${aid("SignInWithEmailButton")}, button:has-text("Sign in with email")`).first();
    if (await withEmail.isVisible().catch(() => false)) { await withEmail.click().catch(() => {}); await settle(page, 1200); continue; }
    if (i >= 2 && !(await page.locator(`${aid("utilityButtonSignIn")}, ${aid("signInLink")}`).first().isVisible().catch(() => false))) return false;
    await page.waitForTimeout(1200);
  }
  return (await visible(page, "password")) || (await visible(page, "verifyPassword"));
}

const signedIn = async (page: Page) => !(await visible(page, "password")) && !(await visible(page, "verifyPassword")) && !(await page.locator(`${aid("SignInWithEmailButton")}`).first().isVisible().catch(() => false));

/**
 * Email verification: the user verifies whenever they get to it. Show "needs you", watch every few seconds for the
 * tab to be signed in (they verified and clicked Continue/Sign in), and every 2 minutes try signing in ourselves;
 * 3 tries, then hand over.
 */
async function awaitVerification(page: Page, ctx: JobCtx, email: string): Promise<boolean> {
  ctx.setStatus?.("needs_you", `Verify the Workday account from the email sent to ${email}, then click Continue or Sign In here. I'll keep checking and retry the sign-in every 2 minutes (3 tries).`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      await page.waitForTimeout(5000);
      if (page.isClosed()) return false;
      if (await signedIn(page)) { ctx.setStatus?.("filling", "account verified; continuing"); return true; }
    }
    ctx.log(`workday: verification check ${attempt}/3 — trying to sign in`);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await settle(page, 1500);
    await revealEmailForm(page);
    const pw = await signIn(page, email, ctx);
    if (pw) { saveAccount(tenantOf(page.url()), { email, password: pw, created_at: new Date().toISOString(), status: "signed_in", employer: ctx.company }); ctx.setStatus?.("filling", "account verified; continuing"); return true; }
  }
  return false;
}

/** Signed in but on Candidate Home instead of the application: reopen the posting and start/continue applying. */
async function backToPosting(page: Page, ctx: JobCtx): Promise<boolean> {
  if (!/\/userHome\b/i.test(page.url())) return false;
  const n = ((ctx as JobCtx & { wdHomeReturns?: number }).wdHomeReturns = ((ctx as JobCtx & { wdHomeReturns?: number }).wdHomeReturns ?? 0) + 1);
  if (n > 2) return false;
  ctx.log("workday: landed on Candidate Home; reopening the posting");
  await page.goto(ctx.url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await settle(page, 1500);
  if (await clickAid(page, "adventureButton")) await settle(page, 800);
  else await page.getByRole("button", { name: /^apply$/i }).first().click().catch(() => {});
  await settle(page, 800);
  const manual = page.locator(`${aid("applyManually")}, a:has-text("Apply Manually"), button:has-text("Apply Manually")`).first();
  if (await manual.isVisible().catch(() => false)) { await manual.click().catch(() => {}); await settle(page, 1000); }
  const cont = page.locator(`${aid("continueButton")}, button:has-text("Continue Application")`).first();
  if (await cont.isVisible().catch(() => false)) { await cont.click().catch(() => {}); await settle(page, 1000); }
  return true;
}

/**
 * Signed in as a different email than the one saved for this tenant (you switched this site to the other email):
 * sign out, so the account step signs in with the saved one.
 */
async function signOutIfOtherEmail(page: Page, ctx: JobCtx): Promise<void> {
  const known = getAccount(tenantOf(page.url()));
  if (!known?.email || known.status === "failed") return;
  const body = await page.locator("body").innerText().catch(() => "");
  const other = [accounts.primary_email, accounts.fallback_email].find((e) => e !== known.email && body.includes(e));
  if (!other) return;
  ctx.log(`workday: signed in as ${other}, but this site should use ${known.email}; signing out`);
  const menu = page.locator(`${aid("utilityButtonAccountMenu")}, ${aid("settingsButton")}, button:has-text("${other}")`).first();
  if (await menu.isVisible().catch(() => false)) { await menu.click().catch(() => {}); await settle(page, 600); }
  const out = page.locator(`${aid("signOutLink")}, [role="menuitem"]:has-text("Sign Out"), button:has-text("Sign Out"), a:has-text("Sign Out")`).first();
  if (await out.isVisible().catch(() => false)) { await out.click().catch(() => {}); await settle(page, 1500); }
  await page.goto(ctx.url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await settle(page, 1500);
}

/** Account policy: primary email, then fallback email; the password, then the short one. */
async function account(page: Page, ctx: JobCtx): Promise<void> {
  await revealEmailForm(page);
  if (!(await visible(page, "password")) && !(await visible(page, "verifyPassword"))) return;
  const tenant = tenantOf(page.url());
  const save = (email: string, password: string, status: Account["status"]) =>
    saveAccount(tenant, { email, password, created_at: new Date().toISOString(), status, employer: ctx.company });

  const known = getAccount(tenant);
  // An email that already failed on this tenant (earlier in this run, or an earlier run: status "failed") isn't tried
  // again; the next email gets its turn (otherwise one bad email gets retried while the other is never tried).
  const failed = ((ctx as JobCtx & { wdFailedEmails?: Set<string> }).wdFailedEmails ??= new Set<string>());
  if (known?.status === "failed" && known.email) failed.add(known.email);
  const fail = (email: string, why: string) => {
    failed.add(email);
    ctx.log(`workday: ${email} didn't work here (${why}); trying the next email`);
    if (!getAccount(tenant) || getAccount(tenant)?.email === email) save(email, "", "failed");
  };
  const order = [...new Set([...(ctx.useFallbackEmail ? [accounts.fallback_email] : []), known?.status === "failed" ? undefined : known?.email, accounts.primary_email, accounts.fallback_email].filter((e): e is string => !!e))];
  const emails = order.filter((e) => !failed.has(e));
  for (const email of emails) {
    // Existing account first (sign-in page, or a known record), then create.
    if (known?.email === email || (await visible(page, "password") && !(await visible(page, "verifyPassword")))) {
      const pw = await signIn(page, email, ctx);
      if (pw) { save(email, pw, "signed_in"); return; }
      const why = (await pageErrors(page)) + " " + (await page.locator("body").innerText().catch(() => ""));
      if (known?.status === "pending_verification" || /not (been )?verified|verify your/i.test(why)) {
        if (await awaitVerification(page, ctx, email)) return;
      }
    }
    const c = await create(page, email, ctx);
    if (c.result === "created") {
      // The create form going away isn't proof (Workday also bounces back to Sign In for an existing or unverified
      // account): record "created" only once we're actually in.
      await settle(page, 1500);
      if (await signedIn(page)) { save(email, c.password, "created"); ctx.log(`workday: created account ${email} for ${tenant}`); return; }
      // Back on the sign-in form: sign in with what we just created; a verify notice means wait for the email.
      const body = await page.locator("body").innerText().catch(() => "");
      if (!VERIFY_TEXT.test(body)) { const pw = await signIn(page, email, ctx); if (pw) { save(email, pw, "signed_in"); ctx.log(`workday: created and signed in as ${email}`); return; } }
      ctx.log(`workday: create for ${email} didn't sign in (existing or unverified account?)`);
      const errs = await pageErrors(page);
      if (VERIFY_TEXT.test(body + " " + errs) || /not (been )?verified|verify/i.test(errs)) {
        save(email, c.password, "pending_verification");
        if (await awaitVerification(page, ctx, email)) return;
        fail(email, "not verified after 3 checks");
      } else fail(email, "account created but sign-in didn't stick");
      continue;
    }
    if (c.result === "verify") {
      save(email, c.password, "pending_verification");
      if (await awaitVerification(page, ctx, email)) return;
      fail(email, "not verified after 3 checks");
      continue;
    }
    if (c.result === "exists") {
      const pw = await signIn(page, email, ctx);
      if (pw) { save(email, pw, "signed_in"); return; }
      fail(email, "an account exists that neither password opens");
      continue;
    }
    fail(email, "the create-account form didn't accept it");
  }
  await settle(page, 2500);
  if (await signedIn(page)) { ctx.log("workday: signed in after all"); return; }
  await ctx.waitForUser(`Could not sign in or create a Workday account with ${[...failed].join(" or ") || "either email"}; sign in by hand in this tab`);
}

export const workday: Adapter = {
  name: "workday",
  async start(page, ctx) {
    if (!/\/apply/.test(page.url())) {
      if (await clickAid(page, "adventureButton")) await settle(page, 800);
      else await page.getByRole("button", { name: /^apply$/i }).first().click().catch(() => {});
      await settle(page, 600);
    }
    // A saved draft opens on "Continue Application".
    const cont = page.locator(`${aid("continueButton")}, button:has-text("Continue Application")`).first();
    if (await cont.isVisible().catch(() => false)) { await cont.click().catch(() => {}); await settle(page, 1200); }
    // Never "Autofill with Resume": its parser corrupts names, dates and schools.
    const manual = page.locator(`${aid("applyManually")}, a:has-text("Apply Manually"), button:has-text("Apply Manually")`).first();
    if (await manual.isVisible().catch(() => false)) { await manual.click(); await settle(page, 1000); }
    const useLast = page.locator(`${aid("useMyLastApplication")}`).first();
    if (!(await manual.isVisible().catch(() => false)) && (await useLast.isVisible().catch(() => false))) { await useLast.click(); await settle(page, 1000); }
    await signOutIfOtherEmail(page, ctx);
    await account(page, ctx);
    await backToPosting(page, ctx);
    return page;
  },

  async beforePage(page, snap, ctx) {
    if (snap.fields.some((f) => f.kind === "password") || snap.buttons.some((b) => /^sign in with email$/i.test(b.text))) {
      // A create/sign-in form that keeps coming back means "created" didn't stick (an old account, unverified email).
      const tries = ((ctx as JobCtx & { wdAccountTries?: number }).wdAccountTries = ((ctx as JobCtx & { wdAccountTries?: number }).wdAccountTries ?? 0) + 1);
      if (tries > 3) { await ctx.waitForUser("The Workday sign-in keeps coming back; sign in or create the account by hand in this tab"); return "handled"; }
      if (tries > 1) { ctx.useFallbackEmail = ctx.useFallbackEmail || tries > 2; }
      await account(page, ctx);
      await backToPosting(page, ctx);
      return "handled";
    }
    // Signed in but parked on Candidate Home (after sign-in, or after the agent): back to this job's application.
    if (/\/userHome\b/i.test(page.url())) { if (await backToPosting(page, ctx)) return "handled"; }
    const heading = snap.headings.join(" ").toLowerCase();
    // The Review page repeats every section heading ("My Experience" included) next to the final Submit: not this step.
    if (/my experience/.test(heading) && !finalSubmitButton(snap)) {
      const upload = page.locator(aid("file-upload-input-ref")).first();
      if (!ctx.resumeUploaded && (await upload.count())) {
        await upload.setInputFiles(ctx.files.resume).catch(() => {});
        ctx.resumeUploaded = true;
        await settle(page, 2500);
      }
      const goal = myExperienceGoal();
      const r = await ctx.rescue(goal);
      if (r === "advanced") return "handled";
      if (r === "blocked" || r === "gave_up") await ctx.waitForUser("Finish the My Experience page and click Save and Continue");
      return "handled";
    }
  },
};

/** The rescue agent's brief for Workday's "My Experience" page, built from the answer bank. */
function myExperienceGoal(): string {
  const exp = (answers.experience as { employer: string; title: string; location: string; start: string; end: string; current?: boolean; description: string }[] | undefined) ?? [];
  const q = (s: string) => `"${s}"`;
  const schoolLines = schools.map((e) => [
    `- ${q(e.school)}${e.school_aliases?.length ? ` (also listed as ${e.school_aliases.map(q).join(" or ")})` : ""}${e.never_schools?.length ? `; NEVER ${e.never_schools.join(", ")}` : ""}`,
    `degree ${q(e.degree)} or the closest entry of the same kind`,
    e.field ? `field ${q(e.field)}${e.field_alternates?.length ? ` (else ${e.field_alternates.map(q).join(", ")})` : ""}` : "no field of study",
    `${e.start} to ${e.end}`,
    e.expected ? "IN PROGRESS (not completed)" : "completed",
  ].join(", ")).join("\n");
  const rules = typeof answers.experience_rules === "string" ? `\n${answers.experience_rules}` : "";
  const linkedin = typeof answers.identity.linkedin === "string" && answers.identity.linkedin ? ` Websites: add ${answers.identity.linkedin} under Websites if there is a Websites section.` : "";
  return `You are on Workday's "My Experience" page. Make Work Experience contain exactly these ${exp.length} entries and no others (delete any extra entries, e.g. ones parsed from the resume):
${exp.map((e, i) => `${i + 1}. Job Title "${e.title}", Company "${e.employer}", Location "${e.location}", From ${e.start} To ${e.current ? "present (current job)" : e.end}${e.current ? "" : ", not current"}. Role Description (paste exactly):\n${e.description}`).join("\n")}${rules}
Education must contain exactly these schools, with these degrees, fields, dates and status:
${schoolLines}
Degree status: where the Degree list splits "completed" from "in progress or not completed", use each school's status above.
Field of Study: only each school's field or its listed alternates; if none exist, leave it blank when optional, or pick the closest catalog entry when required and note it. Never pick an unrelated field, and never type probe values like "zzz".
After filling a School field, observe what it actually shows; if it is the wrong school (a similarly named one), clear it and pick again.
Fill each field once, then observe once to check; do not re-fill fields that already show the right value, and never type test values.
Use "Add" / "Add Another" buttons for missing entries. Dates: fill each "From Month" / "To Month" box once with MM/YYYY (e.g. 06/2024); that sets the month and the year together, so don't fill the Year boxes separately. If a date already shows the right month and year, leave it alone.${linkedin} The resume is already uploaded. When the page is complete, click "Save and Continue" once and finish(state="advanced").`;
}

export function isWorkdayAccountPage(s: Snapshot) {
  return s.fields.some((f) => f.automationId === "verifyPassword" || f.automationId === "password");
}
