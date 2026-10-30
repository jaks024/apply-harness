---
description: Guided setup. Builds your answer bank and facts from your resume and a short interview, picks the model provider, and runs the checks.
---

# /setup: guided setup for apply-harness

You are setting up apply-harness for the person you're talking to. They may not be technical, so keep each message short, ask a few questions at a time, and do the file work yourself. Everything you write goes into `data/` and `.env`. Git ignores both, and they must never be committed, pasted elsewhere, or sent anywhere except the model provider the user picks.

Ground rules:
- **Never invent facts.** Every value comes from the user or from a document they gave you. If you don't know something, ask, or leave it empty (empty values are skipped or flagged at review, never guessed).
- **Statements about the user need their explicit yes.** That covers criminal history, relatives at the employer, drug screening, background checks, disability, veteran status, race, gender and sponsorship. For each one, say what the form will answer and let them change it. Offer "Decline to answer" for every voluntary self-identification question.
- **Passwords:** don't ask the user to paste a password into the chat. Offer to generate one locally and write it straight into the file without printing it (step 5), or let them type it into `data/answers.json` themselves.
- Re-run `npm run setup:check` at the end and fix what it reports.

## 1. Prepare

1. Check Node: `node --version` must be 22 or newer. If not, point them to https://nodejs.org and stop until it's installed.
2. Run `npm install`, then `npm run setup`, which creates `data/answers.json`, `data/facts.md`, `data/jobs.json` and `.env` from `examples/` without overwriting anything that exists.
3. If `data/answers.json` already has real (non-example) details, this is a re-run: ask what they want to change instead of starting over.

## 2. Resume

Ask for their resume (a PDF path, or pasted text). Copy the PDF to `data/resume/resume.pdf`; this is the file the harness uploads. Read it, and offer to copy a transcript to `data/resume/transcript.pdf` too (used only when a form requires one). From the resume, draft:
- `identity` (name, email, phone, LinkedIn and other links),
- `education` (most recent first; `start`/`end` as YYYY-MM; `expected: true` for a degree in progress),
- `experience` (each job's title, employer, location, dates, and a `description` with its bullets as `- ` lines),
- `skills`.

Show a compact summary and ask them to confirm or correct it. Ask about anything the resume doesn't settle: legal versus preferred first name, a phone number in the format they want typed, and dates the resume leaves vague.

## 3. Interview

Ask in small groups and write the answers into `data/answers.json` (see `docs/answers.md` for every field):

1. **Address**: street, apartment, city, state, zip, country. Also set `address.city_state` ("City, ST") and `address.full`.
2. **Work authorization**: authorized to work in the US (or their country)? Need visa sponsorship now or in the future? Authorized without sponsorship? US citizen or permanent resident? Citizenship. If they need sponsorship, explain that postings saying "we don't sponsor" will be skipped automatically.
3. **Availability**: earliest start date (write `start_date` as YYYY-MM-DD plus `start_date_text`) and notice period.
4. **Education details for picky forms**: for each school, which fields of study they'd accept if the form's list lacks their exact major (`field_alternates`), other names the school goes by (`school_aliases`), and similarly named schools that must never be picked (`never_schools`).
5. **Voluntary self-identification (EEO)**: gender, Hispanic/Latino, race, veteran status, disability, sexual orientation. Each can be "Decline to answer". If they give a race, also set `eeo.race_groups` (and `race_subgroup` if relevant) for forms that show one checkbox per group.
6. **Compensation**: an hourly minimum, if they want one, for internship rate questions (`compensation.hourly_minimum`). Their previous salary if they want salary-history questions answered (otherwise leave it blank). Expected-salary questions always use the posting's own range.
7. **Standing answers**: go through every rule in `data/answers.json` whose note says `CONFIRM during setup`. Read each one in plain words ("Have you been convicted of a crime? → No") and ask yes or change. Update the `answer`, then delete the `note`. Remove the "currently a student" rule or change its answer if it doesn't fit them.
8. **Voice**: how written answers should sound (`writing_voice`), and any extra instructions (`llm_instructions`).
9. **How did you hear about us** default (`how_did_you_hear`).

## 4. Facts file

Rewrite `data/facts.md` for them: the resume's text, then sections for background and motivation, preferences (locations, remote/hybrid, relocation), languages, and prior applications if they know any. Keep the dated-updates section. Delete the "FICTIONAL example" heading and every bit of the example candidate. Show it to them before saving.

## 5. Job-site accounts

Many sites (Workday on every employer's site) need an account. Ask which email to use (`accounts.primary_email`) and an optional second one for when the first is already taken (`accounts.fallback_email`). For the password, offer to generate one locally and write it into the file without showing it:

```bash
node -e "const f='data/answers.json',fs=require('fs'),c=require('crypto');const a=JSON.parse(fs.readFileSync(f,'utf8'));const p=c.randomBytes(12).toString('base64url')+'!a1';a.accounts.password=p;a.accounts.short_password=p.slice(0,12)+'!a1';fs.writeFileSync(f,JSON.stringify(a,null,2)+'\n');console.log('password written to data/answers.json')"
```

Tell them where it's stored (in plain text in `data/answers.json`, never sent to the model) so they can use it to sign in to job sites themselves. If they'd rather set their own, have them edit the file.

## 6. Model provider

Explain the two options and set what they pick:

- **Claude (default; recommended if they use Claude Desktop or Claude Code).** The harness runs `claude -p` with their own login, so it uses their Claude plan or an Anthropic API key. Check `claude --version`. If it isn't found, have them install Claude Code (https://claude.com/claude-code), run `claude` once and `/login`, or set `CLAUDE_BIN` in `.env` to the binary's path. Desktop-app users still need the CLI installed, since the harness calls it from the terminal. Default models are `haiku` for form fields and `sonnet` for written answers and the rescue agent. Offer `sonnet`/`opus` via `config/config.json` (`llm.claude-cli`) if they want higher quality and have the usage to spare.
- **Gemini.** In `.env`, set `LLM_PROVIDER=gemini` plus `GEMINI_API_KEY=` (from Google AI Studio) or `GOOGLE_CLOUD_PROJECT=` for Vertex AI (then `gcloud auth application-default login`).

Then run `npm run test:llm`. If it fails with an authentication error on claude-cli, have them run `claude` in their own terminal and log in, then try again. Note that a `claude -p` started from inside this agent session may not see their login; if `test:llm` fails here but `claude -p "hi"` works in their own terminal, have them run `npm run test:llm` there.

## 7. Verify

1. `npm run setup:check`: fix everything it lists.
2. `npm run test:resolver`: walk through any FAIL with them, usually by fixing a value or a rule.
3. `npm run test:engine`: fills a local practice form in Chrome and stops before Submit.
4. Explain the daily flow: `npm run ui`, add postings (paste URLs, or `npm run add-job -- <url> --company X --role Y`), press Start, review each ✅ READY tab, and click Submit themselves. Suggest `npm run chrome` once to sign in to their application email in the harness's Chrome profile, so verification emails are easy to reach.

Finish with a short summary: what's configured, what they chose to leave blank, and the one command to start (`npm run ui`).
