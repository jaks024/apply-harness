// The local job tracker: data/jobs.json, one record per posting, with a status and an event history.
// The dashboard's picker lists the "new" and "interested" jobs; submissions set "applied"; the duplicate check reads
// every applied/interview/offer/rejected record. Add jobs from the dashboard, with `npm run add-job`, or have any
// job-search tool (or an AI agent) write records in this shape: see docs/tracker.md.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { jobKey } from "./jobkey.js";

export const STATUSES = ["new", "interested", "applied", "interview", "offer", "rejected", "pass", "closed"] as const;
export type Status = (typeof STATUSES)[number];
/** Statuses that mean "already applied": the duplicate check skips these postings. */
const APPLIED: Status[] = ["applied", "interview", "offer", "rejected"];

export interface TrackedJob {
  id: string; url: string; key: string; company: string; role: string; status: Status;
  location?: string; priority?: string; notes?: string; source?: string;
  added_at: string; posted_at?: string; updated_at: string;
  events: { at: string; title: string; note?: string }[];
}
/** The fields the duplicate check reads. */
export interface TrackedRow { key: string; posting: string; company: string; role: string; status: string }

const file = () => config.paths.tracker;

export function loadJobs(): TrackedJob[] {
  if (!existsSync(file())) return [];
  const raw = readFileSync(file(), "utf8").trim();
  if (!raw) return [];
  const jobs = JSON.parse(raw) as Partial<TrackedJob>[];
  // Hand-written or tool-written records may leave out the bookkeeping fields.
  return jobs.filter((j) => j.url || j.company).map((j) => {
    const now = new Date().toISOString();
    return {
      ...j, id: j.id ?? randomUUID(), url: j.url ?? "", key: j.key || (j.url ? jobKey(j.url) : ""), company: j.company ?? "", role: j.role ?? "",
      status: (STATUSES as readonly string[]).includes(String(j.status).toLowerCase()) ? (String(j.status).toLowerCase() as Status) : "new",
      added_at: j.added_at ?? now, updated_at: j.updated_at ?? j.added_at ?? now, events: j.events ?? [],
    };
  });
}

