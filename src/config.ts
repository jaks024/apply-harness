import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  concurrency: number;
  chrome: { profileDir: string; channel: string };
  llm: {
    provider: "claude-cli" | "gemini"; agentMaxSteps: number;
    /** Resolved from the provider's own section (or FIELD_MODEL / AGENT_MODEL). */
    fieldModel: string; agentModel: string;
    "claude-cli": { bin: string; fieldModel: string; agentModel: string; maxParallel: number; timeoutMs: number };
    gemini: { project: string; location: string; fieldModel: string; agentModel: string };
  };
  paths: Record<"answers" | "facts" | "resume" | "transcript" | "accounts" | "ledger" | "tracker" | "fieldMemory" | "queue" | "runs", string>;
  fill: { maxPages: number; passesPerPage: number; stuckRetries: number; watchMinutes: number };
}

// Secrets (GEMINI_API_KEY and the like) live in .env, which git ignores. Real environment variables win.
const envFile = resolve(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const raw = JSON.parse(readFileSync(resolve(ROOT, "config/config.json"), "utf8")) as Config;
for (const k of Object.keys(raw.paths) as (keyof Config["paths"])[]) {
  if (!isAbsolute(raw.paths[k])) raw.paths[k] = resolve(ROOT, raw.paths[k]);
}
// Every module reads the candidate's files at startup; say how to create them instead of failing on a missing path.
for (const k of ["answers", "facts"] as const) {
  if (!existsSync(raw.paths[k])) throw new Error(`${raw.paths[k]} is missing. Run the setup first: open this folder in Claude Code and type /setup, or follow SETUP.md.`);
}
raw.llm.provider = (process.env.LLM_PROVIDER as Config["llm"]["provider"] | undefined) ?? raw.llm.provider;
if (raw.llm.provider !== "claude-cli" && raw.llm.provider !== "gemini") throw new Error(`config llm.provider must be "claude-cli" or "gemini", not "${raw.llm.provider}"`);
const models = raw.llm[raw.llm.provider];
raw.llm.fieldModel = process.env.FIELD_MODEL ?? models.fieldModel;
raw.llm.agentModel = process.env.AGENT_MODEL ?? models.agentModel;
raw.chrome.profileDir = process.env.CHROME_PROFILE ?? raw.chrome.profileDir;
if (!isAbsolute(raw.chrome.profileDir)) raw.chrome.profileDir = resolve(ROOT, raw.chrome.profileDir);

export const config: Config = raw;
