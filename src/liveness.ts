// Is a posting still open? Uses each ATS's public job API where one exists; only definitive answers count.
// "closed" = the ATS says the job is gone (404/410, or missing from the board's job list, or an explicit
// "no longer available" page). Anything ambiguous (blocked, SPA shells, LinkedIn) is "unknown".
import { jobKey, platformOf, safeUrl } from "./jobkey.js";

export type Liveness = { state: "open" | "closed" | "unknown"; evidence: string };

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Safari/537.36";
export const CLOSED_TEXT = /(no longer (available|accepting|open|active)|position has been filled|job (posting )?(is )?(closed|expired|not found)|this job (has|was) (expired|closed|been removed)|requisition (is )?(closed|no longer)|page (you|you're) looking for (can.t|cannot|could not) be found|the job you are looking for)/i;

async function get(url: string, accept = "application/json"): Promise<{ status: number; text: string; finalUrl: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, redirect: "follow", signal: ctl.signal });
    return { status: r.status, text: await r.text().catch(() => ""), finalUrl: r.url };
  } finally { clearTimeout(t); }
}

const ashbyBoards = new Map<string, Promise<Set<string> | null>>();
function ashbyBoard(org: string): Promise<Set<string> | null> {
  if (!ashbyBoards.has(org)) {
    ashbyBoards.set(org, get(`https://api.ashbyhq.com/posting-api/job-board/${org}`).then((r) => {
      if (r.status !== 200) return null;
      const d = JSON.parse(r.text);
      return new Set<string>((d.jobs ?? []).map((j: { id: string }) => j.id.toLowerCase()));
    }).catch(() => null));
  }
  return ashbyBoards.get(org)!;
}

// LinkedIn's public (signed-out) job endpoint. One request at a time with a pause; on 429 back off and retry.
let liQueue: Promise<unknown> = Promise.resolve();
function linkedinGuest(id: string): Promise<Liveness> {
  const run = async (): Promise<Liveness> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise((r) => setTimeout(r, attempt ? 30_000 * attempt : 2_500));
      const r = await get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, "text/html");
      if (r.status === 429) continue;
      if (r.status === 404) return { state: "closed", evidence: "LinkedIn: posting not found" };
      if (r.status !== 200) return { state: "unknown", evidence: `LinkedIn ${r.status}` };
      if (/No longer accepting applications/i.test(r.text)) return { state: "closed", evidence: "LinkedIn: No longer accepting applications" };
      return { state: "open", evidence: "LinkedIn: accepting applications" };
    }
    return { state: "unknown", evidence: "LinkedIn kept rate-limiting" };
  };
  const p = liQueue.then(run, run);
  liQueue = p.catch(() => undefined);
  return p;
}

