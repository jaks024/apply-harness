// End-to-end engine test on a local two-page form: scanner, rules, the model, combobox, dependent field,
// yes/no buttons, agreements, resume upload, and the stop before Submit. No external sites.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { launchBrowser } from "../src/browser.js";
import { config, ROOT } from "../src/config.js";
import { runJob } from "../src/engine.js";
import { bestOption } from "../src/match.js";
import { answers } from "../src/resolve.js";
import type { JobCtx } from "../src/adapters/types.js";

const url = pathToFileURL(join(ROOT, "scripts/fixtures/form.html")).href;
const runDir = join(config.paths.runs, "test-engine");
mkdirSync(runDir, { recursive: true });
const ctxB = await launchBrowser("data/debug/test-profile");
const page = await ctxB.newPage();
page.on("dialog", (d) => { console.log("page alert:", d.message()); d.dismiss(); });
await page.goto(url);
const ctx: JobCtx = {
  url, key: "test:form", platform: "other", company: "Acme Analytics", role: "Data Analyst",
  files: { resume: config.paths.resume, transcript: config.paths.transcript }, runDir,
  log: (s) => console.log("  " + s), decisions: [], resumeUploaded: false,
  waitForUser: async (r) => { console.log("  waitForUser:", r); return false; },
  rescue: async (g) => { console.log("  rescue requested:", g.slice(0, 80)); return "gave_up"; },
};
const out = await runJob(page, ctx);
const state = await page.evaluate(() => ({
  submitted: (window as unknown as { __submitted?: boolean }).__submitted === true,
  auth: (document.querySelector("input[name=auth]:checked") as HTMLInputElement | null)?.value,
  spon: (document.querySelector("input[name=spon]:checked") as HTMLInputElement | null)?.value,
  visa: (document.querySelector("#visa") as HTMLSelectElement).value,
  prevWorked: document.querySelector(".opt.active")?.textContent,
  gender: (document.querySelector("#gender") as HTMLSelectElement).value,
  crim: (document.querySelector("#crim") as HTMLSelectElement).value,
  tos: (document.querySelector("#tos") as HTMLInputElement).checked,
  sms: (document.querySelector("#sms") as HTMLInputElement).checked,
  why: (document.querySelector("#why") as HTMLTextAreaElement).value.slice(0, 80),
}));
console.log("\noutcome:", out.state, "\npage state:", state);
console.log("flags:", ctx.decisions.filter((d) => d.action === "flag").map((d) => `${d.label} — ${d.reason}`));
// Expected answers come from your answer bank.
const auth = (answers.work_authorization ?? {}) as Record<string, string>;
const yesNo = (v?: string) => (/^yes/i.test(v ?? "") ? "y" : "n");
const wantGender = bestOption(String((answers.eeo as Record<string, string> | undefined)?.gender ?? ""), ["Male", "Female", "Decline To Self Identify"]);
const checks: [string, boolean][] = [
  ["stopped at review", out.state === "at_review"],
  ["did NOT click submit", !state.submitted],
  [`authorized = ${auth.authorized_us}`, state.auth === yesNo(auth.authorized_us)],
  [`sponsorship = ${auth.requires_sponsorship}`, state.spon === yesNo(auth.requires_sponsorship)],
  ...(yesNo(auth.requires_sponsorship) === "y" ? [["dependent visa field answered", !!state.visa] as [string, boolean]] : []),
  ["previously worked = No", state.prevWorked === "No"],
  ...(wantGender ? [[`gender = ${wantGender}`, state.gender === wantGender] as [string, boolean]] : []),
  ["felony = No", state.crim === "No"],
  ["terms ticked", state.tos],
  ["marketing SMS left unticked", !state.sms],
  ["resume uploaded", ctx.resumeUploaded],
];
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
await ctxB.close();
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
