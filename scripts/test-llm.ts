// Checks the configured model provider end to end: one structured answer, one written answer, one agent step.
// Uses a few small calls (a fraction of a cent, or a little of your Claude usage).
import { config } from "../src/config.js";
import { agentStep, json, text } from "../src/llm.js";

console.log(`provider ${config.llm.provider}: field model ${config.llm.fieldModel}, agent model ${config.llm.agentModel}`);
let failed = 0;
async function check(name: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try { const out = await fn(); console.log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s): ${out.slice(0, 100)}`); }
  catch (e) { failed++; console.log(`FAIL ${name}: ${String((e as Error).message ?? e).slice(0, 300)}`); }
}

await check("structured answer (field model)", async () => {
  const r = await json<{ answer: string }>("field", "Answer job application form fields.", 'Field: "Are you at least 18 years old?" Options: Yes, No. The candidate is 25.',
    { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] });
  if (!/^yes$/i.test(r.answer)) throw new Error(`expected Yes, got ${JSON.stringify(r)}`);
  return r.answer;
});
await check("written answer (agent model)", async () => {
  const r = await text("agent", "Write one short sentence. Output only the sentence.", "Why do you like data analysis?");
  if (r.trim().split(/\s+/).length < 4) throw new Error(`too short: ${r}`);
  return r.trim();
});
await check("agent tool call (agent model)", async () => {
  const r = await agentStep("agent", "You operate a form. Use the tools.", [{ role: "user", text: 'Page: field [f1] "First name" (empty). Fill it with "Ada", then you are done.' }],
    [{ name: "fill", description: "Fill a field by ref.", parameters: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" } }, required: ["ref", "value"] } },
      { name: "finish", description: "Stop.", parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } }]);
  const fill = r.calls.find((c) => c.name === "fill");
  if (!fill || fill.args.ref !== "f1" || !/ada/i.test(String(fill.args.value))) throw new Error(`expected fill(f1, Ada), got ${JSON.stringify(r.calls)}`);
  return JSON.stringify(r.calls.map((c) => ({ name: c.name, args: c.args })));
});
console.log(failed ? `\n${failed} check(s) failed.` : "\nThe model provider works.");
process.exit(failed ? 1 : 0);