function saveJobs(jobs: TrackedJob[]) {
  // Write-then-rename, so a crash or a reader never sees half a file.
  writeFileSync(`${file()}.tmp`, JSON.stringify(jobs, null, 2) + "\n");
  renameSync(`${file()}.tmp`, file());
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

/** The record for a posting: by id, then posting URL, then job key. */
function find(jobs: TrackedJob[], job: { id?: string; url?: string; key?: string }): TrackedJob | undefined {
  return (job.id ? jobs.find((j) => j.id === job.id) : undefined)
    ?? (job.url ? jobs.find((j) => j.url && (sameUrl(j.url, job.url!) || j.key === jobKey(job.url!))) : undefined)
    ?? (job.key ? jobs.find((j) => j.key === job.key!.toLowerCase()) : undefined);
}

/** Adds postings that aren't tracked yet (matched by URL / job key). Returns how many were new. */
export function addJobs(items: { url: string; company?: string; role?: string; location?: string; priority?: string; notes?: string; source?: string; posted_at?: string; status?: Status }[]): number {
  const jobs = loadJobs();
  let added = 0;
  const now = new Date().toISOString();
  for (const i of items) {
    if (!i.url || find(jobs, { url: i.url })) continue;
    jobs.push({
      id: randomUUID(), url: i.url, key: jobKey(i.url), company: i.company ?? "", role: i.role ?? "", status: i.status ?? "new",
      location: i.location, priority: i.priority, notes: i.notes, source: i.source ?? "manual", posted_at: i.posted_at,
      added_at: now, updated_at: now, events: [{ at: now, title: "Added" }],
    });
    added++;
  }
  if (added) saveJobs(jobs);
  return added;
}

/** Sets a record's status and logs why. Creates the record when the posting isn't tracked yet. */
function setStatus(job: { id?: string; url: string; key: string; company?: string; role?: string }, status: Status, title: string, note?: string): string {
  const jobs = loadJobs();
  const now = new Date().toISOString();
  let row = find(jobs, job);
  let how = "updated";
  if (!row) {
    if (!job.url && !job.company) return "not tracked";
    row = { id: randomUUID(), url: job.url, key: job.key || jobKey(job.url), company: job.company ?? "", role: job.role ?? "", status, source: "apply-harness", added_at: now, updated_at: now, events: [] };
    jobs.push(row);
    how = "added";
  }
  row.status = status;
  row.updated_at = now;
  if (job.company && !row.company) row.company = job.company;
  if (job.role && !row.role) row.role = job.role;
  row.events.push({ at: now, title, ...(note ? { note } : {}) });
  saveJobs(jobs);
  return `${how}: ${status}`;
}

// ---------- duplicate index ----------

export function readSnapshot(): TrackedRow[] {
  return loadJobs().filter((j) => APPLIED.includes(j.status)).map((j) => ({ key: j.key, posting: j.url, company: j.company, role: j.role, status: j.status }));
}

/** Kept for the run loop: the tracker is local, so there is nothing to refresh. Returns the applied-record count. */
export async function refreshSnapshot(): Promise<number> { return readSnapshot().length; }

/** Keys under which a record counts as "already applied": its job key and its posting URL. */
export function appliedIndex(): Map<string, TrackedRow> {
  const idx = new Map<string, TrackedRow>();
  for (const r of readSnapshot()) {
    if (r.key) idx.set(r.key.toLowerCase(), r);
    if (r.posting) { idx.set(jobKey(r.posting), r); idx.set(r.posting.replace(/\/+$/, "").toLowerCase(), r); }
  }
  return idx;
}

// ---------- candidates for the dashboard ----------

export interface Candidate {
  id: string; company: string; role: string; posting: string; key: string;
  priority: string; location: string; status: string; notes: string; created: string; posted: string | null; isToday: boolean;
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Jobs waiting to be applied to (status new/interested), newest first. "Today" = added today (local time). */
export async function candidates(statuses: Status[] = ["new", "interested"]): Promise<Candidate[]> {
  const today = localDate(new Date());
  return loadJobs().filter((j) => statuses.includes(j.status)).sort((a, b) => b.added_at.localeCompare(a.added_at)).map((j) => ({
    id: j.id, company: j.company, role: j.role, posting: j.url, key: j.key, priority: j.priority ?? "", location: j.location ?? "",
    status: j.status, notes: j.notes ?? "", created: j.added_at, posted: j.posted_at ?? null, isToday: localDate(new Date(j.added_at)) === today,
  }));
}

export async function setJobStatus(id: string, status: string): Promise<void> {
  const s = status.toLowerCase() as Status;
  if (!STATUSES.includes(s)) throw new Error(`unknown status "${status}"; use one of ${STATUSES.join(", ")}`);
  const job = loadJobs().find((j) => j.id === id);
  if (!job) throw new Error(`no tracked job ${id}`);
  setStatus(job, s, `Status set to ${s}`);
}

// ---------- write-back ----------

/** A posting that's gone, won't sponsor, or that the user passed on: status pass/closed with the evidence. */
export async function markClosed(job: { url: string; key: string; company?: string; role?: string; trackerId?: string; evidence: string; reason?: "closed" | "no_sponsorship" | "passed" }): Promise<string> {
  const ref = { id: job.trackerId, url: job.url, key: job.key, company: job.company, role: job.role };
  if (job.reason === "passed") return setStatus(ref, "pass", "Passed from the dashboard", job.evidence || undefined);
  if (job.reason === "no_sponsorship") return setStatus(ref, "pass", "Not eligible: the posting says it won't sponsor", `Quote: "${job.evidence}"`);
  return setStatus(ref, "closed", "Posting closed (checked before applying)", job.evidence);
}

export async function markApplied(job: { url: string; company?: string; role?: string; key: string; submittedAt: string; summary: string; trackerId?: string; title?: string }): Promise<string> {
  return setStatus({ id: job.trackerId, url: job.url, key: job.key, company: job.company, role: job.role }, "applied", job.title ?? "Submitted", job.summary);
}

/** Undo a wrong "applied" (a submission the user didn't make): status back to new, with a note. */
export async function unmarkApplied(job: { url: string; company?: string; role?: string; key: string; trackerId?: string; reason: string }): Promise<string> {
  const row = find(loadJobs(), { id: job.trackerId, url: job.url, key: job.key });
  if (!row || !APPLIED.includes(row.status)) return "not marked applied";
  return setStatus(row, "new", "Not submitted (correction)", job.reason);
}
