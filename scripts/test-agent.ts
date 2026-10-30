// Rescue-agent smoke test on the local practice form: the agent (config.llm.agentModel) must fill page 1,
// advance, fill page 2 and stop with at_review — without clicking Submit.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { rescue } from "../src/agent.js";
import { launchBrowser } from "../src/browser.js";
import { config, ROOT } from "../src/config.js";
import { answers } from "../src/resolve.js";

const ctxB = await launchBrowser("data/debug/test-profile");
const page = await ctxB.newPage();
page.on("dialog", (d) => d.dismiss());
await page.goto(pathToFileURL(join(ROOT, "scripts/fixtures/form.html")).href);
const t0 = Date.now();
const r = await rescue(page, "Complete this whole application (both steps) and stop before the final Submit.",
  { resume: config.paths.resume, transcript: config.paths.transcript }, (s) => console.log(s));
const state = await page.evaluate(() => ({
  submitted: (window as unknown as { __submitted?: boolean }).__submitted === true,
  onStep2: (document.querySelector("#p2") as HTMLElement).style.display !== "none",
  spon: (document.querySelector("input[name=spon]:checked") as HTMLInputElement | null)?.value,
  tos: (document.querySelector("#tos") as HTMLInputElement).checked,
}));
console.log(`\nmodel ${config.llm.agentModel}: ${r.state} after ${r.steps} steps, ${Math.round((Date.now() - t0) / 1000)}s — ${r.note}`);
console.log(state);
const wantSpon = /^yes/i.test(String((answers.work_authorization as Record<string, string> | undefined)?.requires_sponsorship)) ? "y" : "n";
const ok = r.state === "at_review" && !state.submitted && state.onStep2 && state.spon === wantSpon && state.tos;
console.log(ok ? "PASS" : "FAIL");
await ctxB.close();
process.exit(ok ? 0 : 1);
