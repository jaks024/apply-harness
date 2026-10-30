import type { Page } from "patchright";
import { startButton } from "../engine-rules.js";
import { clickRef } from "../fill.js";
import { jobKey } from "../jobkey.js";
import { scan, withTimeout } from "../scan.js";
import type { Adapter, JobCtx } from "./types.js";

// Cookie banners sit on top of forms and swallow clicks. Known consent-manager buttons first (OneTrust, TrustArc,
// Cookiebot, Cookie Consent), then an Accept-style button inside a visible box that talks about cookies.
const COOKIE_SRC = `(() => {
  const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden" && getComputedStyle(e).display !== "none";
  const known = ["#onetrust-accept-btn-handler", "#accept-recommended-btn-handler", "#truste-consent-button",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", "#CybotCookiebotDialogBodyButtonAccept", ".cc-allow", ".cc-accept",
    "[data-cookiebanner='accept_button']", "button[aria-label='Accept cookies']", "button[aria-label='Accept all cookies']",
    "[data-automation-id='legalNoticeAcceptButton']"];
  for (const s of known) { const b = document.querySelector(s); if (vis(b)) { b.click(); return s; } }
  const ACCEPT = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|i accept|i agree|agree( and close)?|accept and close|got it|ok(ay)?)$/i;
  const boxes = Array.from(document.querySelectorAll('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [aria-label*="cookie" i], [role="dialog"], [role="alertdialog"]')).filter(vis);
  for (const box of boxes) {
    if (!/cookie/i.test(box.innerText || "")) continue;
    const btn = Array.from(box.querySelectorAll("button, [role='button'], a")).find((b) => vis(b) && ACCEPT.test((b.innerText || b.textContent || "").trim()));
    if (btn) { btn.click(); return "cookie banner"; }
  }
  return null;
})()`;

export async function dismissCookies(page: Page): Promise<string | null> {
  const hit = (await withTimeout(page.evaluate(COOKIE_SRC), 4_000, "cookie banner").catch(() => null)) as string | null;
  if (hit) await page.waitForTimeout(400);
  return hit;
}

export async function settle(page: Page, ms = 600) {
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(ms);
  await dismissCookies(page);
}

/** Clicks an Apply-style button if the page shows no form yet. Follows a popup if one opens. Returns the page to continue on. */
export async function clickStartIfNeeded(page: Page, ctx: JobCtx): Promise<Page> {
  for (let i = 0; i < 3; i++) {
    const s = await scan(page);
    const formFields = s.fields.filter((f) => f.kind !== "file" && f.kind !== "checkbox").length;
    if (formFields >= 3) return page;
    const b = startButton(s);
    if (!b) return page;
    ctx.log(`click "${b.text}"`);
    // This page's own popup only: a context-wide "page" event also fires for other jobs' new tabs.
    const popup = page.waitForEvent("popup", { timeout: 6000 }).catch(() => null);
    // A button that re-renders as the page loads (Oracle "APPLY NOW") can miss once; the loop scans and tries again.
    await clickRef(page, b).catch((e) => ctx.log(`start click missed: ${String((e as Error).message).split(/\r?\n/)[0].slice(0, 80)}`));
    const np = await popup;
    if (np) { await settle(np); return np; }
    await settle(page);
  }
  return page;
}

export const greenhouse: Adapter = {
  name: "greenhouse",
  async start(page, ctx) {
    page = await clickStartIfNeeded(page, ctx);
    // Some employer sites take the Greenhouse link to their own careers pages (a job search, a directory). Greenhouse
    // always serves the plain form at its embed address, so go there when no application form is in sight.
    const s = await scan(page);
    const hasForm = s.fields.filter((f) => f.kind !== "checkbox").length >= 3 && s.fields.some((f) => /first name|e-?mail/i.test(f.label));
    const [, board, id] = jobKey(ctx.url).split(":");
    if (!hasForm && board && id && /^\d+$/.test(id)) {
      ctx.log(`no application form on ${new URL(page.url()).hostname}; opening Greenhouse's own form`);
      await page.goto(`https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${id}`, { waitUntil: "domcontentloaded" });
      await settle(page);
    }
    // Greenhouse boards keep the form below the description; bring it into view so lazy widgets render.
    await page.locator("#application, #application-form, form#application_form, iframe#grnhse_iframe").first().scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await settle(page, 400);
    return page;
  },
};

export const lever: Adapter = {
  name: "lever",
  async start(page) {
    const u = new URL(page.url());
    if (!/\/apply\/?$/.test(u.pathname)) { await page.goto(u.origin + u.pathname.replace(/\/$/, "") + "/apply"); await settle(page); }
    return page;
  },
};

export const ashby: Adapter = {
  name: "ashby",
  async start(page) {
    const u = new URL(page.url());
    if (!/\/application\/?$/.test(u.pathname)) { await page.goto(u.origin + u.pathname.replace(/\/$/, "") + "/application"); await settle(page); }
    return page;
  },
};

export const generic: Adapter = {
  name: "generic",
  async start(page, ctx) {
    return clickStartIfNeeded(page, ctx);
  },
};

/** Oracle Recruiting Cloud: when it asks how to fill the application, choose the manual (all-sections) form. */
export const oracle: Adapter = {
  name: "oracle",
  async start(page, ctx) {
    return clickStartIfNeeded(page, ctx);
  },
  async beforePage(page, snap, ctx) {
    if (!/choose how you.?d like to fill|let.?s make this quick|how would you like to (apply|fill)/i.test(snap.text)) return;
    const manual = page.locator("button, a, [role=button], [role=radio], [role=tab], label").filter({ hasText: /manual|myself|without (a |my )?(resume|cv)|skip|fill (it )?out (the form|it)? ?(yourself|manually)?$|enter (my |your )?(details|information)/i }).first();
    if (await manual.isVisible().catch(() => false)) {
      await manual.click().catch(() => {});
      ctx.log("oracle: chose to fill the application manually");
      await settle(page, 1500);
      return "handled";
    }
  },
};
