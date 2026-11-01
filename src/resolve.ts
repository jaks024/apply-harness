import { readFileSync } from "node:fs";
import { config } from "./config.js";
import { json, text } from "./llm.js";
import { bestOption, matchPrefs, norm } from "./match.js";
import type { Field } from "./scan.js";
import { appendJsonl, readJsonl } from "./store.js";

export type Source = "rule" | "consent" | "memory" | "llm" | "file" | "builtin";
export interface Decision {
  ref: string;
  label: string;
  action: "fill" | "skip" | "flag";
  value?: string;
  source: Source;
  reason?: string;
  review?: boolean; // filled, but worth a look (narrative answers, guesses)
  alternates?: string[]; // fallbacks when the options don't contain the main answer
}

interface Rule { pattern: string; unless?: string; answer?: string; clear?: boolean; answer_if_required?: string; alternates?: string[]; answer_numeric?: string; answer_from?: string; skip?: boolean; skip_if_optional?: boolean; flag?: string; flag_if_missing?: boolean; flag_if_numeric?: boolean; note?: string }
export interface Accounts { primary_email: string; fallback_email: string; password: string; short_password: string; alt_password?: string }
export interface Answers { identity: Record<string, unknown>; address: Record<string, string | null>; rules: Rule[]; [k: string]: unknown }

export const answers: Answers = JSON.parse(readFileSync(config.paths.answers, "utf8"));
const facts = readFileSync(config.paths.facts, "utf8");
export const accounts = answers.accounts as Accounts;
// Sites that cap password length get short_password; without one, the main password.
accounts.short_password ||= accounts.password;
accounts.fallback_email ||= accounts.primary_email;
/**
 * Answer bank as shown to the model: no credentials; the rules only as their standing answers (criminal history,
 * relatives, drug screen…), so the rescue agent knows them when it fills a page itself.
 */
export const answersForLLM = JSON.stringify({
  ...answers, rules: undefined, _note: undefined, accounts: undefined,
  standing_answers: answers.rules.filter((r) => r.answer && !r.flag).map((r) => ({ question_regex: r.pattern, answer: r.answer })),
});
const workAuth = (answers.work_authorization ?? {}) as Record<string, string | undefined>;
/** The candidate needs visa sponsorship: skip postings that say they won't sponsor, prefer "yes, with a visa" options. */
export const needsSponsorship = /^yes/i.test(String(workAuth.requires_sponsorship ?? ""));
matchPrefs.preferVisaYes = needsSponsorship;
const eeo = (answers.eeo ?? {}) as { race_groups?: string[]; race_subgroup?: string };
const rules = answers.rules.map((r) => ({ ...r, re: new RegExp(r.pattern, "i"), not: r.unless ? new RegExp(r.unless, "i") : null }));

// ---------- agreement checkboxes ----------
const AGREEMENT = /\b(terms|privacy|policy|consent|agree|acknowledge|accept|certif(y|ication)|attest|read and understand|true,? (accurate|correct)|accurate and complete|electronic signature|e-?signature|data (processing|protection)|gdpr|ccpa|background (check|screening)|arbitration|candidate (privacy|notice)|retain my (data|information)|processing of my)\b/i;
const MARKETING = /\b(sms|text messages?|marketing|newsletter|talent (community|network|pool)|job alerts?|future (opportunities|openings|roles|positions)|keep me (informed|updated)|similar (jobs|roles)|subscribe)\b/i;
const FACTUAL = /\b(authori[sz]ed|eligible|sponsor\w*|visa|citizen\w*|veteran|disabilit\w*|years? (of age|old)|at least (18|21)|convicted|criminal|relatives?|employed by|worked (for|at)|non-?compete|clearance|licen[sc]e\w*|relocat\w*|willing to)\b/i;

export function classifyCheckbox(f: Field): "agreement" | "marketing" | "factual" | "other" {
  const l = f.label;
  if (MARKETING.test(l) && !f.required) return "marketing";
  if (AGREEMENT.test(l) && !(FACTUAL.test(l) && !/certify (that )?(the |all )?(information|above|statements|answers)/i.test(l))) return "agreement";
  if (FACTUAL.test(l)) return "factual";
  return "other";
}

// ---------- learned memory ----------
const memKey = (f: Field) => `${norm(f.label)}|${(f.options ?? []).map(norm).sort().join(",")}`;
const memory = new Map<string, string>();
for (const m of readJsonl<{ key: string; value: string }>(config.paths.fieldMemory)) memory.set(m.key, m.value);

