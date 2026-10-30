# apply-harness

A local tool that fills job applications in the user's own Chrome and stops at the final Submit. TypeScript on Node 22, Patchright (a Playwright fork) for the browser, and a pluggable model provider (`src/llm.ts`: the Claude Code CLI or Gemini).

## First run

If `data/answers.json` is missing or still holds the example candidate ("Jordan Rivera", jordan.rivera@example.com), the user hasn't been set up yet: offer to run the guided setup in `.claude/commands/setup.md` (`/setup`).

## Hard rules

- **Never click, or make code click, a final Submit / Submit Application button.** The user submits every application personally. `isFinalSubmit` in `src/engine-rules.ts` and the agent's click guard enforce this; keep them.
- **Never invent candidate facts.** Answers come from `data/answers.json`, `data/facts.md` and the resume; unknown required answers are flagged for the user.
- Never fill a Social Security number. Never use CAPTCHA-solving services. LinkedIn Easy Apply isn't supported.
- Credentials (`accounts` in `data/answers.json`) never go into a model prompt; the agent sees tokens (EMAIL, PASSWORD…) that the harness substitutes at fill time.
- Everything personal stays in `data/` and `.env` (git-ignored). Don't commit them, copy them elsewhere, or paste their contents into issues or logs you share.
- Don't test changes on postings the user is about to apply to: Workday keeps drafts, so a test run leaves answers behind on the real application.

## Layout

- `src/engine.ts`: the page loop (scan → resolve → fill → next), stuck handling, stop at review.
- `src/scan.ts`: in-page field and button scanner (shadow DOM and iframes); `src/fill.ts` fills fields by kind.
- `src/resolve.ts`: the answer pipeline (rules → agreements → education builtins → memory → model) and the written-answer pass.
- `src/agent.ts`: the rescue agent (tool loop over observe / fill / click / press / wait / finish).
- `src/llm.ts`: providers. `json` (structured), `text`, `agentStep` (tool calls); claude-cli passes tool calls as JSON through `--json-schema`.
- `src/adapters/`: per-ATS start/account logic (Workday account flow, My Experience brief).
- `src/tracker.ts`: the local job tracker (`data/jobs.json`); `src/store.ts`: ledger, accounts, duplicate check.
- `src/manager.ts`, `src/server.ts`, `ui/index.html`: the dashboard (queue, slots, review watch, confirmation detection).
- `scripts/`: tests and the setup checker; `scripts/debug-run.ts <url>` runs one live posting in a throwaway profile and stops at review.

## Checks

`npm run typecheck`, `npm run test:match`, `npm run test:sponsor` (offline); `npm run test:llm`, `npm run test:resolver`, `npm run test:engine`, `npm run test:agent` (use the model).
