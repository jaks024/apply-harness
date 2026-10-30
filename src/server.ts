// Local dashboard: http://localhost:4321 (bound to 127.0.0.1 only). Serves ui/index.html, a JSON API and a
// server-sent-events stream of the manager's state. Start with `npm run ui`.
import { exec } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { config, ROOT } from "./config.js";
import { checkPosting, postedDate, postingDescription } from "./liveness.js";
import { noSponsorship } from "./engine-rules.js";
import { jobKey, platformOf } from "./jobkey.js";
import { Manager, type QueueItem } from "./manager.js";
import { addJobs, candidates, loadJobs, markApplied, markClosed, setJobStatus, unmarkApplied, type Candidate } from "./tracker.js";
import { needsSponsorship } from "./resolve.js";
import { findSubmitted, recordLedger, unrecordSubmission } from "./store.js";

const PORT = Number(process.env.UI_PORT ?? 4321);
const manager = new Manager({ persist: true });

const clients = new Set<ServerResponse>();
let pending: NodeJS.Timeout | undefined;
manager.on("change", () => {
  // Coalesce bursts of changes into one push.
  if (pending) return;
  pending = setTimeout(() => { pending = undefined; broadcast("state", manager.snapshot()); }, 150);
});
manager.on("log", (e) => broadcast("log", e));

function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

async function body(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, data: unknown, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(data) : (data as string));
}

type Annotated = Candidate & { platform: string; applied: string | null; posted: string | null; closed: string | null; noSponsor: string | null };

// Per-posting status from each ATS's public API: when it was published and whether it is still open. Cached on disk
// so the list loads instantly; rechecked after 12 hours (postings close all the time).
interface PostingStatus { posted: string | null; closed: string | null; noSponsor?: string | null; at: number }
const STATUS_FILE = join(config.paths.runs, "..", "posting-status.json");
const status: Record<string, PostingStatus> = existsSync(STATUS_FILE) ? JSON.parse(readFileSync(STATUS_FILE, "utf8")) : {};
const API_BACKED = /greenhouse|lever\.co|ashbyhq|myworkdayjobs|smartrecruiters|gh_jid=/i;
let filling = false;
async function fillStatus(rows: Annotated[]) {
  if (filling) return;
  filling = true;
  try {
    const stale = (r: Annotated) => !status[r.posting] || Date.now() - status[r.posting].at > 12 * 3600_000;
    const todo = rows.filter((r) => r.posting && !r.applied && API_BACKED.test(r.posting) && stale(r));
    let i = 0;
    let batch: Record<string, PostingStatus> = {};
    const flush = () => { if (Object.keys(batch).length) { broadcast("status", batch); batch = {}; } };
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (i < todo.length) {
        const r = todo[i++];
        const live = await checkPosting(r.posting);
        const open = live.state !== "closed";
        const desc = open ? await postingDescription(r.posting) : null;
        const st: PostingStatus = { posted: open ? await postedDate(r.posting) : status[r.posting]?.posted ?? null, closed: open ? null : live.evidence, noSponsor: desc && needsSponsorship ? noSponsorship(desc) : null, at: Date.now() };
        status[r.posting] = st;
        r.posted = st.posted; r.closed = st.closed; r.noSponsor = st.noSponsor ?? null;
        batch[r.id] = st;
        if (Object.keys(batch).length >= 10) flush();
      }
    }));
    flush();
    writeFileSync(STATUS_FILE, JSON.stringify(status));
  } finally { filling = false; }
}
let candCache: { at: number; rows: Annotated[] } | null = null;

async function loadCandidates(force: boolean): Promise<Annotated[]> {
  if (!force && candCache && Date.now() - candCache.at < 5 * 60_000) return candCache.rows;
  const rows = (await candidates()).map((c) => {
    // The tracker can say "new" for jobs the local receipts show as submitted; flag those so they aren't applied twice.
    const hit = c.posting ? findSubmitted(c.key, c.company, c.role, c.posting) : undefined;
    const st = status[c.posting];
    return { ...c, platform: c.posting ? platformOf(c.posting) : "other", applied: hit ? `${hit.submitted_at ?? "earlier"}${hit.source_files?.[0] === "tracker" ? " (job tracker)" : " (local receipts)"}` : null, posted: st?.posted ?? c.posted ?? null, closed: st?.closed ?? null, noSponsor: st?.noSponsor ?? null };
  });
  candCache = { at: Date.now(), rows };
  void fillStatus(rows);
  return rows;
}