export function remember(f: Field, value: string, source: Source, host: string) {
  if (source === "file" || source === "consent" || f.kind === "password" || !value.trim()) return;
  // Written answers are company-specific ("Why do you want to join X?"); never replay them on another form.
  if (f.kind === "textarea" || value.length > 80) return;
  // No question text, no memory (it would replay on every unlabeled box); salary answers depend on the posting.
  if (!f.label.trim() || /salary|compensation|\bpay\b|wage/i.test(f.label)) return;
  // A "label" that is only an option word ("Yes", Oracle's button text) names no question: never replay it.
  if (/^(yes|no|true|false|n\/?a|none|other|ok|on|off)$/i.test(f.label.trim()) || f.label.trim().length < 3) return;
  if (/^dateSection/.test(f.automationId ?? "") || /\b(month|day|year)$/i.test(f.label.trim()) || /----/.test(value)) return;
  // A placeholder standing in for a label ("Start typing...", "Select...") names no question; never key memory on it.
  if (/^(start typing|type to search|search|select( an? option)?|choose( one)?|please select|enter)[\s.…:]*$/i.test(f.label.trim())) return;
  const key = memKey(f);
  if (memory.get(key) === value) return;
  memory.set(key, value);
  appendJsonl(config.paths.fieldMemory, { key, label: f.label, kind: f.kind, options: f.options, value, source, host, at: new Date().toISOString() });
}

function pathGet(obj: unknown, path: string): string | null {
  let cur: unknown = obj;
  for (const p of path.split(".")) cur = (cur as Record<string, unknown> | undefined)?.[p];
  return typeof cur === "string" ? cur : null;
}

