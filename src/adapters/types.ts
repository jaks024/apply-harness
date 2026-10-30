import type { Page } from "patchright";
import type { Decision } from "../resolve.js";
import type { Snapshot } from "../scan.js";

export interface JobCtx {
  url: string;
  key: string;
  platform: string;
  company?: string;
  role?: string;
  files: { resume: string; transcript: string };
  runDir: string;
  log: (s: string) => void;
  decisions: Decision[];
  /** Lets an adapter hand off to the user and wait for the page to change. */
  waitForUser: (reason: string) => Promise<boolean>;
  /** Show a status on the dashboard without blocking (e.g. "needs you: verify the email" while the adapter keeps polling). */
  setStatus?: (state: "needs_you" | "filling", note: string) => void;
  rescue: (goal: string) => Promise<"at_review" | "advanced" | "blocked" | "gave_up">;
  resumeUploaded: boolean;
  /** "Role (status)" lines for this company from the job tracker and the local ledger. */
  priorApplications?: string[];
  /** Posting text captured when the job was opened (salary ranges, motivation answers). */
  postingText?: string;
  /** Account policy state: switch to the short password / fallback email after the site rejects the defaults. */
  useShortPassword?: boolean;
  useFallbackEmail?: boolean;
  /** The site refuses a password containing the email: use the other email + "A". */
  useAltPassword?: boolean;
  /** Last address where the page had real content; a stuck tab is reopened there. */
  lastGoodUrl?: string;
  /** "Apply anyway": don't stop on a no-sponsorship statement. */
  ignoreNoSponsorship?: boolean;
  /** Called when the engine swaps a stuck tab for a fresh one, so the job follows the new tab. */
  replacePage?: (p: import("patchright").Page) => void;
}

export interface Adapter {
  name: string;
  /** Navigate from the posting URL to the first page of the application form. */
  start(page: Page, ctx: JobCtx): Promise<Page>;
  /** Platform-specific handling for a page before the generic fill. Return "handled" if it already advanced the page. */
  beforePage?(page: Page, snap: Snapshot, ctx: JobCtx): Promise<"handled" | void>;
}