/** "I applied myself" from the picker: tracker → applied (with a note), local ledger, and off the list. */
async function selfApplied(c: { id: string; posting: string; company: string; role: string }) {
  const key = jobKey(c.posting);
  const at = new Date().toISOString();
  const note = await markApplied({ url: c.posting, key, company: c.company, role: c.role, submittedAt: at, trackerId: c.id, title: `Submitted by hand — ${c.company}: ${c.role}`, summary: "Marked as applied by hand from the apply-harness dashboard." });
  recordLedger({ job_key: key, company: c.company, role: c.role, url: c.posting, platform: platformOf(c.posting), status: "submitted", submitted_at: at.slice(0, 10), source_files: ["dashboard: applied by hand"] });
  if (candCache) candCache.rows = candCache.rows.filter((r) => r.id !== c.id);
  return note;
}

/** "Not applied" from the picker: the local receipts (or the tracker) say submitted, but the user says it wasn't. */
async function unapplied(c: { id: string; posting: string; key: string; company: string; role: string }) {
  const key = jobKey(c.posting);
  const removed = unrecordSubmission(key, c.posting) + (c.key && c.key !== key ? unrecordSubmission(c.key) : 0);
  await unmarkApplied({ url: c.posting, key: c.key || key, company: c.company, role: c.role, trackerId: c.id, reason: "Marked not applied from the dashboard." });
  if (candCache) for (const r of candCache.rows) if (r.id === c.id) r.applied = null;
  return `removed ${removed} ledger record(s); the job can be queued again`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  try {
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      return send(res, 200, readFileSync(join(ROOT, "ui/index.html"), "utf8"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`event: state\ndata: ${JSON.stringify(manager.snapshot())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (req.method === "GET" && path === "/api/state") return send(res, 200, manager.snapshot());
    if (req.method === "GET" && path === "/api/candidates") return send(res, 200, await loadCandidates(url.searchParams.get("refresh") === "1"));
    if (req.method === "GET" && path === "/api/tracker") return send(res, 200, loadJobs());

    if (req.method === "POST") {
      const b = await body(req);
      if (path === "/api/queue") {
        const items: QueueItem[] = (b.items ?? []).map((i: QueueItem) => ({ url: i.url, company: i.company, role: i.role, trackerId: i.trackerId, priority: i.priority, location: i.location }));
        return send(res, 200, manager.add(items));
      }
      if (path === "/api/settings") {
        if (typeof b.concurrency === "number") manager.setConcurrency(b.concurrency);
        if (typeof b.paused === "boolean") manager.setPaused(b.paused);
        if (typeof b.reviewHoldsSlot === "boolean") manager.setReviewHoldsSlot(b.reviewHoldsSlot);
        return send(res, 200, manager.snapshot());
      }
      if (path === "/api/tracker/add") {
        const added = addJobs((b.items ?? []).filter((i: { url?: string }) => typeof i.url === "string" && /^https?:\/\//.test(i.url)));
        candCache = null;
        return send(res, 200, { added });
      }
      if (path === "/api/self-applied") return send(res, 200, { note: await selfApplied(b) });
      if (path === "/api/unapplied") return send(res, 200, { note: await unapplied(b) });
      if (path === "/api/closed") {
        const reason = b.reason === "no_sponsorship" || b.reason === "passed" ? b.reason : "closed";
        const note = await markClosed({ url: b.posting ?? "", key: b.posting ? jobKey(b.posting) : String(b.id), company: b.company, role: b.role, trackerId: b.id, evidence: b.evidence ?? (reason === "passed" ? "" : "marked closed from the dashboard"), reason });
        if (candCache) candCache.rows = candCache.rows.filter((r) => r.id !== b.id);
        return send(res, 200, { note });
      }
      const m = path.match(/^\/api\/jobs\/([\w-]+)\/(skip|retry|restart|pass|focus|remove|up|down|top|applied)$/);
      if (m) {
        const [, id, action] = m;
        if (action === "skip") await manager.skip(id);
        else if (action === "retry") manager.retry(id);
        else if (action === "restart") return send(res, 200, { ok: true, note: await manager.restart(id) });
        else if (action === "pass") return send(res, 200, { ok: true, note: `Passed. Tracker: ${await manager.pass(id)}` });
        else if (action === "focus") await manager.focus(id);
        else if (action === "remove") manager.remove(id);
        else if (action === "applied") await manager.markSelfApplied(id);
        else manager.move(id, action as "up" | "down" | "top");
        return send(res, 200, { ok: true });
      }
      const s = path.match(/^\/api\/tracker\/([\w-]+)\/status$/);
      if (s) {
        await setJobStatus(s[1], String(b.status));
        if (candCache) candCache.rows = candCache.rows.filter((r) => r.id !== s[1]);
        return send(res, 200, { ok: true });
      }
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 400, { error: String((e as Error).message ?? e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const link = `http://localhost:${PORT}`;
  console.log(`apply-harness dashboard: ${link}  (Ctrl+C to stop; queued jobs are saved and come back paused)`);
  if (!process.env.NO_OPEN) exec(process.platform === "win32" ? `start "" "${link}"` : `open "${link}"`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => { await manager.close(); process.exit(0); });
}
