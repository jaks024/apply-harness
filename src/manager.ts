// Long-lived job manager: a queue plus N slots. A job holds a slot from the moment it starts filling until it is
// submitted, skipped, closed or fails; then the next queued job starts. Used by the dashboard server and the CLI.
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "patchright";
import { rescue } from "./agent.js";
import type { JobCtx } from "./adapters/types.js";
import { launchBrowser } from "./browser.js";
import { config } from "./config.js";
import { runJob } from "./engine.js";
import { hardStop, isConfirmation, pageSignature } from "./engine-rules.js";
import { jobKey, platformOf } from "./jobkey.js";
import { json } from "./llm.js";
import { markApplied, markClosed, refreshSnapshot, unmarkApplied } from "./tracker.js";
import { checkPosting } from "./liveness.js";
import { scan } from "./scan.js";
import { findSubmitted, recordLedger, sameCompany, unrecordSubmission } from "./store.js";

export interface QueueItem { url: string; company?: string; role?: string; trackerId?: string; priority?: string; location?: string }
export type State = "queued" | "filling" | "needs_you" | "at_review" | "handoff" | "submitted" | "duplicate" | "closed" | "failed" | "skipped" | "ineligible";

const WORKING: State[] = ["filling", "needs_you"];
const WAITING_ON_USER: State[] = ["at_review", "handoff"];
const TERMINAL: State[] = ["submitted", "duplicate", "closed", "failed", "skipped", "ineligible"];
const ICON: Partial<Record<State, string>> = { needs_you: "⚠ NEEDS YOU", at_review: "✅ READY", handoff: "⚠ HANDOFF", submitted: "✔ SUBMITTED" };
const ts = () => new Date().toTimeString().slice(0, 8);

interface Job {
  id: string; item: QueueItem; key: string; platform: string; runDir: string;
  state: State; note?: string; flags: string[]; reviews: string[]; prior?: string;
  addedAt: string; startedAt?: string; endedAt?: string;
  ctx?: JobCtx; page?: Page; pages: Set<Page>; logTail: string[]; cancelled?: boolean;
}

export interface JobView {
  id: string; url: string; key: string; platform: string; company?: string; role?: string; trackerId?: string; priority?: string; location?: string;
  state: State; note?: string; flags: string[]; reviews: string[]; prior?: string; addedAt: string; startedAt?: string; endedAt?: string; logTail: string[];
}

export interface ManagerState { concurrency: number; paused: boolean; reviewHoldsSlot: boolean; browserOpen: boolean; jobs: JobView[] }

export function parseQueue(text: string): QueueItem[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const [url, company, role] = l.split(/\s*[|\t]\s*/);
    return { url, company: company || undefined, role: role || undefined };
  });
}

async function identify(page: Page, item: QueueItem): Promise<{ company?: string; role?: string }> {
  if (item.company && item.role) return item;
  const title = await page.title().catch(() => "");
  // ATS page titles already say who and what; the model is only the fallback.
  const fromTitle =
    title.match(/^Job Application for (.+?) at (.+)$/i)?.slice(1, 3) ??            // Greenhouse: role, company
    title.match(/^(.+?) @ (.+?)(?: \| Ashby)?$/)?.slice(1, 3) ??                     // Ashby: role, company
    title.match(/^(.+?) - (.+)$/)?.slice(1, 3).reverse();                              // Lever: company - role
  if (fromTitle && /greenhouse|ashbyhq|lever\.co/.test(page.url())) {
    return { company: item.company ?? fromTitle[1].trim(), role: item.role ?? fromTitle[0].trim() };
  }
  const h1 = await page.locator("h1").first().innerText({ timeout: 2000 }).catch(() => "");
  const ogSite = await page.locator('meta[property="og:site_name"]').getAttribute("content", { timeout: 1000 }).catch(() => null);
  try {
    const r = await json<{ company: string; role: string }>("field",
      "Extract the hiring company and job title from a job page. Return the employer's common name, not the ATS vendor.",
      JSON.stringify({ url: page.url(), title, h1, og_site_name: ogSite }),
      { type: "object", properties: { company: { type: "string" }, role: { type: "string" } }, required: ["company", "role"] });
    return { company: item.company ?? r.company, role: item.role ?? r.role };
  } catch { return { company: item.company ?? ogSite ?? undefined, role: item.role ?? (h1 || title) }; }
}

