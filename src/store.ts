import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { config } from "./config.js";
import { jobKey } from "./jobkey.js";
import { appliedIndex, readSnapshot, type TrackedRow } from "./tracker.js";

// ---------- ledger ----------

export type LedgerStatus = "submitted" | "not_submitted" | "in_progress" | "unknown";

export interface LedgerRecord {
  job_key: string;
  alt_keys?: string[];
  company?: string | null;
  role?: string | null;
  url?: string | null;
  platform?: string;
  status: LedgerStatus;
  outcome?: string | null;
  submitted_at?: string | null;
  tracker_id?: string | null;
  run_dir?: string;
  source_files?: string[];
  migrated?: boolean;
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

export function appendJsonl(path: string, rec: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + "\n");
}

/** Latest record per key wins, except a submitted record is never downgraded. */
export function loadLedger(): Map<string, LedgerRecord> {
  const map = new Map<string, LedgerRecord>();
  for (const r of readJsonl<LedgerRecord>(config.paths.ledger)) {
    for (const k of [r.job_key, ...(r.alt_keys ?? [])]) {
      const prev = map.get(k);
      if (prev?.status === "submitted" && r.status !== "submitted") continue;
      map.set(k, r);
    }
  }
  return map;
}

const fromTracker = (j: TrackedRow): LedgerRecord => ({ job_key: j.key, company: j.company, role: j.role, url: j.posting, status: "submitted", outcome: j.status === "applied" ? null : j.status, source_files: ["tracker"] });
const normText = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const normCompany = (s: string) => s.toLowerCase().replace(/\b(inc|llc|corp|corporation|company|co|group|holdings)\b/g, "").replace(/[^a-z0-9]+/g, "");

/** The job tracker first, then the local ledger: same job key, same posting URL, or same company + role. */
export function findSubmitted(key: string, company?: string, role?: string, url?: string): LedgerRecord | undefined {
  const tracked = appliedIndex();
  const n = tracked.get(key) ?? (url ? tracked.get(jobKey(url)) ?? tracked.get(url.replace(/\/+$/, "").toLowerCase()) : undefined);
  if (n) return fromTracker(n);
  const ledger = loadLedger();
  const hit = ledger.get(key);
  if (hit?.status === "submitted") return hit;
  if (company && role) {
    for (const j of tracked.values()) if (normCompany(j.company) === normCompany(company) && normText(j.role) === normText(role)) return fromTracker(j);
    for (const r of ledger.values()) {
      if (r.status === "submitted" && r.company && r.role && normCompany(r.company) === normCompany(company) && normText(r.role) === normText(role)) return r;
    }
  }
  return undefined;
}

/** Past submissions at the same company (for a warning only — a different role there is a legitimate application). */
export function sameCompany(company?: string): { role?: string | null; status?: string }[] {
  if (!company) return [];
  const c = normCompany(company);
  if (c.length < 3) return [];
  const roles = new Map<string, { role?: string | null; status?: string }>();
  for (const j of readSnapshot()) if (normCompany(j.company) === c) roles.set(normText(j.role), { role: j.role, status: j.status });
  for (const r of loadLedger().values()) if (r.status === "submitted" && r.company && normCompany(r.company) === c) roles.set(normText(r.role ?? r.job_key), { role: r.role, status: "Applied" });
  return [...roles.values()];
}

export function recordLedger(rec: LedgerRecord): void {
  appendJsonl(config.paths.ledger, rec);
}

/**
 * Undoes a wrong "submitted" (the user didn't actually submit it): removes this job's submitted records from the
 * ledger, keeping a copy in ledger-reverted.jsonl. Returns how many were removed.
 */
export function unrecordSubmission(key: string, url?: string): number {
  if (!existsSync(config.paths.ledger)) return 0;
  const keys = new Set([key, ...(url ? [jobKey(url)] : [])]);
  const lines = readFileSync(config.paths.ledger, "utf8").split("\n").filter(Boolean);
  const drop = lines.filter((l) => { try { const r = JSON.parse(l) as LedgerRecord; return r.status === "submitted" && [r.job_key, ...(r.alt_keys ?? [])].some((k) => keys.has(k)); } catch { return false; } });
  if (!drop.length) return 0;
  const keep = lines.filter((l) => !drop.includes(l));
  writeFileSync(config.paths.ledger, keep.join("\n") + (keep.length ? "\n" : ""));
  for (const l of drop) appendFileSync(join(dirname(config.paths.ledger), "ledger-reverted.jsonl"), `${JSON.stringify({ reverted_at: new Date().toISOString(), record: JSON.parse(l) })}\n`);
  return drop.length;
}

// ---------- accounts (plaintext by user decision) ----------

export interface Account { email: string; password: string; created_at: string; status: "created" | "pending_verification" | "signed_in" | "failed"; employer?: string }
interface AccountsFile { tenants: Record<string, Account>; legacy?: unknown[] }

function readAccounts(): AccountsFile {
  if (!existsSync(config.paths.accounts)) return { tenants: {} };
  const d = JSON.parse(readFileSync(config.paths.accounts, "utf8"));
  return { tenants: d.tenants ?? {}, legacy: d.legacy };
}

export function getAccount(tenant: string): Account | undefined {
  return readAccounts().tenants[tenant];
}

export function saveAccount(tenant: string, acct: Account): void {
  const d = readAccounts();
  d.tenants[tenant] = acct;
  writeFileSync(config.paths.accounts, JSON.stringify(d, null, 2));
}

/** 16 chars, guaranteed upper/lower/digit/special — satisfies Workday, Taleo, iCIMS policies. */
export function newPassword(): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%&*?"];
  const chars = sets.map((s) => s[randomInt(s.length)]);
  const all = sets.join("");
  const bytes = randomBytes(12);
  for (const b of bytes) chars.push(all[b % all.length]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}
