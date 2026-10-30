// Full engine run on a live posting in a throwaway Chrome profile. Stops at the review/Submit stop; never submits.
import { chromium } from "patchright";
import { mkdirSync, writeFileSync } from "node:fs";
import { rescue } from "../src/agent.js";
import { config } from "../src/config.js";
import { runJob } from "../src/engine.js";
import { jobKey, platformOf } from "../src/jobkey.js";
import { scan } from "../src/scan.js";
import type { JobCtx } from "../src/adapters/types.js";
import { accounts } from "../src/resolve.js";
const url = process.argv[2];
// HX_EMAIL: try the run under another email. Its account records go to a debug file, never the real data/accounts.json.
if (process.env.HX_EMAIL) {
  accounts.primary_email = accounts.fallback_email = process.env.HX_EMAIL;
  config.paths.accounts = "data/debug/accounts.json";
}
const runDir = "data/debug/run"; mkdirSync(runDir, { recursive: true });
const b = await chromium.launchPersistentContext("data/debug/profile", { channel: "chrome", headless: false, viewport: null });
const page = b.pages()[0] ?? await b.newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });
const t0 = Date.now();
let current = page; // follows new tabs like the dashboard does (ctx.replacePage)
const ctx: JobCtx = {
  url, key: jobKey(url), platform: platformOf(url), company: process.argv[3], role: process.argv[4],
  files: { resume: config.paths.resume, transcript: config.paths.transcript }, runDir, decisions: [], resumeUploaded: false,
  log: (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${s}`),
  waitForUser: async (r) => { console.log("WAIT FOR USER:", r); return false; },
  replacePage: (p) => { current = p; },
  rescue: async (g) => (await rescue(current, g, ctx.files, (s) => console.log("   " + s), { stopOnAdvance: true })).state,
  setStatus: (s, n) => console.log(`STATUS ${s}: ${n}`),
};
ctx.postingText = (await scan(page)).text.slice(0, 8000);
const out = await runJob(page, ctx);
const final = await scan(out.page);
const empty = final.fields.filter((f) => !f.filled).map((f) => `${f.required ? "REQ " : ""}${f.kind} "${f.label.slice(0, 60)}"`);
console.log(`\nOUTCOME ${out.state} in ${((Date.now() - t0) / 1000).toFixed(0)}s${"reason" in out ? " — " + out.reason : ""}`);
console.log("flags:", ctx.decisions.filter((d) => d.action === "flag").map((d) => `${d.label.slice(0, 50)}: ${d.reason}`));
console.log("still empty:", empty);
for (const f of final.fields.filter((f) => /authori|sponsor|country|ethnic|hispanic|race|veteran|orientation|gender|transgender|disab|location|city|school|degree|discipline|start date|end date|certify|describe|why|name|company|employer|degree|intend|pursuing|full-time|relocate|korea/i.test(f.label))) console.log(`  ${f.label.slice(0, 70).padEnd(70)} = ${(f.value || "(empty)").slice(0, 400)}`);
writeFileSync(`${runDir}/fields.json`, JSON.stringify(ctx.decisions, null, 2));
await out.page.screenshot({ path: `${runDir}/review.png`, fullPage: true });
await b.close();
