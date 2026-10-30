// One interface over the model providers. config.llm.provider picks one:
//   "claude-cli": the Claude Code CLI in print mode (`claude -p`), on your Claude subscription or ANTHROPIC_API_KEY.
//   "gemini":     Google Gemini, on Vertex AI (gcloud application-default credentials) or a GEMINI_API_KEY.
// Two tiers: "field" answers form fields in batches (fast model); "agent" writes long answers and drives the rescue agent.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";

export type Tier = "field" | "agent";
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id?: string; name: string; args: Record<string, unknown> }
export type AgentTurn =
  | { role: "user"; text: string }
  | { role: "model"; calls: ToolCall[]; text?: string; raw?: unknown }
  | { role: "tools"; results: { call: ToolCall; result: Record<string, unknown> }[] };

type StepOut = { calls: ToolCall[]; text?: string; raw?: unknown };
export const modelFor = (tier: Tier) => (tier === "agent" ? config.llm.agentModel : config.llm.fieldModel);
const verbose = (s: string) => { if (process.env.VERBOSE) console.log(`  ${s}`); };

async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let delay = 1500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      const retryable = /429|RESOURCE_EXHAUSTED|rate.?limit|overloaded|500|502|503|504|529|UNAVAILABLE|deadline|ECONNRESET|fetch failed|ENOTFOUND|EAI_AGAIN|timed? ?out|abort/i.test(msg);
      if (!retryable || attempt >= 4) throw e;
      verbose(`${what}: ${msg.slice(0, 80)}; retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

/** One structured-output call. Returns parsed JSON matching the schema. */
export function json<T>(tier: Tier, system: string, prompt: string, schema: object): Promise<T> {
  return withRetry(`${config.llm.provider} ${modelFor(tier)}`, () => (config.llm.provider === "gemini" ? gemini.json<T>(tier, system, prompt, schema) : claude.json<T>(tier, system, prompt, schema)));
}

/** One plain-text call. */
export function text(tier: Tier, system: string, prompt: string): Promise<string> {
  return withRetry(`${config.llm.provider} ${modelFor(tier)}`, () => (config.llm.provider === "gemini" ? gemini.text(tier, system, prompt) : claude.text(tier, system, prompt)));
}

/** One step of a tool-using agent: the model reads the conversation so far and returns the tool calls it wants. */
export function agentStep(tier: Tier, system: string, turns: AgentTurn[], tools: ToolDef[]): Promise<StepOut> {
  return withRetry<StepOut>(`${config.llm.provider} ${modelFor(tier)}`, () => (config.llm.provider === "gemini" ? gemini.agentStep(tier, system, turns, tools) : claude.agentStep(tier, system, turns, tools)));
}

// ---------- Gemini (@google/genai) ----------
const gemini = (() => {
  type GenAI = import("@google/genai").GoogleGenAI;
  type Content = import("@google/genai").Content;
  let client: Promise<GenAI> | null = null;
  const get = () => (client ??= import("@google/genai").then(({ GoogleGenAI }) => {
    // A hung request should fail and retry, not stall a job for minutes.
    const httpOptions = { timeout: 90_000 };
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) return new GoogleGenAI({ apiKey, httpOptions });
    const project = process.env.GOOGLE_CLOUD_PROJECT ?? config.llm.gemini.project;
    if (!project) throw new Error("Gemini needs GEMINI_API_KEY or a Vertex project (GOOGLE_CLOUD_PROJECT in .env)");
    return new GoogleGenAI({ vertexai: true, project, location: process.env.GOOGLE_CLOUD_LOCATION ?? config.llm.gemini.location, httpOptions });
  }));
  const call = async (tier: Tier, contents: Content[] | string, cfg: import("@google/genai").GenerateContentConfig) =>
    (await get()).models.generateContent({ model: modelFor(tier), contents, config: cfg });
  return {
    async json<T>(tier: Tier, system: string, prompt: string, schema: object): Promise<T> {
      const r = await call(tier, prompt, { systemInstruction: system, responseMimeType: "application/json", responseJsonSchema: schema });
      return JSON.parse(r.text ?? "") as T;
    },
    async text(tier: Tier, system: string, prompt: string): Promise<string> {
      return (await call(tier, prompt, { systemInstruction: system })).text ?? "";
    },
    async agentStep(tier: Tier, system: string, turns: AgentTurn[], tools: ToolDef[]) {
      const contents: Content[] = turns.map((t) =>
        t.role === "user" ? { role: "user", parts: [{ text: t.text }] }
        // The model's own content goes back untouched: it carries the thought signatures Gemini checks.
        : t.role === "model" ? (t.raw as Content) ?? { role: "model", parts: t.calls.map((c) => ({ functionCall: { id: c.id, name: c.name, args: c.args } })) }
        : { role: "user", parts: t.results.map(({ call: c, result }) => ({ functionResponse: { id: c.id, name: c.name, response: result } })) });
      const r = await call(tier, contents, { systemInstruction: system, tools: [{ functionDeclarations: tools.map((d) => ({ name: d.name, description: d.description, parametersJsonSchema: d.parameters })) }] });
      const raw = r.candidates?.[0]?.content;
      if (!raw) throw new Error("empty model response");
      return { raw, text: raw.parts?.map((p) => p.text ?? "").join("") || undefined, calls: (r.functionCalls ?? []).map((c) => ({ id: c.id, name: c.name ?? "", args: (c.args ?? {}) as Record<string, unknown> })) };
    },
  };
})();

// ---------- Claude Code CLI (`claude -p`) ----------
const claude = (() => {
  // Started from inside a Claude Code session, the child would inherit that session's private settings and fail to
  // authenticate; it should run as a plain CLI call with the user's own login.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/.test(k)));
  let running = 0;
  const queue: (() => void)[] = [];
  const slot = async () => { while (running >= config.llm["claude-cli"].maxParallel) await new Promise<void>((r) => queue.push(r)); running++; };
  const release = () => { running--; queue.shift()?.(); };

  async function run(tier: Tier, system: string, prompt: string, schema?: object): Promise<{ result: string; structured?: unknown }> {
    await slot();
    const dir = mkdtempSync(join(tmpdir(), "apply-harness-"));
    try {
      // The system prompt (instructions + the candidate's facts) is too long for a Windows command line: a file.
      writeFileSync(join(dir, "system.md"), system);
      const args = ["-p", "--output-format", "json", "--model", modelFor(tier), "--system-prompt-file", join(dir, "system.md"), "--tools", "", "--no-session-persistence"];
      if (schema) args.push("--json-schema", JSON.stringify(schema));
      const out = await new Promise<string>((resolve, reject) => {
        // A .js/.mjs CLAUDE_BIN (an npm install's cli.js) runs under this Node: Windows can't spawn npm's .cmd shim directly.
        const bin = process.env.CLAUDE_BIN ?? config.llm["claude-cli"].bin;
        const [cmd, argv] = /\.m?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
        const p = spawn(cmd, argv, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        let so = "", se = "";
        const timer = setTimeout(() => { p.kill(); reject(new Error("claude CLI timed out")); }, config.llm["claude-cli"].timeoutMs);
        p.stdout.on("data", (d) => (so += d));
        p.stderr.on("data", (d) => (se += d));
        p.on("error", (e) => { clearTimeout(timer); reject(new Error(`could not start the claude CLI (${e.message}); install Claude Code or set CLAUDE_BIN`)); });
        p.on("close", (code) => { clearTimeout(timer); code === 0 || so.trim() ? resolve(so) : reject(new Error(`claude CLI exited ${code}: ${se.slice(0, 300)}`)); });
        p.stdin.end(prompt);
      });
      const r = JSON.parse(out) as { is_error?: boolean; result?: string; structured_output?: unknown };
      if (r.is_error) throw new Error(`claude CLI: ${String(r.result ?? "error").slice(0, 300)}`);
      return { result: r.result ?? "", structured: r.structured_output };
    } finally {
      release();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The structured output, or the first JSON object in the text when the CLI returns it there. */
  function parsed<T>(r: { result: string; structured?: unknown }): T {
    if (r.structured && typeof r.structured === "object") return r.structured as T;
    const t = r.result.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    try { return JSON.parse(t) as T; } catch { /* fall through */ }
    const m = t.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error(`claude CLI returned no JSON: ${t.slice(0, 200)}`);
  }

  // The CLI runs one turn without our tools, so the agent's tool calls travel as JSON: the transcript goes in, the
  // next calls come out.
  const STEP_SCHEMA = {
    type: "object",
    properties: {
      calls: { type: "array", items: { type: "object", properties: { name: { type: "string" }, args: { type: "object" } }, required: ["name", "args"] } },
    },
    required: ["calls"],
  };
  const render = (turns: AgentTurn[]) => turns.map((t) =>
    t.role === "user" ? `## Harness\n${t.text}`
    : t.role === "model" ? `## You called\n${JSON.stringify(t.calls.map((c) => ({ name: c.name, args: c.args })))}`
    : `## Results\n${t.results.map(({ call: c, result }) => `${c.name}(${JSON.stringify(c.args)}) → ${JSON.stringify(result)}`).join("\n")}`).join("\n\n");

  return {
    async json<T>(tier: Tier, system: string, prompt: string, schema: object): Promise<T> {
      return parsed<T>(await run(tier, system, prompt, schema));
    },
    async text(tier: Tier, system: string, prompt: string): Promise<string> {
      return (await run(tier, system, prompt)).result;
    },
    async agentStep(tier: Tier, system: string, turns: AgentTurn[], tools: ToolDef[]) {
      const sys = `${system}\n\n# Tools\nYou act only by calling these tools. Reply with JSON {"calls":[{"name":…,"args":{…}}]}: the calls to make next, in order (usually one; never act on refs you haven't observed).\n${tools.map((d) => `- ${d.name}: ${d.description} Args schema: ${JSON.stringify(d.parameters)}`).join("\n")}`;
      const out = parsed<{ calls?: { name: string; args?: Record<string, unknown> }[] }>(await run(tier, sys, `${render(turns)}\n\nWhat do you call next?`, STEP_SCHEMA));
      return { calls: (out.calls ?? []).map((c, i) => ({ id: `c${turns.length}-${i}`, name: c.name, args: c.args ?? {} })) };
    },
  };
})();
