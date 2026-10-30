// Canonical job keys. Must stay in sync with job_key() in scripts/migrate_ledger.py.

export type Platform =
  | "greenhouse" | "lever" | "ashby" | "workday" | "icims" | "smartrecruiters" | "oracle" | "taleo"
  | "ukg" | "successfactors" | "dayforce" | "paycom" | "adp" | "linkedin" | "other";

const ID_PARAMS = ["gh_jid", "jobid", "job_id", "opportunityid", "id", "req", "requisitionid"];

export function platformOf(url: string): Platform {
  const h = safeUrl(url)?.hostname.toLowerCase() ?? "";
  const q = safeUrl(url)?.search.toLowerCase() ?? "";
  if (h.includes("greenhouse.io") || q.includes("gh_jid=")) return "greenhouse";
  if (h.endsWith("lever.co")) return "lever";
  if (h.endsWith("ashbyhq.com")) return "ashby";
  if (h.includes("myworkdayjobs.com") || h.includes("myworkdaysite.com") || h.includes("workday.com")) return "workday";
  if (h.includes("icims.com")) return "icims";
  if (h.includes("smartrecruiters.com")) return "smartrecruiters";
  if (h.includes("oraclecloud.com")) return "oracle";
  if (h.includes("taleo.net")) return "taleo";
  if (h.includes("ultipro.com") || h.includes("ukg.net")) return "ukg";
  if (h.includes("successfactors")) return "successfactors";
  if (h.includes("dayforcehcm.com")) return "dayforce";
  if (h.includes("paycomonline")) return "paycom";
  if (h.includes("adp.com")) return "adp";
  if (h.includes("linkedin.com")) return "linkedin";
  return "other";
}

export function jobKey(url: string): string {
  const u = safeUrl(url);
  if (!u) return url.trim().toLowerCase();
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const params = new URLSearchParams(u.search);
  const lower = (s: string) => s.toLowerCase();

  if (host.endsWith("greenhouse.io")) {
    const i = parts.indexOf("jobs");
    if (i > 0 && parts[i + 1]) return lower(`greenhouse:${parts[i - 1]}:${parts[i + 1]}`);
    const board = params.get("for");
    const id = params.get("token") ?? params.get("gh_jid");
    if (board && id) return lower(`greenhouse:${board}:${id}`);
  }
  const ghJid = params.get("gh_jid");
  if (ghJid) {
    const board = params.get("for") ?? host.split(".").slice(-2, -1)[0];
    return lower(`greenhouse:${board}:${ghJid}`);
  }
  if (host.endsWith("lever.co") && parts.length >= 2) return lower(`lever:${parts[0]}:${parts[1]}`);
  if (host.endsWith("ashbyhq.com") && parts.length >= 2) return lower(`ashby:${parts[0]}:${parts[1]}`);
  if (host.includes("myworkdayjobs.com") || host.includes("myworkdaysite.com")) {
    let tenant = host.split(".")[0];
    if (host.includes("myworkdaysite.com")) {
      const r = parts.indexOf("recruiting");
      if (r >= 0 && parts[r + 1]) tenant = parts[r + 1];
    }
    const jobPart = [...parts].reverse().find((p) => /_[A-Za-z0-9-]+$/.test(p) && !/^apply/i.test(p));
    const req = jobPart?.match(/_([A-Za-z0-9-]+)$/)?.[1];
    if (req) return lower(`workday:${tenant}:${req.replace(/-\d$/, "")}`);
  }
  let key = `${host}:${u.pathname.toLowerCase().replace(/\/+$/, "")}`;
  for (const [k, v] of params) {
    if (ID_PARAMS.includes(k.toLowerCase())) { key += `?${k}=${v}`; break; }
  }
  return lower(key);
}

export function safeUrl(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}
