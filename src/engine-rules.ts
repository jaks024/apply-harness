import type { Button, Snapshot } from "./scan.js";

export const SUBMIT_RE = /^(submit|submit (my |your )?application|send (my )?application|complete (my )?application|finish( application)?|submit & finish)$/i;
export const NEXT_RE = /^(next|continue|save (and|&) continue|save (and|&) next|next step|proceed|review|review (my )?application|continue to (next step|review)|save and proceed)$/i;
export const START_RE = /^(apply|apply now|apply for (this )?(job|position|role)|apply to (this )?(job|position)|start (your |my )?application|i'?m interested|apply manually|begin application)$/i;
export const CONFIRM_RE = /thank you for (applying|your application|submitting)|application (has been |was )?(submitted|received|complete)|we('ve| have) (received|got) your application|your application (is|has been) (in|submitted|received)|application in hand|successfully (applied|submitted)|(?<!jobs )you('ve| have) (successfully )?applied/i;
export const CONFIRM_URL_RE = /confirmation|thank-?you|thanks|submitted|\/jobTasks\/completed|application-complete|success/i;

// Statements that the role won't sponsor (skipped when the candidate needs sponsorship). Questions such as
// "Will you now or in the future require sponsorship?" deliberately don't match.
const NO_SPONSOR: RegExp[] = [
  /not eligible for (visa |immigration |employment )?sponsorship/i,
  /\b(will|does|do|can|cannot|can't|won't|doesn't|don't|is|are) (not )?(unable to |able to )?(provide|offer|support|consider) (any )?(visa |immigration |employment |h-?1b )*sponsorship\b(?! (now|in the future)\?)/i,
  /\bunable to (provide|offer|support|sponsor)\b[^.?]{0,40}\b(visa|sponsor)/i,
  /\bno (visa |immigration |employment )?sponsorship (is |will be )?(available|provided|offered)/i,
  /\bsponsorship (is |will )?not (be )?(available|provided|offered|considered)/i,
  /\b(does|do|will) not sponsor\b/i,
  /\bmust (be )?(legally )?(authorized|eligible) to work in the (united states|u\.s\.?|us)[^.?]{0,60}without (the need for )?(current or future |future |employer |visa )*sponsorship/i,
];
/** Returns the sentence that says the role won't sponsor, or null. */
export function noSponsorship(text: string): string | null {
  const t = text.replace(/\s+/g, " ");
  for (const re of NO_SPONSOR) {
    const m = t.match(re);
    if (!m) continue;
    // A question isn't a statement; only skip when the matched sentence doesn't end in "?".
    const end = t.indexOf("?", m.index!) ;
    const dot = t.indexOf(".", m.index!);
    if (end !== -1 && (dot === -1 || end < dot) && end - m.index! < 160 && !/not eligible|will not|does not|do not|cannot|unable/i.test(m[0])) continue;
    const start = Math.max(t.lastIndexOf(".", m.index!) + 1, m.index! - 120);
    return t.slice(start, Math.min(t.length, m.index! + m[0].length + 60)).trim();
  }
  return null;
}

export function isFinalSubmit(text: string, s: Snapshot): boolean {
  if (!SUBMIT_RE.test(text.trim())) return false;
  return !s.buttons.some((b) => NEXT_RE.test(b.text.trim()) && !b.disabled);
}

export function finalSubmitButton(s: Snapshot): Button | undefined {
  return s.buttons.find((b) => isFinalSubmit(b.text, s));
}

export function advanceButton(s: Snapshot): Button | undefined {
  const cands = s.buttons.filter((b) => NEXT_RE.test(b.text.trim()) && !b.disabled);
  return cands.find((b) => /save (and|&) continue|^next$|^continue$/i.test(b.text)) ?? cands[0];
}

export function startButton(s: Snapshot): Button | undefined {
  return s.buttons.find((b) => START_RE.test(b.text.trim()) && !b.disabled);
}

export function isConfirmation(s: Snapshot): boolean {
  if (s.fields.some((f) => f.required && !f.filled && f.kind !== "file")) return false;
  // Still a job posting (an Apply button is on the page): "Thank you for applying!" there is the description's
  // sign-off, not a receipt.
  if (s.buttons.some((b) => START_RE.test(b.text.trim()) && !b.disabled)) return false;
  // Workday Candidate Home lists past applications ("Suggested Jobs - Based on Jobs You Have Applied to", a "Date
  // Submitted" column): an account page, not this job's receipt.
  if (/\/userHome\b/i.test(s.url) && /my applications/i.test(s.text) && !s.headings.some((h) => CONFIRM_RE.test(h))) return false;
  // The phrase must stand on its own (a heading or a short line), not sit at the end of a long paragraph.
  const standalone = (t: string) => t.split(/\n+/).some((line) => line.trim().length <= 160 && CONFIRM_RE.test(line));
  return s.headings.some((h) => CONFIRM_RE.test(h)) || standalone(s.text.slice(0, 4000)) || (CONFIRM_URL_RE.test(s.url) && standalone(s.text));
}

/** Situations only the user can clear. Returns a reason or null. */
export function hardStop(s: Snapshot): string | null {
  const t = s.text.toLowerCase();
  if (s.captcha) return "Solve the CAPTCHA";
  if (/(enter|type) the (verification |security |one[- ]time )?code|verification code (has been |was )?sent|we sent (you )?a code|one-time pass(code|word)/.test(t)) return "Enter the verification code";
  if (/verify your (email|account)|email has been sent to you.*verify|check your (email|inbox) to (verify|activate|confirm)/.test(t) && !s.fields.some((f) => f.kind === "password")) return "Verify the account from the email, then sign in";
  if (/easy apply/.test(t) && /linkedin\.com/.test(s.url)) return "LinkedIn Easy Apply is excluded; apply on the employer site";
  // An assessment the employer requires (Workday "Take Assessment" step): only the candidate can take it.
  if (/you must complete the assessment|complete the assessment test|current step \d+ of \d+\s*take assessment/.test(t) && s.buttons.some((b) => /^take assessment$/i.test(b.text))) return "Take the assessment, then click Save and Continue";
  return null;
}

export function pageSignature(s: Snapshot): string {
  return [s.url.split("?")[0], s.headings.join("|"), s.fields.map((f) => f.label).sort().join("|").slice(0, 2000)].join("#");
}
