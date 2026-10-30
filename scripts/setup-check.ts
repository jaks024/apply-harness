// Setup helper. `npm run setup` creates data/ from examples/ (never overwriting your files) and checks what's still
// missing; `npm run setup:check` only checks. Doesn't import src/config.ts, which refuses to load without data/.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const at = (p: string) => resolve(ROOT, p);
const init = process.argv.includes("--init");
const cfg = JSON.parse(readFileSync(at("config/config.json"), "utf8"));
const paths = cfg.paths as Record<string, string>;
let problems = 0;
const ok = (s: string) => console.log(`  ok    ${s}`);
const todo = (s: string) => { problems++; console.log(`  TODO  ${s}`); };
const note = (s: string) => console.log(`  note  ${s}`);

if (init) {
  console.log("Creating data/ from examples/ (existing files are kept):");
  mkdirSync(at("data/resume"), { recursive: true });
  const copies: [string, string][] = [["examples/answers.example.json", paths.answers], ["examples/facts.example.md", paths.facts]];
  for (const [from, to] of copies) {
    if (existsSync(at(to))) note(`${to} already exists; left as is`);
    else { copyFileSync(at(from), at(to)); ok(`${to} (from ${from}; replace the example values with yours)`); }
  }
  if (!existsSync(at(paths.tracker))) { writeFileSync(at(paths.tracker), "[]\n"); ok(`${paths.tracker} (empty job tracker)`); }
  if (!existsSync(at(".env")) && existsSync(at(".env.example"))) { copyFileSync(at(".env.example"), at(".env")); ok(".env (from .env.example)"); }
  console.log("");
}

console.log("Checking setup:");
const [major] = process.versions.node.split(".").map(Number);
major >= 22 ? ok(`Node ${process.versions.node}`) : todo(`Node ${process.versions.node}: install Node 22 or newer`);
existsSync(at("node_modules/patchright")) ? ok("dependencies installed") : todo("run npm install");

if (!existsSync(at(paths.answers))) todo(`${paths.answers} is missing: run npm run setup (or /setup in Claude Code)`);
else {
  const raw = readFileSync(at(paths.answers), "utf8");
  try {
    const a = JSON.parse(raw);
    ok(`${paths.answers} parses`);
    if (/jordan\.rivera@example\.com|example-jordan-rivera|"Jordan"|123 Example Street/.test(raw)) todo(`${paths.answers} still has the example candidate's details: replace them with yours`);
    if (/CHANGE-ME/.test(raw) || !a.accounts?.password) todo(`${paths.answers}: set accounts.password (used to create job-site accounts)`);
    for (const r of a.rules ?? []) { try { new RegExp(r.pattern, "i"); } catch { todo(`rule pattern doesn't compile: ${r.pattern}`); } }
    const confirm = (a.rules ?? []).filter((r: { note?: string }) => /CONFIRM during setup/.test(r.note ?? "")).length;
    if (confirm) note(`${confirm} standing answers are marked "CONFIRM during setup" (criminal history, relatives, drug screen…): check each is true for you, then remove the note`);
  } catch (e) { todo(`${paths.answers} isn't valid JSON: ${(e as Error).message}`); }
}
if (!existsSync(at(paths.facts))) todo(`${paths.facts} is missing`);
else if (/FICTIONAL example/.test(readFileSync(at(paths.facts), "utf8"))) todo(`${paths.facts} is still the example: paste your resume text and background`);
else ok(paths.facts);
existsSync(at(paths.resume)) ? ok(`resume at ${paths.resume}`) : todo(`put your resume PDF at ${paths.resume} (or change paths.resume in config/config.json)`);
existsSync(at(paths.transcript)) ? ok(`transcript at ${paths.transcript}`) : note(`no transcript at ${paths.transcript} (only needed when a form requires one)`);
existsSync(at(paths.tracker)) ? ok(`job tracker at ${paths.tracker}`) : todo(`${paths.tracker} is missing: run npm run setup`);

const env: Record<string, string> = {};
if (existsSync(at(".env"))) for (const l of readFileSync(at(".env"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) env[m[1]] = m[2]; }
const get = (k: string) => process.env[k] ?? env[k];
const provider = get("LLM_PROVIDER") ?? cfg.llm.provider;
if (provider === "claude-cli") {
  const bin = get("CLAUDE_BIN") ?? cfg.llm["claude-cli"].bin;
  try {
    const v = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000 }).trim();
    ok(`model provider: Claude Code CLI (${v}); models ${cfg.llm["claude-cli"].fieldModel} / ${cfg.llm["claude-cli"].agentModel}`);
    note("run npm run test:llm once to confirm you're logged in (run `claude` and /login if it says you aren't)");
  } catch { todo(`model provider is claude-cli, but "${bin}" didn't run: install Claude Code (https://claude.com/claude-code) or set CLAUDE_BIN in .env`); }
} else if (provider === "gemini") {
  if (get("GEMINI_API_KEY")) ok("model provider: Gemini (API key)");
  else if (get("GOOGLE_CLOUD_PROJECT") || cfg.llm.gemini.project) ok(`model provider: Gemini on Vertex AI (project ${get("GOOGLE_CLOUD_PROJECT") ?? cfg.llm.gemini.project}); needs gcloud auth application-default login`);
  else todo("model provider is gemini: set GEMINI_API_KEY or GOOGLE_CLOUD_PROJECT in .env");
} else todo(`llm.provider "${provider}" isn't supported: use claude-cli or gemini`);

console.log(problems ? `\n${problems} thing(s) left to do.` : "\nSetup looks complete. Next: npm run test:llm, then npm run ui.");
process.exit(problems ? 1 : 0);
