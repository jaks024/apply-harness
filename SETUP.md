# Setup by hand

The guided route does all of this with you: open the folder in Claude Code and type `/setup`. This page covers the same steps if you'd rather do them yourself.

## 1. Install

- [Node.js 22+](https://nodejs.org) and Google Chrome.
- `npm install` in this folder.
- `npm run setup` creates `data/` from `examples/` (it never overwrites your files) and lists what's left.

## 2. Pick a model provider

**Claude (default).** Install [Claude Code](https://claude.com/claude-code), run `claude` once and log in with `/login`. That's all: the harness calls `claude -p` with your login, which uses your Claude plan's usage or an `ANTHROPIC_API_KEY`. If `claude` isn't on your PATH, set `CLAUDE_BIN` in `.env`.

**Gemini.** In `.env`, set `LLM_PROVIDER=gemini` plus either:
- `GEMINI_API_KEY=` (from Google AI Studio), or
- `GOOGLE_CLOUD_PROJECT=` (Vertex AI), after `gcloud auth application-default login`.

Check it with `npm run test:llm`.

## 3. Your answer bank: `data/answers.json`

Replace every value of the fictional "Jordan Rivera" with yours. See [docs/answers.md](docs/answers.md) for each section and the rule format. In short:

- `identity`, `address`: exactly as you want them typed into forms.
- `education`: most recent first. `expected: true` marks a degree still in progress. `field_alternates` lists stand-ins you accept when a form's list lacks your exact major. `school_aliases` and `never_schools` keep look-alike schools out.
- `experience`: every job, worded the way you want it pasted into Workday's My Experience.
- `work_authorization`: `authorized_us`, `requires_sponsorship`, `authorized_without_sponsorship`, `us_citizen_or_permanent_resident`. If `requires_sponsorship` is `Yes`, the harness also skips postings that say they won't sponsor.
- `eeo`: your answers to voluntary self-identification questions, or "Decline to answer".
- `accounts`: the email and password the harness uses to create job-site accounts (Workday creates one per employer). Use a password you don't use anywhere else. It's stored in plain text on your machine and never sent to the model.
- `rules`: most of these read from the sections above (`answer_from`), so you rarely touch them. The ones marked `"note": "CONFIRM during setup"` are statements about you (criminal history, relatives at the company, drug screen, background check). Check each one is true for you, change the answer if it isn't, then delete the note.

## 4. Your facts: `data/facts.md`

Paste your resume's text, then add anything a form might ask that the answer bank doesn't cover: motivation, preferences, languages, past applications. The model reads this file for answers and written responses, so keep it to facts you're happy to see in an application.

## 5. Your resume

Put the PDF at `data/resume/resume.pdf`, or point `paths.resume` in `config/config.json` at it. A transcript at `data/resume/transcript.pdf` is optional; it's only uploaded when a form requires one.

## 6. Check and try it

```bash
npm run setup:check
npm run test:resolver   # standard questions against your answers
npm run test:engine     # fills a local practice form, stops before Submit
npm run ui
```

The first run opens a fresh Chrome profile (`data/chrome-profile`). Run `npm run chrome` once to sign in to the email you use for applications, so you can read verification emails there.

## 7. Add jobs

- Paste posting URLs in the dashboard (**Add to tracker** or **Queue now**), or
- `npm run add-job -- <url> --company X --role Y`, or
- have your job-search tool or agent write `data/jobs.json` in the [tracker format](docs/tracker.md).