const today = () => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`; };
const isChoice = (f: Field) => ["select", "radio", "buttons", "combobox", "checkboxes"].includes(f.kind);

/** Deterministic pass: files, agreements, rules, memory. Returns decisions for what it could settle; the rest go to the LLM. */
export interface LocalOpts { resumeUploaded: boolean; password?: string; accountEmail?: string; /** which school block (0, 1, …) each education field belongs to */ eduIndex?: Map<string, number> }

export function resolveLocal(fields: Field[], opts: LocalOpts): { decided: Decision[]; pending: Field[] } {
  const decided: Decision[] = [];
  const pending: Field[] = [];
  let resumeTaken = opts.resumeUploaded;
  const authPage = fields.some((f) => f.kind === "password");
  for (const f of fields) {
    const d = (x: Omit<Decision, "ref" | "label">) => decided.push({ ref: f.ref, label: f.label, ...x });
    const l = norm(f.label);
    if (f.kind === "file") {
      // Oracle's "Import your profile / Let's make this quick" parses the resume into the form (names, schools and dates
      // come out wrong); the user prefers filling manually. The regular "Upload Resume" slot still gets the file.
      if (/import your profile|let s make this quick|choose how you d like/.test(l)) { d({ action: "skip", source: "file" }); continue; }
      // Never the resume into a video/photo slot (some careers pages have "Upload Video").
      if (/video|photo|picture|headshot|image|avatar|selfie|portrait/.test(l)) { d({ action: "skip", source: "file" }); continue; }
      if (/cover/.test(l)) { if (f.required) d({ action: "flag", source: "file", reason: "Required cover-letter upload; none prepared" }); else d({ action: "skip", source: "file" }); }
      else if (/transcript/.test(l)) { if (f.required) d({ action: "fill", value: "transcript", source: "file" }); else d({ action: "skip", source: "file" }); }
      else if (/resume|cv\b|curriculum/.test(l) || !resumeTaken) { d({ action: "fill", value: "resume", source: "file" }); resumeTaken = true; }
      else if (f.required) d({ action: "flag", source: "file", reason: `Required upload "${f.label}"` });
      else d({ action: "skip", source: "file" });
      continue;
    }
    if (f.kind === "password") {
      if (opts.password && !f.filled) d({ action: "fill", value: opts.password, source: "builtin", reason: "account password" });
      else d({ action: "skip", source: "builtin" });
      continue;
    }
    if (authPage && opts.accountEmail && (f.kind === "email" || /e-?mail|user ?name/i.test(f.label))) { d({ action: "fill", value: opts.accountEmail, source: "builtin", reason: "account email" }); continue; }
    if (f.kind === "checkbox") {
      const c = classifyCheckbox(f);
      if (c === "agreement") { d({ action: "fill", value: "yes", source: "consent" }); continue; }
      if (c === "marketing") { d({ action: "skip", source: "consent" }); continue; }
    }
    const ek = eduKind(f.label);
    if (ek && schools.length) {
      const e = schools[opts.eduIndex?.get(f.ref) ?? 0];
      const v = e ? eduValue(ek, e) : null;
      if (v) {
        const words = v.split(/\s+/);
        // "Supply Chain Analytics" → "Analytics", never just "Supply" (a two-word field's first word lands on the wrong major).
        const alternates = ek === "field" && words.length > 1 ? [words[words.length - 1], `Data ${words[words.length - 1]}`] : undefined;
        const opt = isChoice(f) && f.options?.length ? [v, ...(alternates ?? [])].map((x) => bestOption(x, f.options!)).find(Boolean) : null;
        if (opt) { d({ action: "fill", value: opt, source: "builtin" }); continue; }
        if (!isChoice(f) || !f.options?.length) { d({ action: "fill", value: v, source: "builtin", alternates }); continue; }
      }
    }
    if (/^(today s )?date( (month|day|year))?$|date signed|signature date|todays date|current date/.test(l)) { d({ action: "fill", value: today(), source: "builtin" }); continue; }

    // An acknowledgment picker ("I have read the above information" / "I have not read …") answers a disclosure, not a
    // question: always the affirmative. Before the rules, which key on words in the disclosure ("criminal history",
    // "relatives" → No) and would pick the negated option, which some employers treat as a knockout.
    if (isChoice(f) && f.options?.length) {
      const ACK = /^(yes[,.]? )?i (have read|acknowledge|understand|agree|accept|certify|consent|attest)\b/i;
      const NEG = /\b(not|don'?t|do not|disagree|decline|refuse)\b/i;
      const yes = f.options.find((o) => ACK.test(o.trim()) && !NEG.test(o));
      if (yes && f.options.some((o) => NEG.test(o))) { d({ action: "fill", value: yes, source: "consent" }); continue; }
    }

    // Race as one tick box per group (Workday "Asian (Not Hispanic or Latino) - A person having origins in…"): tick the
    // groups in answers.eeo.race_groups, leave every other group unticked. Where a group is split into subgroups
    // ("Asian – East Asian", "Asian – South Asian"), only eeo.race_subgroup's box is ticked.
    if (eeo.race_groups?.length && f.kind === "checkbox" && /^(white|black|african|asian|hispanic|latino|native|american indian|alaska|two or more|pacific islander|middle eastern|north african)\b/.test(l)) {
      const group = eeo.race_groups.map(norm).find((g) => l.startsWith(g));
      const split = /\b(south|southeast|south east|central|west|indian|pacific)\b/.test(l);
      const sub = eeo.race_subgroup ? norm(eeo.race_subgroup) : null;
      const tick = !!group && (!split || !sub || ` ${l.replace(/south ?east asian/g, "")} `.includes(` ${sub} `));
      d({ action: "fill", value: tick ? "Yes" : "No", source: "rule" }); continue;
    }
    const bare = f.label.replace(/(\s*(\*|✱|\((required|optional)\)))+\s*$/i, "").trim();
    // `unless`: "prior salary" must not fire on "Expected salary? Do not list your prior salary history."
    const rule = rules.find((r) => (r.re.test(f.label) || r.re.test(bare)) && !r.not?.test(f.label));
    if (rule) {
      if ((rule.skip || rule.skip_if_optional) && !f.required) { d({ action: "skip", source: "rule" }); continue; }
      // "clear": leave it blank (and wipe a parser's guess); a required box gets answer_if_required instead.
      if (rule.clear && !isChoice(f) && f.required && rule.answer_if_required) { d({ action: "fill", value: rule.answer_if_required, source: "rule" }); continue; }
      if (rule.clear && !isChoice(f)) { d({ action: f.value ? "fill" : "skip", value: "", source: "rule" }); continue; }
      if (rule.flag) { d({ action: "flag", source: "rule", reason: rule.flag }); continue; }
      let value = (f.kind === "number" && rule.answer_numeric) || rule.answer || (rule.answer_from ? pathGet(answers, rule.answer_from) : null);
      // A yes/no rule never goes into a free-text box ("Employment history", "Tell us about…")
      if (value && /^(yes|no)$/i.test(value) && f.kind === "textarea") value = null;
      if (rule.answer_from && !value) {
        if (rule.flag_if_missing && f.required) { d({ action: "flag", source: "rule", reason: `No ${rule.answer_from} in answers.json` }); continue; }
        if (!f.required) { d({ action: "skip", source: "rule" }); continue; }
      }
      if (rule.flag_if_numeric && (f.kind === "number" || /\b(numeric|number|amount|\$)\b/i.test(f.placeholder ?? ""))) { d({ action: "flag", source: "rule", reason: "Numeric salary field" }); continue; }
      if (value) {
        if (f.kind === "checkbox") {
          if (/^(yes|no)$/i.test(value)) { d({ action: "fill", value, source: "rule" }); continue; }
        } else if (isChoice(f) && f.options?.length) {
          const opt = [value, ...(rule.alternates ?? [])].map((v) => bestOption(v, f.options!)).find(Boolean);
          if (opt) { d({ action: "fill", value: opt, source: "rule" }); continue; }
          // options don't fit the rule's phrasing — let the LLM pick
        } else if (!isChoice(f) || !f.options?.length) {
          d({ action: "fill", value, source: "rule", alternates: rule.alternates }); continue;
        }
      }
    }
    const mem = f.label.trim().length >= 3 && !/^(yes|no|true|false|n\/?a|none|other|ok|on|off)$/i.test(f.label.trim()) && !/salary|compensation|\bpay\b|wage/i.test(f.label) ? memory.get(memKey(f)) : undefined;
    if (mem) { d({ action: "fill", value: mem, source: "memory" }); continue; }
    pending.push(f);
  }
  return { decided, pending };
}

const hourlyMin = Number((answers as { compensation?: { hourly_minimum?: number } }).compensation?.hourly_minimum ?? 0);
const extraRules = ((answers as { llm_instructions?: string[] }).llm_instructions ?? []).map((r) => `- ${r}`).join("\n");
const SYSTEM = `You fill job application forms for one candidate. Answer only from the candidate facts and answer bank. Latest dated fact wins on conflicts.
Rules:
- action "fill" with the exact option text for choice fields (select/radio/buttons/combobox/checkboxes; for checkboxes join several with " ;; "; for a single checkbox use "yes" or "no").
- action "skip" for optional fields with no supported answer (leave blank, never invent).
- action "flag" for a REQUIRED field whose answer is not established by the facts (a specific certification, an unusual legal attestation, a document you don't have). Give a short reason.
- Expected / desired salary: use the job posting's own stated range, written as the posting writes it. A number-only salary field gets a reasonable number toward the high end of the posted range. No range posted: a reasonable high-end market figure for this role and city. Never below the posted minimum.
- Expected hourly rate (internships): the posting's hourly range if stated${hourlyMin ? `, never below ${hourlyMin}/hour; a number-only field gets the high end of the posted hourly range, or ${hourlyMin} if none is posted` : "; a number-only field gets the high end of the posted hourly range"}.
- Work authorization comes from the answer bank's work_authorization section. Never volunteer visa or immigration details outside work-authorization questions.${needsSponsorship ? " The candidate needs sponsorship: questions about authorization WITHOUT sponsorship, unrestricted or permanent status → flag." : ""}
- Employment/education answers come from the resume and answer bank exactly (titles, dates). Dates as YYYY-MM-DD or YYYY-MM.
- Free-text motivation questions ("why this company/role"): 2-4 sentences, personal and specific to the company and role using the job text provided, grounded in real experience. Mark review=true.
- Years-of-experience questions: count from the resume dates and be conservative; mark review=true.
- Write every text answer in English only (no other languages or scripts).
- Values go straight into the form: a numeric question gets only the number ("2"), a date only the date, a name only the name. No explanations inside values.
- Never claim a skill, license, tool or experience the facts don't support. Prior-application and prior-interview questions: use the prior applications section; an Interview status there means a prior interview. "How did you hear" = the answer bank's how_did_you_hear (LinkedIn if unset) unless only other options fit.${extraRules ? `\n\n# Candidate-specific rules\n${extraRules}` : ""}`;

// The large unchanging part (instructions + answer bank + profile) goes first and is identical on every call,
// so the provider's prompt caching can reuse it; only the job, page and fields vary.
const STATIC_SYSTEM = `${SYSTEM}\n\n# Answer bank (JSON)\n${answersForLLM}\n\n# Candidate facts\n${facts}`;
const STATIC_PREFIX = `# Answer bank (JSON)\n${answersForLLM}\n\n# Candidate facts\n${facts}`;

// ---------- repeating education blocks ----------
// Forms with "Add another" education show School/Degree/Discipline/date fields once per school. The n-th block gets
// the n-th school in answers.json (list the most recent first); entries marked only_if_asked only when asked.
export interface Edu {
  school: string; degree: string; field: string | null; start: string; end: string; expected?: boolean; only_if_asked?: boolean;
  /** Acceptable stand-ins when a form's catalog lacks the exact field ("Economics" for "Applied Economics"). */
  field_alternates?: string[];
  /** Other names the school goes by in catalogs; and look-alike schools that must never be picked. */
  school_aliases?: string[]; never_schools?: string[];
}
export const schools = ((answers.education as Edu[]) ?? []).filter((e) => !e.only_if_asked);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function eduKind(label: string): string | null {
  const l = label.toLowerCase().replace(/\*$/, "").trim();
  if (/^(school|university|college|institution)( name)?$/.test(l)) return "school";
  if (/^degree( type)?$/.test(l)) return "degree";
  if (/^(discipline|major|field of study|area of study|concentration)$/.test(l)) return "field";
  const m = l.match(/^(start|end)( date)? (month|year)$/);
  return m ? `${m[1]}-${m[3]}` : null;
}
function eduValue(kind: string, e: Edu): string | null {
  if (kind === "school") return e.school;
  if (kind === "degree") return (e as Edu & { expected?: boolean }).expected ? `${e.degree} (in progress)` : e.degree;
  if (kind === "field") return e.field;
  const [which, part] = kind.split("-");
  const ym = which === "start" ? e.start : e.end;
  const [y, m] = ym.split("-");
  return part === "year" ? y : MONTHS[Number(m) - 1];
}

// ---------- written answers (agent model) ----------
// Open-ended questions get their own model call with a writing brief, then a quality gate. Field-answer models have
// produced run-on, punctuation-free text and mid-sentence language switches here.
const WRITTEN_Q = /\b(describe|why|tell us|explain|walk us through|share|how (do|did|would|have)|what (interests|excites|motivates|draws|attracts|makes you)|in which|give (us )?an example|cover letter|summar|what (kinds?|types?|sorts?) of|what (skills|areas)\b|what (do|would) you (hope|want|bring|enjoy|like)|interested in (developing|learning|growing|building)|(hope|want|plan|looking|like) to (learn|develop|grow|gain|build)|career (goals?|aspirations?|plans?)|next (few|two|three|five|\d+) years|strengths?\b|weakness)/i;
/** The candidate's floor (answers.compensation.hourly_minimum): a bare hourly figure below it is raised to it. */
function salaryFloor(f: Field, v: string): string {
  const min = Number((answers as { compensation?: { hourly_minimum?: number } }).compensation?.hourly_minimum ?? 0);
  if (!min || !/salary|compensation|\bpay\b|wage|rate/i.test(f.label)) return v;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 && n < min ? String(min) : v;
}

export function isWrittenQuestion(f: Field): boolean {
  // Salary questions want a figure or range (the batch model's salary rule), not a paragraph, even in a big box.
  if (/salary|compensation|\bpay\b|wage|rate expectation/i.test(f.label)) return false;
  // Big boxes are for open-ended questions; a short factual one ("Have you applied before? If so, when?", "What city
  // do you live in?") gets a short answer from the batch instead of a paragraph.
  if (f.kind === "textarea") return !(!f.required && /anything else|additional (information|comments)|comments\??$/i.test(f.label)) && (WRITTEN_Q.test(f.label) || f.label.length > 140);
  // Salary questions want a figure or range (the batch model's salary rule), not a paragraph.
  if (/salary|compensation|\bpay\b|wage|rate expectation/i.test(f.label)) return false;
  return f.kind === "text" && WRITTEN_Q.test(f.label) && f.label.length > 25;
}

const voice = (answers as { writing_voice?: string }).writing_voice ?? "confident and professional, but relaxed, like a sharp candidate talking to a hiring manager. Plain words, contractions are fine, a bit of personality";
const WRITER = `You write short answers to job application questions for the candidate described below.
Voice: ${voice}. No emojis, no buzzword chains ("leverage synergies", "drive impactful outcomes"), no "I am excited to" openers.
Length: 2 to 4 sentences, 40 to 90 words. Every sentence ends with a period, question mark or exclamation mark.
If the question doesn't apply to the candidate at all (a license number, a license state, details of something the candidate doesn't have), output exactly: N/A
Exception: when the honest answer is none, no or not applicable (no licenses or certifications, no relatives at the company, never worked there), answer in one short sentence, e.g. "None." or "No, I don't hold any professional licenses." Don't pad it or pivot to other credentials.
Answer exactly what is asked; if it asks which role or where, name the role and company.
Use only facts from the resume and facts below (titles, employers, tools, numbers). Never invent experience, metrics or tools. One or two concrete examples beat a list.
English only. Output only the answer text, nothing else.`;

function writingProblems(t: string): string[] {
  const p: string[] = [];
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 110) p.push(`too long (${words.length} words; keep it under 90)`);
  if (words.length < 15 && !/^(none|no\b|n\/a|not applicable)/i.test(t.trim())) p.push("too short");
  if (/^(not applicable|n\/a|none)\b/i.test(t.trim()) && words.length > 15) p.push("a not-applicable answer must be one short sentence or just N/A");
  if (!/[.!?]["')]?$/.test(t.trim())) p.push("does not end with punctuation");
  const sentences = t.split(/(?<=[.!?])\s+/);
  if (sentences.some((s) => s.split(/\s+/).length > 40)) p.push("a sentence runs over 40 words; split it");
  const grams = new Map<string, number>();
  for (let i = 0; i + 4 <= words.length; i++) { const g = words.slice(i, i + 4).join(" ").toLowerCase(); grams.set(g, (grams.get(g) ?? 0) + 1); }
  if ([...grams.values()].some((n) => n > 2)) p.push("repeats the same phrase");
  if (NON_LATIN.test(t)) { NON_LATIN.lastIndex = 0; p.push("contains non-English text"); }
  return p;
}

async function writeAnswer(f: Field, job: { company?: string; role?: string; postingText?: string }): Promise<Decision> {
  const ask = (extra: string) => `${STATIC_PREFIX}\n\n# Job\nCompany: ${job.company ?? "?"}\nRole: ${job.role ?? "?"}\n${job.postingText ? `Posting (excerpt): ${job.postingText.slice(0, 3500)}` : ""}\n\n# Question\n${f.label}${f.placeholder ? `\n(placeholder: ${f.placeholder})` : ""}${extra}`;
  let answer = "";
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await text("agent", WRITER, ask(attempt ? `\n\nYour previous draft had problems: ${problems.join("; ")}. Rewrite it.\nPrevious draft: ${answer}` : ""));
    answer = englishOnly(r.trim().replace(/^["']|["']$/g, ""));
    problems = writingProblems(answer);
    if (!problems.length) break;
  }
  if (problems.length) {
    // Keep the clean opening sentences rather than send a run-on.
    answer = answer.split(/(?<=[.!?])\s+/).filter((s) => s.split(/\s+/).length <= 40).slice(0, 3).join(" ");
  }
  if (!answer) return { ref: f.ref, label: f.label, action: f.required ? "flag" : "skip", source: "llm", reason: "could not write a clean answer" };
  return { ref: f.ref, label: f.label, action: "fill", value: answer, source: "llm", review: true, reason: problems.length ? `trimmed: ${problems.join("; ")}` : undefined };
}

// The model occasionally drifts into another language mid-sentence (seen: Chinese tacked onto an English answer).
// Cyrillic, Hebrew/Arabic, Thai, CJK punctuation, kana, CJK ideographs, Hangul, full-width forms.
const NON_LATIN = /[Ѐ-ӿ֐-ۿ฀-๿　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]+/g;
export function englishOnly(v: string): string {
  if (!NON_LATIN.test(v)) return v;
  NON_LATIN.lastIndex = 0;
  return v.replace(NON_LATIN, " ").replace(/\s+([.,;:!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

const SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "string" },
          action: { type: "string", enum: ["fill", "skip", "flag"] },
          value: { type: "string" },
          reason: { type: "string" },
          review: { type: "boolean" },
        },
        required: ["ref", "action"],
      },
    },
  },
  required: ["decisions"],
};

type LlmJob = { company?: string; role?: string; url: string; pageText: string; errors: string[]; priorApplications?: string[]; postingText?: string };

export async function resolveWithLLM(pending: Field[], job: LlmJob): Promise<Decision[]> {
  const { quick, written } = resolveWithLLMParts(pending, job);
  return [...(await quick), ...(await written)];
}

/**
 * Open-ended questions go to the writer (agent model), everything else to one structured batch (field model); both start at once.
 * They come back separately so the quick yes/no answers get filled without waiting on the (much slower) writing.
 */
export function resolveWithLLMParts(pending: Field[], job: LlmJob): { quick: Promise<Decision[]>; written: Promise<Decision[]> } {
  const toWrite = pending.filter(isWrittenQuestion);
  const written = Promise.all(toWrite.map((f) => writeAnswer(f, job).catch((): Decision => ({ ref: f.ref, label: f.label, action: f.required ? "flag" : "skip", source: "llm", reason: "writer failed" }))));
  const rest = pending.filter((f) => !toWrite.includes(f));
  return { quick: rest.length ? quickBatch(rest, job) : Promise.resolve([]), written };
}

async function quickBatch(pending: Field[], job: LlmJob): Promise<Decision[]> {
  const fields = pending.map((f) => ({ ref: f.ref, kind: f.kind, label: f.label, required: f.required, options: f.options?.slice(0, 80), placeholder: f.placeholder, current: f.value || undefined, error: f.error }));
  const prompt = [
    `# Job\nCompany: ${job.company ?? "?"}\nRole: ${job.role ?? "?"}\nURL: ${job.url}`,
    `# Prior applications to this company (from the job tracker and ledger)\n${job.priorApplications?.length ? job.priorApplications.join("\n") : "None recorded. Answer No to 'have you applied before'."}`,
    job.errors.length ? `# Validation errors currently shown on the page\n${job.errors.join("\n")}` : "",
    job.postingText ? `# Job posting text (captured when the job was opened; use it for salary ranges and motivation answers)\n${job.postingText.slice(0, 6000)}` : "",
    `# Current page text (truncated)\n${job.pageText.slice(0, 4000)}`,
    `# Fields to answer\n${JSON.stringify(fields)}`,
  ].filter(Boolean).join("\n\n");
  type Out = { decisions: { ref: string; action: "fill" | "skip" | "flag"; value?: string; reason?: string; review?: boolean }[] };
  const byRef = new Map(pending.map((f) => [f.ref, f]));
  const got = new Map<string, Out["decisions"][number]>();
  let ask = prompt;
  for (let round = 0; round < 2; round++) {
    const out = await json<Out>("field", STATIC_SYSTEM, ask, SCHEMA);
    for (const d of out.decisions ?? []) if (byRef.has(d.ref) && !got.has(d.ref)) got.set(d.ref, d);
    const missing = fields.filter((f) => !got.has(f.ref));
    if (!missing.length) break;
    // The model occasionally drops fields from a long list; ask again for just those.
    ask = prompt.replace(/# Fields to answer\n[\s\S]*$/, `# Fields to answer (every one needs a decision)\n${JSON.stringify(missing)}`);
  }
  const numeric = (f: Field, v: string) => (f.kind === "number" ? v.replace(/,/g, "").match(/-?\d+(\.\d+)?/)?.[0] ?? v : v);
  const out: Decision[] = [...got.values()].map((d) => ({ ...d, value: d.value === undefined ? undefined : numeric(byRef.get(d.ref)!, salaryFloor(byRef.get(d.ref)!, englishOnly(d.value))), label: byRef.get(d.ref)!.label, source: "llm" as const }));
  // The batch model sometimes writes a paragraph anyway (an open question the writer's pattern missed), and can loop
  // into one endless run-on sentence. Any long or broken text answer goes back through the writer and its gate.
  return Promise.all(out.map(async (d) => {
    const f = byRef.get(d.ref)!;
    const words = (d.value ?? "").split(/\s+/).filter(Boolean).length;
    if (d.action !== "fill" || !["text", "textarea"].includes(f.kind) || words <= 25 || (words <= 60 && !writingProblems(d.value!).length)) return d;
    return writeAnswer(f, job).catch(() => ({ ...d, action: f.required ? "flag" as const : "skip" as const, value: undefined, reason: "the batch answer was a run-on and the writer failed" }));
  }));
}