const QUEUE_FILE = join(config.paths.runs, "..", "queue.json");

export class Manager extends EventEmitter {
  concurrency: number;
  paused = false;
  reviewHoldsSlot = true;
  private jobs: Job[] = [];
  private browser?: BrowserContext;
  private launching?: Promise<BrowserContext>;
  private titleTimer?: NodeJS.Timeout;
  private runRoot: string;
  private seq = 0;
  private snapshotRefreshed = false;

  constructor(opts: { concurrency?: number; persist?: boolean } = {}) {
    super();
    this.concurrency = opts.concurrency ?? config.concurrency;
    const runId = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    this.runRoot = join(config.paths.runs, runId);
    mkdirSync(this.runRoot, { recursive: true });
    writeFileSync(join(config.paths.runs, "latest.txt"), runId);
    if (opts.persist) this.restore();
  }

  // ---------- public API ----------

  snapshot(): ManagerState {
    return {
      concurrency: this.concurrency, paused: this.paused, reviewHoldsSlot: this.reviewHoldsSlot, browserOpen: !!this.browser,
      jobs: this.jobs.map((j) => ({
        id: j.id, url: j.item.url, key: j.key, platform: j.platform, company: j.ctx?.company ?? j.item.company, role: j.ctx?.role ?? j.item.role,
        trackerId: j.item.trackerId, priority: j.item.priority, location: j.item.location, state: j.state, note: j.note, flags: j.flags, reviews: j.reviews,
        prior: j.prior, addedAt: j.addedAt, startedAt: j.startedAt, endedAt: j.endedAt, logTail: j.logTail.slice(-25),
      })),
    };
  }

