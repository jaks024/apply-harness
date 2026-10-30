// Runs standard screening questions through the resolver (rules → memory → model) and checks the answers against your
// answer bank. Makes a couple of model calls (a few cents, or a little of your Claude usage).
import { bestOption } from "../src/match.js";
import { accounts, answers, classifyCheckbox, resolveLocal, resolveWithLLM, type Decision } from "../src/resolve.js";
import type { Field } from "../src/scan.js";

type Case = Omit<Field, "ref" | "frame" | "value" | "filled"> & { expect: string | RegExp | "flag" | "skip" };
const yn = ["Yes", "No"];
const id = answers.identity as Record<string, string>;
const auth = (answers.work_authorization ?? {}) as Record<string, string>;
const cases: Case[] = [
  { kind: "text", label: "First Name", required: true, expect: id.legal_first_name },
  { kind: "text", label: "Last Name", required: true, expect: id.last_name },
  { kind: "email", label: "Email", required: true, expect: id.email },
  { kind: "tel", label: "Phone", required: true, expect: id.phone },
  { kind: "select", label: "Are you legally authorized to work in the United States?", options: yn, required: true, expect: auth.authorized_us ?? "Yes" },
  { kind: "select", label: "Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa status)?", options: yn, required: true, expect: auth.requires_sponsorship ?? "No" },
  { kind: "radio", label: "Have you ever been employed by Acme Corp or any of its subsidiaries?", options: yn, required: true, expect: "No" },
  { kind: "checkbox", label: "I have read and agree to the Privacy Policy and Terms of Use", required: true, expect: "yes" },
  { kind: "checkbox", label: "Send me text messages about future job opportunities", required: false, expect: "skip" },
  { kind: "select", label: "Veteran Status", options: ["I am a veteran", "I am not a protected veteran", "I don't wish to answer"], required: false, expect: /./ },
  { kind: "text", label: "Social Security Number", required: true, expect: "flag" },
  { kind: "select", label: "What is the highest level of education you have completed?", options: ["High School", "Associate's Degree", "Bachelor's Degree", "Master's Degree", "Doctorate"], required: true, expect: /degree|school|doctorate/i },
  { kind: "select", label: "When is the earliest you could start?", options: ["Immediately", "Within 1 month", "1-3 months", "3+ months"], required: true, expect: /./ },
  { kind: "textarea", label: "Why do you want to work at Acme Analytics?", required: false, expect: /\w+ \w+ \w+/ },
  { kind: "text", label: "What are your salary expectations?", required: true, expect: /90,?000.*120,?000|\$?1[01]\d,?\d{3}/ },
  { kind: "password", label: "Create password", required: true, expect: accounts.password },
];

const fields: Field[] = cases.map((c, i) => ({ ...c, ref: `t${i}`, frame: 0, value: "", filled: false }));
const t0 = Date.now();
const { decided, pending } = resolveLocal(fields, { resumeUploaded: true, password: accounts.password });
const llm = await resolveWithLLM(pending, { company: "Acme Analytics", role: "Data Analyst", url: "https://example.com/jobs/1", pageText: "Application form", errors: [],
  postingText: "Acme Analytics builds retail demand forecasting software. Data Analyst, hybrid. The base salary range for this role is $90,000 - $120,000 per year." });
const all = new Map<string, Decision>([...decided, ...llm].map((d) => [d.ref, d]));

let pass = 0;
for (const [i, c] of cases.entries()) {
  const d = all.get(`t${i}`);
  const got = d?.action === "fill" ? d.value ?? "" : d?.action ?? "none";
  const val = c.options && d?.action === "fill" ? bestOption(got, c.options) ?? got : got;
  const ok = c.expect === "flag" || c.expect === "skip" ? d?.action === c.expect : c.expect instanceof RegExp ? c.expect.test(val) : val.toLowerCase() === String(c.expect).toLowerCase();
  if (ok) pass++;
  const shown = c.kind === "password" ? "(password)" : String(val).slice(0, 70);
  console.log(`${ok ? "PASS" : "FAIL"} [${(d?.source ?? "-").padEnd(7)}] ${c.label.slice(0, 70).padEnd(70)} → ${shown}${c.kind === "checkbox" ? ` (${classifyCheckbox(fields[i])})` : ""}`);
}
console.log(`\n${pass}/${cases.length} passed; ${pending.length} went to the model; ${Date.now() - t0} ms`);
process.exit(pass === cases.length ? 0 : 1);
