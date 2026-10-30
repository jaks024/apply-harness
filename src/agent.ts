import { readFileSync } from "node:fs";
import type { Page } from "patchright";
import { config } from "./config.js";
import { clickRef, fillField } from "./fill.js";
import { agentStep, modelFor, type AgentTurn, type ToolDef } from "./llm.js";
import { accounts, answersForLLM, schools } from "./resolve.js";

/** The model only ever sees these tokens; the harness swaps in the real credentials at fill time. */
const CREDENTIAL_TOKENS: Record<string, () => string> = {
  EMAIL: () => accounts.primary_email,
  FALLBACK_EMAIL: () => accounts.fallback_email,
  PASSWORD: () => accounts.password,
  SHORT_PASSWORD: () => accounts.short_password || accounts.password,
  // For sites that refuse a password containing the email (accounts.alt_password, if you set one).
  ALT_PASSWORD: () => accounts.alt_password || accounts.password,
};
import { renderSnapshot, scan, type Snapshot } from "./scan.js";
import { isFinalSubmit } from "./engine-rules.js";

export interface AgentResult { state: "at_review" | "advanced" | "blocked" | "gave_up"; note: string; steps: number }

const facts = readFileSync(config.paths.facts, "utf8");

const TOOLS: ToolDef[] = [
  { name: "observe", description: "Rescan the page. Returns fields with [ref] ids, options, values, buttons and errors.", parameters: { type: "object", properties: {} } },
  { name: "fill", description: "Fill a field by ref. Text for text fields; exact option text for select/radio/buttons/combobox; 'yes'/'no' for a checkbox; 'resume' or 'transcript' for a file field; dates YYYY-MM-DD.", parameters: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" } }, required: ["ref", "value"] } },
  { name: "click", description: "Click a button or element by ref (Next, Add, Save, an option, a tab). Never the final Submit.", parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } },
  { name: "press", description: "Press a key on the focused element (Enter, Tab, Escape, ArrowDown).", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "wait", description: "Wait for the page to update, in milliseconds (max 5000).", parameters: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] } },
  { name: "finish", description: "Stop. state=at_review when the final Submit button is visible and everything is filled; advanced when you moved past the stuck page; blocked when a human is required (verification code, SSO, assessment, missing fact).", parameters: { type: "object", properties: { state: { type: "string", enum: ["at_review", "advanced", "blocked"] }, note: { type: "string" } }, required: ["state", "note"] } },
];

const SYSTEM = `You operate one browser tab to complete a job application for the candidate below. Work quickly with few calls.
Goal: ${"{GOAL}"}
Hard rules:
- NEVER click the final Submit / Submit Application button. The candidate submits personally. When it is the next step, call finish(state="at_review").
- Use only facts from the candidate facts and answer bank. Never invent experience, numbers, licenses or history. If a required answer is unknown, finish(state="blocked") with the question text.
- Ticking agreement / terms / privacy / certification checkboxes is allowed.
- Accounts: to sign up or sign in, fill the email field with the token EMAIL and password / confirm-password fields with the token PASSWORD (the harness substitutes the real values). If the site says the password is too long, use SHORT_PASSWORD. If the site refuses the password (for example because it contains the email), use ALT_PASSWORD. If EMAIL already has an account and sign-in with PASSWORD and SHORT_PASSWORD fails, create the account with FALLBACK_EMAIL instead. Never reset a password.
- On a sign-up / create-account page, create the account; only sign in on a sign-in page or after the site says the account exists. Try each email/password pair at most once.
- Never use "Autofill with Resume", "Use My Last Application" or a resume-import option: choose "Apply Manually" / fill manually.
- A resume/CV upload field gets fill(value="resume"). Start-date / availability questions use the answer bank's start date, never today's date or a pre-filled default.
- Do not create duplicate entries; check what is already filled before adding.
- Verification codes, SMS, SSO logins, assessments and identity uploads → finish(state="blocked").
- After each click that changes the page, call observe before acting on refs.

# Answer bank
${answersForLLM}

# Candidate facts
${facts}`;

// Fields of study the candidate accepts: each school's field plus its field_alternates in answers.json. Anything else
// is refused, whatever the list offers (catalogs push near-misses, e.g. "Management Science" for "Data Science").
const APPROVED_FIELDS = [...new Set(schools.flatMap((e) => [e.field, ...(e.field_alternates ?? [])]).filter((x): x is string => !!x))];
const fieldKey = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, " ").trim();
const approvedField = (s: string) => !APPROVED_FIELDS.length || APPROVED_FIELDS.some((a) => fieldKey(a) === fieldKey(s));
/** Workday-style step marker ("current step 3 of 6"), or null when the page has none. */
const stepOf = (text: string) => text.match(/current step (\d+) of \d+/i)?.[1] ?? null;