  /** Adds postings to the end of the queue, skipping ones already in the manager (unless they ended without a submission). */
  add(items: QueueItem[]): { added: number; skipped: string[] } {
    const skipped: string[] = [];
    let added = 0;
    for (const item of items) {
      if (!/^https?:\/\//.test(item.url ?? "")) { skipped.push(`${item.url}: not a URL`); continue; }
      const key = jobKey(item.url);
      const existing = this.jobs.find((j) => j.key === key && !["closed", "failed", "skipped"].includes(j.state));
      if (existing) { skipped.push(`${item.company ?? key}: already ${existing.state}`); continue; }
      const id = `j${Date.now().toString(36)}${(this.seq++).toString(36)}`;
      const slug = `${String(this.jobs.length + 1).padStart(2, "0")}-${key.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}`;
      this.jobs.push({ id, item, key, platform: platformOf(item.url), runDir: join(this.runRoot, slug), state: "queued", flags: [], reviews: [], addedAt: new Date().toISOString(), pages: new Set(), logTail: [] });
      added++;
    }
    this.changed();
    this.pump();
    return { added, skipped };
  }

  setConcurrency(n: number) { this.concurrency = Math.max(1, Math.min(16, Math.round(n))); this.changed(); this.pump(); }
  setPaused(p: boolean) { this.paused = p; this.changed(); this.pump(); }
  setReviewHoldsSlot(v: boolean) { this.reviewHoldsSlot = v; this.changed(); this.pump(); }

  remove(id: string) {
    const j = this.get(id);
    if (j.state !== "queued" && !TERMINAL.includes(j.state)) throw new Error("Skip a running job instead of removing it");
    this.jobs = this.jobs.filter((x) => x.id !== id);
    this.changed();
  }

  move(id: string, dir: "up" | "down" | "top") {
    const queued = this.jobs.filter((j) => j.state === "queued");
    const j = this.get(id);
    const qi = queued.indexOf(j);
    if (qi < 0) return;
    const target = dir === "top" ? queued[0] : dir === "up" ? queued[qi - 1] : queued[qi + 1];
    if (!target || target === j) return;
    const from = this.jobs.indexOf(j);
    this.jobs.splice(from, 1);
    const to = this.jobs.indexOf(target) + (dir === "down" ? 1 : 0);
    this.jobs.splice(to, 0, j);
    this.changed();
  }

  async skip(id: string) {
    const j = this.get(id);
    j.cancelled = true;
    for (const p of [j.page, ...j.pages]) if (p && !p.isClosed()) await p.close().catch(() => {});
    this.set(j, "skipped", "skipped from the dashboard");
  }

  retry(id: string) {
    const j = this.get(id);
    if (!["failed", "closed", "handoff", "skipped", "duplicate", "ineligible"].includes(j.state)) throw new Error(`Can't retry a ${j.state} job`);
    for (const p of [j.page, ...j.pages]) if (p && !p.isClosed()) p.close().catch(() => {});
    Object.assign(j, { state: "queued", note: "retry", flags: [], reviews: [], cancelled: false, page: undefined, pages: new Set(), ctx: undefined, startedAt: undefined, endedAt: undefined, force: j.state === "duplicate" || j.state === "ineligible" || /^posting is closed/.test(j.note ?? "") });
    this.changed();
    this.pump();
  }

  /**
   * Restart from the beginning: stop whatever the job is doing, close its tabs, and queue a fresh run at the front
   * (duplicate checks skipped: the user asked for it). A submitted job the user says wasn't submitted (assumed on tab
   * close, or a false confirmation) is undone in the tracker and the ledger first.
   */
  async restart(id: string): Promise<string> {
    const j = this.get(id);
    if (j.state === "queued") return "already queued";
    let undo = "";
    if (j.state === "submitted") {
      const removed = unrecordSubmission(j.key, j.item.url);
      const tracked = await unmarkApplied({ url: j.item.url, key: j.key, company: j.ctx?.company ?? j.item.company, role: j.ctx?.role ?? j.item.role, trackerId: j.item.trackerId, reason: "The dashboard marked this as submitted, but the user says it wasn't. Restarted from the beginning." }).catch((e) => `failed: ${(e as Error).message}`);
      undo = ` Undid the submission (ledger: ${removed}, Tracker: ${tracked}).`;
    }
    j.cancelled = true;
    for (const p of [j.page, ...j.pages]) if (p && !p.isClosed()) await p.close().catch(() => {});
    const at = this.jobs.indexOf(j);
    this.jobs.splice(at, 1);
    const fresh: Job = { id: `j${Date.now().toString(36)}${(this.seq++).toString(36)}`, item: j.item, key: j.key, platform: j.platform, runDir: `${j.runDir}-r${Date.now().toString(36).slice(-4)}`, state: "queued", note: "restarted from the beginning", flags: [], reviews: [], addedAt: new Date().toISOString(), pages: new Set(), logTail: [] };
    (fresh as Job & { force?: boolean }).force = true;
    const firstQueued = this.jobs.findIndex((x) => x.state === "queued");
    this.jobs.splice(firstQueued < 0 ? this.jobs.length : firstQueued, 0, fresh);
    this.changed();
    this.pump();
    return `restarted${undo}`;
  }

  /** "I applied myself": record it like a detected submission (ledger + tracker applied), close its tabs, free the slot. */
  async markSelfApplied(id: string) {
    const j = this.get(id);
    if (j.state === "submitted") return;
    j.cancelled = true;
    const at = new Date().toISOString();
    const company = j.ctx?.company ?? j.item.company;
    const role = j.ctx?.role ?? j.item.role;
    let tracked: string;
    try {
      tracked = await markApplied({ url: j.item.url, key: j.key, company, role, submittedAt: at, trackerId: j.item.trackerId, title: `Submitted by hand — ${company ?? "?"}: ${role ?? "?"}`, summary: "Marked as applied by hand from the apply-harness dashboard." });
    } catch (e) { tracked = `failed: ${(e as Error).message}`; }
    recordLedger({ job_key: j.key, company, role, url: j.item.url, platform: j.platform, status: "submitted", submitted_at: at.slice(0, 10), run_dir: j.runDir, source_files: ["dashboard: applied by hand"] });
    for (const p of [j.page, ...j.pages]) if (p && !p.isClosed()) await p.close().catch(() => {});
    this.set(j, "submitted", `marked applied by hand. Tracker: ${tracked}`);
  }

  /** "Pass": not applicable. Stop it, close its tabs, tracker → pass with a note, and mark it skipped here. */
  async pass(id: string): Promise<string> {
    const j = this.get(id);
    if (j.state === "submitted") throw new Error("Already submitted");
    j.cancelled = true;
    for (const p of [j.page, ...j.pages]) if (p && !p.isClosed()) await p.close().catch(() => {});
    const tracked = await markClosed({ url: j.item.url, key: j.key, company: j.ctx?.company ?? j.item.company, role: j.ctx?.role ?? j.item.role, trackerId: j.item.trackerId, evidence: "", reason: "passed" }).catch((e) => `failed: ${(e as Error).message}`);
    this.set(j, "skipped", `passed (not applicable). Tracker: ${tracked}`);
    return tracked;
  }

  async focus(id: string) {
    const j = this.get(id);
    const p = [...j.pages].reverse().find((x) => !x.isClosed()) ?? j.page;
    if (!p || p.isClosed()) throw new Error("That tab is closed");
    await p.bringToFront();
  }

  /** True when nothing is queued or running (used by the CLI to know when to exit). */
  idle(): boolean { return this.jobs.every((j) => TERMINAL.includes(j.state)); }

  async close() {
    if (this.titleTimer) clearInterval(this.titleTimer);
    await this.browser?.close().catch(() => {});
  }

  // ---------- internals ----------

  private get(id: string): Job {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new Error(`No job ${id}`);
    return j;
  }

  private changed() {
    this.emit("change", this.snapshot());
    this.persist();
  }

  private persist() {
    // Only the queue survives a restart; running tabs die with the browser, so they go back to the queue.
    const pending = this.jobs.filter((j) => j.state === "queued" || WORKING.includes(j.state) || WAITING_ON_USER.includes(j.state)).map((j) => j.item);
    writeFileSync(QUEUE_FILE, JSON.stringify({ saved: new Date().toISOString(), concurrency: this.concurrency, reviewHoldsSlot: this.reviewHoldsSlot, pending }, null, 2));
  }

  private restore() {
    if (!existsSync(QUEUE_FILE)) return;
    try {
      const d = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
      if (typeof d.concurrency === "number") this.concurrency = d.concurrency;
      if (typeof d.reviewHoldsSlot === "boolean") this.reviewHoldsSlot = d.reviewHoldsSlot;
      // Only a leftover queue from last session waits for an explicit Start; an empty one starts ready.
      if (Array.isArray(d.pending) && d.pending.length) { this.paused = true; this.add(d.pending); }
    } catch { /* ignore a corrupt queue file */ }
  }

  private slotsUsed(): number {
    return this.jobs.filter((j) => WORKING.includes(j.state) || (this.reviewHoldsSlot && WAITING_ON_USER.includes(j.state))).length;
  }

  private pump() {
    if (this.paused) return;
    while (this.slotsUsed() < this.concurrency) {
      const next = this.jobs.find((j) => j.state === "queued");
      if (!next) break;
      next.state = "filling"; // claim the slot synchronously so the loop doesn't over-start
      void this.run(next);
    }
  }

  private async ensureBrowser(): Promise<BrowserContext> {
    if (this.browser) return this.browser;
    this.launching ??= (async () => {
      const refreshed = await refreshSnapshot().catch(() => null);
      if (!this.snapshotRefreshed) { this.snapshotRefreshed = true; console.log(`${ts()} duplicate check: ${refreshed ?? "saved"} applied jobs in the tracker + local ledger`); }
      const b = await launchBrowser();
      b.on("close", () => {
        this.browser = undefined; this.launching = undefined;
        if (this.titleTimer) clearInterval(this.titleTimer);
        for (const j of this.jobs) if (WORKING.includes(j.state) || WAITING_ON_USER.includes(j.state)) this.set(j, "closed", "browser was closed");
      });
      // Tabs a job opens (popups, "apply on company site") belong to that job.
      b.on("page", (p) => { p.opener().then((o) => { const j = o && this.jobs.find((x) => x.page === o || x.pages.has(o)); if (j) j.pages.add(p); }).catch(() => {}); });
      this.titleTimer = setInterval(() => {
        for (const j of this.jobs) {
          const t = ICON[j.state];
          const p = j.page;
          if (t && p && !p.isClosed()) p.evaluate((x) => { if (!document.title.startsWith(x)) document.title = `${x} · ${document.title.replace(/^(✅|⚠|✔)[^·]*· /, "")}`; }, t).catch(() => {});
        }
      }, 2000);
      this.browser = b;
      this.changed();
      return b;
    })();
    return this.launching;
  }

  private set(j: Job, state: State, note?: string) {
    j.state = state; j.note = note;
    if (TERMINAL.includes(state)) j.endedAt = new Date().toISOString();
    this.log(j, `${state.toUpperCase()}${note ? ` — ${note}` : ""}`, true);
    this.changed();
    if (TERMINAL.includes(state) || WAITING_ON_USER.includes(state)) this.pump();
  }

  private log(j: Job, s: string, always = false) {
    const line = `${ts()} ${s}`;
    j.logTail.push(line);
    if (j.logTail.length > 200) j.logTail.splice(0, j.logTail.length - 200);
    mkdirSync(j.runDir, { recursive: true });
    appendFileSync(join(j.runDir, "log.txt"), line + "\n");
    if (always || process.env.VERBOSE) console.log(`${ts()} [${(j.ctx?.company ?? j.key).slice(0, 24)}] ${s}`);
    if (!always) this.emit("log", { id: j.id, line });
  }

  private async run(job: Job) {
    job.startedAt = new Date().toISOString();
    const log = (s: string) => this.log(job, s);
    try {
      const dup = !(job as { force?: boolean }).force && findSubmitted(job.key, job.item.company, job.item.role, job.item.url);
      if (dup) return this.set(job, "duplicate", `already submitted${dup.submitted_at ? " " + dup.submitted_at : ""} (${dup.company ?? ""} ${dup.role ?? ""})`);
      // Ask the job board first: a removed posting often redirects to a careers search page that looks like a form.
      // "Apply anyway" (force) skips this check too.
      const live = (job as { force?: boolean }).force ? { state: "unknown" as const, evidence: "" } : await checkPosting(job.item.url);
      if (live.state === "closed") {
        const tracked = await markClosed({ url: job.item.url, key: job.key, company: job.item.company, role: job.item.role, trackerId: job.item.trackerId, evidence: live.evidence }).catch((e) => `failed: ${(e as Error).message}`);
        return this.set(job, "closed", `posting is closed (${live.evidence}). Tracker: ${tracked}`);
      }
      this.set(job, "filling");
      const browser = await this.ensureBrowser();
      let page = await browser.newPage();
      job.page = page;
      log(`opening ${job.item.url}`);
      await page.goto(job.item.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      if (job.cancelled) return;
      const who = await identify(page, job.item);
      const dup2 = !(job as { force?: boolean }).force && findSubmitted(job.key, who.company, who.role, page.url());
      if (dup2) { await page.close(); return this.set(job, "duplicate", `already submitted (${dup2.company} ${dup2.role})`); }
      const ctx: JobCtx = {
        url: job.item.url, key: job.key, platform: job.platform, company: who.company, role: who.role,
        files: { resume: config.paths.resume, transcript: config.paths.transcript },
        runDir: job.runDir, log, decisions: [], resumeUploaded: false,
        // The engine may swap a stuck tab for a fresh one; everything below follows the job's current tab.
        replacePage: (p) => { job.page = p; job.pages.add(p); this.changed(); },
        ignoreNoSponsorship: (job as { force?: boolean }).force,
        waitForUser: async (reason) => {
          this.set(job, "needs_you", reason);
          const cur = () => job.page!;
          await cur().bringToFront().catch(() => {});
          const startSig = pageSignature(await scan(cur()));
          const deadline = Date.now() + 30 * 60_000;
          while (Date.now() < deadline && !cur().isClosed() && !job.cancelled) {
            await new Promise((r) => setTimeout(r, 3000));
            const s = await scan(cur()).catch(() => null);
            if (!s) continue;
            if (!hardStop(s) && (pageSignature(s) !== startSig || reason.startsWith("Solve the CAPTCHA"))) { this.set(job, "filling", "resumed"); return true; }
          }
          return false;
        },
        setStatus: (state, note) => { if (!job.cancelled) this.set(job, state, note); },
        rescue: async (goal) => {
          const r = await rescue(job.page!, goal, ctx.files, log, { stopOnAdvance: true }).catch((e) => ({ state: "gave_up" as const, note: String(e), steps: 0 }));
          log(`rescue → ${r.state} after ${r.steps} steps: ${r.note}`);
          return r.state;
        },
      };
      job.ctx = ctx;
      const prior = sameCompany(who.company);
      ctx.postingText = (await scan(page).catch(() => null))?.text.slice(0, 8000);
      ctx.priorApplications = prior.map((r) => `${r.role ?? "role not recorded"} (${r.status ?? "Applied"})`);
      job.prior = prior.length ? `Applied to ${who.company} before: ${prior.map((r) => r.role ?? "role not recorded").join("; ").slice(0, 160)}` : undefined;
      this.changed();
      log(`${who.company} — ${who.role} (${job.platform}, ${job.key})`);
      const out = await runJob(page, ctx);
      if (job.cancelled) return;
      page = out.page;
      job.page = page;
      writeFileSync(join(job.runDir, "fields.json"), JSON.stringify(ctx.decisions, null, 2));
      if (out.state === "already_submitted") return void (await this.recordSubmission(job, page, "confirmation page reached during fill"));
      if (out.state === "ineligible") {
        const tracked = await markClosed({ url: job.item.url, key: job.key, company: who.company, role: who.role, trackerId: job.item.trackerId, evidence: out.reason, reason: "no_sponsorship" }).catch((e) => `failed: ${(e as Error).message}`);
        for (const p of [job.page, ...job.pages]) if (p && !p.isClosed()) await p.close().catch(() => {});
        return this.set(job, "ineligible", `role won't sponsor: "${out.reason.slice(0, 160)}". Tracker: ${tracked}`);
      }
      await page.screenshot({ path: join(job.runDir, "review.png"), fullPage: true }).catch(() => {});
      job.flags = ctx.decisions.filter((d) => d.action === "flag").map((d) => `${d.label.slice(0, 90)}${d.reason ? ` — ${d.reason}` : ""}`);
      job.reviews = ctx.decisions.filter((d) => d.review).map((d) => `${d.label.slice(0, 70)}: ${String(d.value ?? "").slice(0, 160)}`);
      if (out.state === "at_review") this.set(job, "at_review", job.flags.length ? `${job.flags.length} field(s) need you` : "Ready: review and Submit");
      else this.set(job, "handoff", out.reason);
      void this.watch(job);
    } catch (e) {
      if (job.cancelled) return;
      this.set(job, "failed", String((e as Error).message ?? e).split("\n")[0].slice(0, 200));
      if (job.page && !job.page.isClosed()) void this.watch(job);
    }
  }

  private async recordSubmission(job: Job, page: Page, how: string) {
    const s = await scan(page).catch(() => null);
    const submittedAt = new Date().toISOString();
    const receipt = {
      job_key: job.key, url: job.item.url, final_url: page.url(), platform: job.ctx?.platform ?? job.platform,
      company: job.ctx?.company ?? job.item.company, role: job.ctx?.role ?? job.item.role, submitted_at: submittedAt, how,
      confirmation_text: s?.text.match(/.{0,120}(thank you|submitted|received).{0,160}/i)?.[0] ?? null,
      resume: config.paths.resume, decisions: job.ctx?.decisions ?? [],
    };
    mkdirSync(job.runDir, { recursive: true });
    writeFileSync(join(job.runDir, "receipt.json"), JSON.stringify(receipt, null, 2));
    await page.screenshot({ path: join(job.runDir, "confirmation.png") }).catch(() => {});
    let tracked = "skipped";
    try { tracked = await markApplied({ url: job.item.url, company: receipt.company, role: receipt.role, key: job.key, submittedAt, trackerId: job.item.trackerId, summary: `Submitted via apply-harness. Confirmation: ${receipt.confirmation_text ?? receipt.final_url}` }); }
    catch (e) { tracked = `failed: ${(e as Error).message}`; }
    recordLedger({ job_key: job.key, company: receipt.company, role: receipt.role, url: job.item.url, platform: receipt.platform, status: "submitted", submitted_at: submittedAt.slice(0, 10), run_dir: job.runDir, source_files: [join(job.runDir, "receipt.json")] });
    this.set(job, "submitted", `Tracker: ${tracked}`);
  }

  private async recordAssumedSubmission(job: Job) {
    const at = new Date().toISOString();
    const company = job.ctx?.company ?? job.item.company;
    const role = job.ctx?.role ?? job.item.role;
    mkdirSync(job.runDir, { recursive: true });
    writeFileSync(join(job.runDir, "receipt.json"), JSON.stringify({ job_key: job.key, url: job.item.url, company, role, submitted_at: at, how: "tab closed by the user after filling; assumed submitted", decisions: job.ctx?.decisions ?? [] }, null, 2));
    let tracked: string;
    try { tracked = await markApplied({ url: job.item.url, key: job.key, company, role, submittedAt: at, trackerId: job.item.trackerId, summary: "Submitted by the user; the tab was closed before a confirmation page was seen (assumed submitted)." }); }
    catch (e) { tracked = `failed: ${(e as Error).message}`; }
    recordLedger({ job_key: job.key, company, role, url: job.item.url, platform: job.platform, status: "submitted", submitted_at: at.slice(0, 10), run_dir: job.runDir, source_files: ["tab closed: assumed submitted"] });
    this.set(job, "submitted", `assumed submitted (tab closed). Tracker: ${tracked}`);
  }

  /** After the stop: watch the job's tabs until the user submits, closes them, skips, or time runs out. */
  private async watch(job: Job) {
    const deadline = Date.now() + config.fill.watchMinutes * 60_000;
    if (job.page) job.pages.add(job.page);
    while (Date.now() < deadline && !TERMINAL.includes(job.state)) {
      await new Promise((r) => setTimeout(r, 3000));
      if (TERMINAL.includes(job.state) || job.cancelled) return;
      const open = [...job.pages].filter((p) => !p.isClosed());
      if (!open.length) {
        // Closing the tab of a job that was ready (green) means you submitted it.
        // A job that wasn't ready (needs you, finish by hand) was abandoned, not submitted.
        if (job.state === "at_review") return void (await this.recordAssumedSubmission(job));
        return this.set(job, "closed", job.state === "handoff" || job.state === "needs_you" ? "tab closed before it was ready; not marked submitted (Restart to try again)" : "tab closed without a confirmation");
      }
      for (const p of open) {
        const s = await scan(p).catch(() => null);
        if (s && isConfirmation(s)) return void (await this.recordSubmission(job, p, "user submitted; confirmation detected"));
      }
    }
    if (!TERMINAL.includes(job.state) && !job.cancelled) this.set(job, "closed", "watch timed out");
  }
}