export async function checkPosting(posting: string): Promise<Liveness> {
  const u = safeUrl(posting);
  if (!u) return { state: "unknown", evidence: "no posting URL" };
  const key = jobKey(posting);
  const platform = platformOf(posting);
  try {
    if (key.startsWith("greenhouse:")) {
      const [, board, id] = key.split(":");
      const r = await get(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`);
      if (r.status === 200) return { state: "open", evidence: "Greenhouse API 200" };
      if (r.status === 404) return { state: "closed", evidence: "Greenhouse API 404 (job removed)" };
      return { state: "unknown", evidence: `Greenhouse API ${r.status}` };
    }
    if (key.startsWith("lever:")) {
      const [, co, id] = key.split(":");
      const r = await get(`https://api.lever.co/v0/postings/${co}/${id}`);
      if (r.status === 200) return { state: "open", evidence: "Lever API 200" };
      if (r.status === 404) return { state: "closed", evidence: "Lever API 404 (posting removed)" };
      return { state: "unknown", evidence: `Lever API ${r.status}` };
    }
    if (key.startsWith("ashby:")) {
      const [, org, id] = key.split(":");
      const ids = await ashbyBoard(org);
      if (!ids) return { state: "unknown", evidence: "Ashby board not readable" };
      return ids.has(id) ? { state: "open", evidence: "listed on Ashby board" } : { state: "closed", evidence: "not listed on the Ashby job board" };
    }
    if (platform === "workday" && /myworkdayjobs\.com$/.test(u.hostname)) {
      // https://<tenant>.wdN.myworkdayjobs.com/<locale?>/<site>/job/<path>  →  /wday/cxs/<tenant>/<site>/job/<path>
      const parts = u.pathname.split("/").filter(Boolean);
      const jobAt = parts.indexOf("job");
      const site = parts.slice(0, jobAt).filter((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p)).pop();
      if (jobAt > 0 && site) {
        const tenant = u.hostname.split(".")[0];
        const path = parts.slice(jobAt + 1).join("/").replace(/\/apply.*$/, "");
        const r = await get(`https://${u.hostname}/wday/cxs/${tenant}/${site}/job/${path}`);
        if (r.status === 200 && /jobPostingInfo/.test(r.text)) return { state: "open", evidence: "Workday API 200" };
        if (r.status === 404 || r.status === 410) return { state: "closed", evidence: `Workday API ${r.status} (job removed)` };
        return { state: "unknown", evidence: `Workday API ${r.status}` };
      }
    }
    if (platform === "smartrecruiters") {
      const m = u.pathname.match(/^\/([^/]+)\/(\d+)/);
      if (m) {
        const r = await get(`https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`);
        if (r.status === 200) return { state: "open", evidence: "SmartRecruiters API 200" };
        if (r.status === 404) return { state: "closed", evidence: "SmartRecruiters API 404" };
        return { state: "unknown", evidence: `SmartRecruiters API ${r.status}` };
      }
    }
    if (platform === "linkedin") {
      const id = u.pathname.match(/\/view\/(?:[^/]*?-)?(\d{6,})/)?.[1] ?? u.searchParams.get("currentJobId");
      if (!id) return { state: "unknown", evidence: "LinkedIn URL without a job id" };
      return linkedinGuest(id);
    }
    if (/indeed\.com|builtin|themuse\.com/.test(u.hostname)) {
      return { state: "unknown", evidence: `${u.hostname} needs a signed-in check` };
    }
    // Employer sites and other ATSs: only explicit signals count.
    const r = await get(posting, "text/html");
    if (r.status === 404 || r.status === 410) return { state: "closed", evidence: `HTTP ${r.status}` };
    const visible = r.text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
    if (r.status === 200 && CLOSED_TEXT.test(visible)) return { state: "closed", evidence: `page says "${visible.match(CLOSED_TEXT)![0]}"` };
    return { state: "unknown", evidence: `HTTP ${r.status}, no closed notice (may be a script-rendered page)` };
  } catch (e) {
    return { state: "unknown", evidence: `check failed: ${String((e as Error).message ?? e).slice(0, 80)}` };
  }
}

/** Second opinion for script-rendered pages: load in a real (headless) browser and read the rendered text. */
export async function renderCheck(page: import("patchright").Page, posting: string, role: string): Promise<Liveness> {
  try {
    const resp = await page.goto(posting, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(4_000);
    if (resp && (resp.status() === 404 || resp.status() === 410)) return { state: "closed", evidence: `rendered: HTTP ${resp.status()}` };
    const text = (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).replace(/\s+/g, " ");
    const hit = text.match(CLOSED_TEXT);
    if (hit) return { state: "closed", evidence: `rendered page says "${hit[0]}"` };
    const words = role.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3).slice(0, 3);
    const mentionsRole = words.length > 0 && words.every((w) => text.toLowerCase().includes(w));
    if (mentionsRole && /\bapply\b/i.test(text)) return { state: "open", evidence: "rendered page shows the role and an Apply option" };
    return { state: "unknown", evidence: "rendered page is ambiguous" };
  } catch (e) {
    return { state: "unknown", evidence: `render failed: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 80)}` };
  }
}

const ashbyPosted = new Map<string, Promise<Map<string, string> | null>>();
/** When the employer published the posting (YYYY-MM-DD), from the ATS's public API; null where none exists. */
export async function postedDate(posting: string): Promise<string | null> {
  const u = safeUrl(posting);
  if (!u) return null;
  const key = jobKey(posting);
  const day = (s: string | number | undefined | null) => (s ? new Date(s).toISOString().slice(0, 10) : null);
  try {
    if (key.startsWith("greenhouse:")) {
      const [, board, id] = key.split(":");
      const r = await get(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`);
      if (r.status !== 200) return null;
      const d = JSON.parse(r.text);
      return day(d.first_published ?? d.updated_at);
    }
    if (key.startsWith("lever:")) {
      const [, co, id] = key.split(":");
      const r = await get(`https://api.lever.co/v0/postings/${co}/${id}`);
      return r.status === 200 ? day(JSON.parse(r.text).createdAt) : null;
    }
    if (key.startsWith("ashby:")) {
      const [, org, id] = key.split(":");
      if (!ashbyPosted.has(org)) {
        ashbyPosted.set(org, get(`https://api.ashbyhq.com/posting-api/job-board/${org}`).then((r) => r.status === 200
          ? new Map<string, string>((JSON.parse(r.text).jobs ?? []).map((j: { id: string; publishedAt?: string }) => [j.id.toLowerCase(), j.publishedAt ?? ""]))
          : null).catch(() => null));
      }
      return day((await ashbyPosted.get(org))?.get(id) || null);
    }
    if (platformOf(posting) === "workday" && /myworkdayjobs\.com$/.test(u.hostname)) {
      const parts = u.pathname.split("/").filter(Boolean);
      const jobAt = parts.indexOf("job");
      const site = parts.slice(0, jobAt).filter((p) => !/^[a-z]{2}-[A-Z]{2}$/.test(p)).pop();
      if (jobAt > 0 && site) {
        const r = await get(`https://${u.hostname}/wday/cxs/${u.hostname.split(".")[0]}/${site}/job/${parts.slice(jobAt + 1).join("/").replace(/\/apply.*$/, "")}`);
        if (r.status === 200) return day(JSON.parse(r.text).jobPostingInfo?.startDate);
      }
      return null;
    }
    if (platformOf(posting) === "smartrecruiters") {
      const m = u.pathname.match(/^\/([^/]+)\/(\d+)/);
      if (!m) return null;
      const r = await get(`https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`);
      return r.status === 200 ? day(JSON.parse(r.text).releasedDate) : null;
    }
  } catch { /* unknown */ }
  return null;
}

/** Posting description text from the ATS API (Greenhouse, Lever, Ashby), for no-sponsorship checks before opening. */
export async function postingDescription(posting: string): Promise<string | null> {
  const key = jobKey(posting);
  const strip = (h: string) => h.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ");
  try {
    if (key.startsWith("greenhouse:")) {
      const [, board, id] = key.split(":");
      const r = await get(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}?questions=true`);
      if (r.status !== 200) return null;
      const d = JSON.parse(r.text);
      return strip(`${d.content ?? ""} ${(d.questions ?? []).map((q: { label: string }) => q.label).join(" . ")}`);
    }
    if (key.startsWith("lever:")) {
      const [, co, id] = key.split(":");
      const r = await get(`https://api.lever.co/v0/postings/${co}/${id}`);
      if (r.status !== 200) return null;
      const d = JSON.parse(r.text);
      return strip(`${d.descriptionPlain ?? ""} ${(d.lists ?? []).map((l: { content: string }) => l.content).join(" ")} ${d.additionalPlain ?? ""}`);
    }
    if (key.startsWith("ashby:")) {
      const [, org, id] = key.split(":");
      const r = await get(`https://api.ashbyhq.com/posting-api/job-board/${org}`);
      if (r.status !== 200) return null;
      const j = (JSON.parse(r.text).jobs ?? []).find((x: { id: string }) => x.id.toLowerCase() === id);
      return j ? strip(j.descriptionPlain ?? j.descriptionHtml ?? "") : null;
    }
  } catch { /* unknown */ }
  return null;
}