export async function rescue(page: Page, goal: string, files: { resume: string; transcript: string }, log: (s: string) => void, opts?: { stopOnAdvance?: boolean }): Promise<AgentResult> {
  let snap: Snapshot = await scan(page);
  const turns: AgentTurn[] = [{ role: "user", text: `Current page:\n${renderSnapshot(snap)}` }];
  const system = SYSTEM.replace("{GOAL}", goal);
  for (let step = 1; step <= config.llm.agentMaxSteps; step++) {
    // The big model sometimes times out for minutes at a stretch; one step on the field model beats giving up.
    const resp = await agentStep("agent", system, turns, TOOLS).catch((e) => {
      log(`  agent model failed (${String((e as Error).message ?? e).slice(0, 80)}); this step on ${modelFor("field")}`);
      return agentStep("field", system, turns, TOOLS);
    }).catch(() => null);
    if (!resp) return { state: "gave_up", note: "the model didn't answer", steps: step };
    const calls = resp.calls;
    turns.push({ role: "model", calls, text: resp.text, raw: resp.raw });
    if (!calls.length) {
      turns.push({ role: "user", text: "Use a tool. Call finish when done." });
      continue;
    }
    const replies: { call: (typeof calls)[number]; result: Record<string, unknown> }[] = [];
    for (const call of calls) {
      const args = call.args as Record<string, string | number>;
      let result: Record<string, unknown>;
      try {
        switch (call.name) {
          case "observe":
            snap = await scan(page);
            result = { page: renderSnapshot(snap) };
            break;
          case "fill": {
            const f = snap.fields.find((x) => x.ref === args.ref);
            if (!f) { result = { error: `unknown ref ${args.ref}; observe first` }; break; }
            const token = CREDENTIAL_TOKENS[String(args.value).trim()];
            if (/field of study|major|discipline|area of study/i.test(f.label) && String(args.value).trim() && !approvedField(String(args.value))) {
              result = { error: `"${args.value}" isn't an acceptable field of study. Use one of: ${APPROVED_FIELDS.join(", ")}; or leave it blank if it's optional.` };
              log(`  agent fill "${f.label.slice(0, 50)}" = ${String(args.value).slice(0, 40)} REFUSED (not an approved field)`);
              break;
            }
            const r = await fillField(page, f, token ? token() : String(args.value), files);
            if (r.ok && r.chosen && /field of study|major|discipline|area of study/i.test(f.label) && !approvedField(r.chosen)) {
              r.ok = false;
              r.note = `the list picked "${r.chosen}", which isn't acceptable; clear it and choose one of: ${APPROVED_FIELDS.join(", ")} (or leave it blank if optional)`;
            }
            log(`  agent fill "${f.label.slice(0, 50)}" = ${String(args.value).slice(0, 40)} ${r.ok ? (r.chosen && r.chosen !== args.value ? `ok → "${String(r.chosen).slice(0, 60)}"` : "ok") : "FAILED " + r.note}`);
            result = { ...r };
            break;
          }
          case "click": {
            const b = snap.buttons.find((x) => x.ref === args.ref);
            const target = b ?? snap.fields.find((x) => x.ref === args.ref);
            if (!target) { result = { error: `unknown ref ${args.ref}; observe first` }; break; }
            if (b && isFinalSubmit(b.text, snap)) { result = { error: "Refused: that is the final submit. Call finish(state='at_review')." }; break; }
            if (b && /autofill with (my )?resume|use my last application|import (from|your) resume/i.test(b.text)) { result = { error: "Refused: the candidate fills applications manually. Choose Apply Manually (or the manual option) instead." }; break; }
            const stepBefore = stepOf(snap.text);
            const newTab = page.waitForEvent("popup", { timeout: 2500 }).catch(() => null);
            await clickRef(page, target);
            if (await newTab) { log(`  agent click "${b?.text ?? args.ref}" opened a new tab`); return { state: "advanced", note: "the click opened the application in a new tab", steps: step }; }
            await page.waitForTimeout(800);
            log(`  agent click "${b?.text ?? args.ref}"`);
            result = { ok: true };
            // Once the form has moved to another step, hand back: the regular filler is faster and cheaper.
            if (opts?.stopOnAdvance) {
              await page.waitForTimeout(1500);
              const after = await scan(page).catch(() => null);
              const stepAfter = after ? stepOf(after.text) : null;
              if (stepBefore !== null && stepAfter !== null && stepAfter !== stepBefore) return { state: "advanced", note: `moved from step ${stepBefore} to step ${stepAfter}`, steps: step };
              // Sites without step markers (UKG, SuccessFactors, iCIMS): a new address with form fields is a new page.
              const path = (u: string) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } };
              if (stepBefore === null && after && path(after.url) !== path(snap.url) && after.fields.some((f) => f.kind !== "password" && !/e-?mail/i.test(f.label))) return { state: "advanced", note: `moved to ${path(after.url).slice(0, 120)}`, steps: step };
            }
            break;
          }
          case "press":
            await page.keyboard.press(String(args.key));
            result = { ok: true };
            break;
          case "wait":
            await page.waitForTimeout(Math.min(Number(args.ms) || 1000, 5000));
            result = { ok: true };
            break;
          case "finish":
            return { state: args.state as AgentResult["state"], note: String(args.note ?? ""), steps: step };
          default:
            result = { error: `unknown tool ${call.name}` };
        }
      } catch (e) {
        result = { error: String((e as Error).message ?? e).split("\n")[0].slice(0, 200) };
      }
      replies.push({ call, result });
    }
    turns.push({ role: "tools", results: replies });
  }
  return { state: "gave_up", note: `no finish after ${config.llm.agentMaxSteps} steps`, steps: config.llm.agentMaxSteps };
}
