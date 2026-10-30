# apply-harness

Fills job applications in parallel in your own Chrome and **stops at the final Submit**. You look over each filled form, solve any CAPTCHA, and click Submit yourself. The harness detects the confirmation page and records the application in a local job tracker.

- **Answers come from your own profile**: a structured answer bank (`data/answers.json`) plus a free-text facts file (`data/facts.md`). Deterministic rules handle contact details, work authorization, EEO and standing yes/no questions. A model handles the rest and writes short answers to open questions. It's told never to invent anything.
- **Bring your own model**: the default is **Claude through the Claude Code CLI**, so it runs on your Claude subscription (Pro/Max) or an Anthropic API key, with no cloud project needed. **Google Gemini** (an AI Studio API key or Vertex AI) is the alternative.
- **Local job tracker**: postings you want to apply to live in `data/jobs.json`, with no Notion or other external service. Add them from the dashboard, the command line, or any job-search tool or agent that writes the [tracker format](docs/tracker.md).
- **Never submits for you.** The final Submit button is refused in code. Account passwords never go to the model, which only sees placeholder tokens.

> Use it responsibly: review every application before you submit it, and respect each site's terms. LinkedIn Easy Apply isn't supported.

## How it works

```
data/jobs.json ─► dashboard queue ─► Chrome tab per job ─► fill page by page ─► stop at Submit
                                        │                                   │
                       rules → agreements → memory → model         you review + click Submit
                                        │                                   │
                          rescue agent for stuck pages          confirmation detected → tracker: applied
```

Each field gets its answer from the first of these that applies:

1. **Rules** in `data/answers.json` (regex on the question, first match wins): name, email, phone, address, links, work authorization, EEO, standing answers such as "Have you been convicted of a felony?". Some questions are always flagged for you, never guessed (SSN, for example).
2. **Agreement checkboxes** (terms, privacy, certify-accurate) are ticked. Marketing and SMS opt-ins are left unticked unless required.
3. **Learned memory** (`data/field-memory.jsonl`): earlier answers to the same question with the same options.
4. **The model** answers whatever is left from your facts and answer bank, or flags it for you. Open-ended questions get a separate writing pass with a quality check.
5. **A rescue agent** takes over a page the engine can't advance, and handles Workday's "My Experience" page. It can't click the final Submit.

Adapters: Greenhouse (including embedded boards), Lever, Ashby, Workday (Apply Manually, plus account create and sign-in with a per-site record in `data/accounts.json`) and Oracle. Every other site runs on the generic engine plus the rescue agent. Employer career pages that hand off to a known ATS switch adapters automatically.

## Quick start

You need **Node 22+**, **Google Chrome**, and one model provider (see below).

```bash
git clone https://github.com/jaks024/apply-harness.git
cd apply-harness
npm install
```

Then set up your profile. Pick one of these:

- **Guided (recommended):** open the folder in **Claude Code**, either the desktop app's Code tab or the `claude` CLI, and type **`/setup`**. Claude interviews you, reads your resume, fills in `data/`, chooses the model provider with you, and runs the checks. Other coding agents (Codex, Cursor and so on) can follow [`.claude/commands/setup.md`](.claude/commands/setup.md) when you ask them to "run the setup in .claude/commands/setup.md".
- **By hand:** follow [SETUP.md](SETUP.md).

Then:

```bash
npm run setup:check   # what's still missing
npm run test:llm      # the model provider answers
npm run ui            # dashboard at http://localhost:4321
```

## Model providers

| Provider | What you need | Set in `.env` |
|---|---|---|
| `claude-cli` (default) | [Claude Code](https://claude.com/claude-code) installed and logged in (`claude`, then `/login`). It uses your Claude plan or `ANTHROPIC_API_KEY`. If you use the Claude desktop app, install the CLI as well: the harness calls `claude -p`. | nothing, or `CLAUDE_BIN=` if `claude` isn't on your PATH |
| `gemini` | A Google AI Studio API key, or a Google Cloud project with Vertex AI and `gcloud auth application-default login` | `LLM_PROVIDER=gemini`, then `GEMINI_API_KEY=` or `GOOGLE_CLOUD_PROJECT=` |

Models are set per provider in `config/config.json` (`llm.claude-cli.fieldModel` / `agentModel`, default `haiku` / `sonnet`), or for one run with `FIELD_MODEL=` / `AGENT_MODEL=`. The *field* model answers form fields in batches. The *agent* model writes open answers and drives the rescue agent.

On Windows, `claude` from the native installer (`claude.exe`) works as is. If you installed with npm, set `CLAUDE_BIN` to the package's `cli.js` (for example `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\cli.js`), because Windows can't start npm's `.cmd` shim without a shell.

## Using the dashboard

```bash
npm run ui
```

It opens http://localhost:4321, bound to your machine only. Leave the terminal open while you work.

- **Job tracker**: your `new` and `interested` jobs, grouped by the day they were added. Tick jobs and press **Queue selected**, or paste URLs below. **Add to tracker** saves them for later; **Queue now** starts them. Jobs you've already applied to (by posting URL, job key, or company + role) are hidden by default.
- **Running at once** sets how many tabs fill at the same time (up to 16). With **Review tabs use a slot** on, a filled form waiting for your Submit counts toward the limit.
- Cards show flagged fields, written answers worth a look, and the log. **Show tab** brings that tab to the front, **Skip** closes it, **Retry** re-queues it, **Apply anyway** overrides a duplicate match, and **Not submitted — restart** undoes a wrong "submitted".
- Submissions are detected automatically. The tracker marks the job `applied`, and `data/ledger.jsonl` keeps a receipt. The queue is saved, and after a restart it comes back paused.

## Command line

```bash
npm run add-job -- https://job-boards.greenhouse.io/acme/jobs/123 --company Acme --role "Data Analyst"
npm run add-job -- --file urls.txt        # lines of "url | company | role"
npm run apply -- <url> [url...]           # fill these without the dashboard
npm run apply                             # every URL in data/queue.txt
npm run status                            # tracker and ledger counts, latest run
npm run chrome                            # the harness's Chrome profile, by hand (sign in to your email there)
```

Tab titles show each job's state: **✅ READY** (stopped at Submit), **⚠ NEEDS YOU** (a CAPTCHA, a verification code or a stuck page; it continues once you clear it), **⚠ HANDOFF** (finish by hand) and **✔ SUBMITTED**. Per-job logs are in `data/runs/<run>/<job>/`: `log.txt`, `fields.json` (every value and where it came from), `review.png` and `receipt.json`.

## Your data

Everything personal stays in `data/` and `.env`, and git ignores both: your profile, resume, account passwords, the tracker, the ledger, run logs and the Chrome profile. The model sees your answer bank and facts, but not your account passwords. Credentials in `data/answers.json` are stored as plain text on your machine, so keep the folder private and use passwords you don't reuse elsewhere.

## Tests

```bash
npm run test:match     # option matcher (offline)
npm run test:sponsor   # "won't sponsor" detector (offline)
npm run test:llm       # the model provider, 3 small calls
npm run test:resolver  # standard screening questions against your answer bank
npm run test:engine    # end-to-end fill of a local two-page practice form
npm run test:agent     # the rescue agent completes the practice form, stops before Submit
npm run typecheck
```

## License

MIT
