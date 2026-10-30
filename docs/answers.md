# The answer bank: `data/answers.json`

Start from `examples/answers.example.json` (`npm run setup` copies it). Every section except `rules` and `accounts` is also shown to the model as background, along with `data/facts.md`.

## Sections

| Section | Used for |
|---|---|
| `identity` | Names, email, phone (`phone` as typed; `phone_country` for dial-code pickers), links, citizenship, languages, pronouns. |
| `address` | Street, city, state, zip, country. `city_state` is the "City, ST" form for "Where do you live?" questions. |
| `education` | A list, most recent first. Forms with repeating education blocks get the n-th school in the n-th block. Fields: `school`, `degree`, `field`, `start`/`end` (YYYY-MM), `expected` (still in progress), `gpa`, `field_alternates`, `school_aliases`, `never_schools`, `only_if_asked` (for example a high school). |
| `experience` | A list of jobs: `employer`, `title`, `location`, `start`/`end`, `current`, `description` (pasted as is into Workday). `experience_rules` adds instructions for the My Experience page. |
| `experience_summary.total_years` | The answer to "total years of experience". |
| `work_authorization` | `authorized_us`, `requires_sponsorship`, `authorized_without_sponsorship`, `us_citizen_or_permanent_resident`. `requires_sponsorship: "Yes"` also turns on the no-sponsorship posting check. |
| `availability` | `start_date`, `start_date_text`, `notice_period`. |
| `eeo` | `gender`, `hispanic_latino`, `race`, `veteran`, `disability`, `other_sensitive`. For forms that show race as one checkbox per group: `race_groups` (the groups to tick, for example `["Asian"]`) and `race_subgroup` (for example `"East Asian"` where groups are split). |
| `compensation` | `hourly_minimum` (a floor for hourly-rate answers; 0 for none), `previous_salary` (blank to skip salary-history questions). Expected-salary questions use the posting's own range. |
| `how_did_you_hear` | Default "LinkedIn". |
| `writing_voice` | The tone for written answers. |
| `llm_instructions` | Extra rules for the model, one string each. |
| `accounts` | `primary_email`, `fallback_email`, `password`, `short_password` (for sites with a length cap), `alt_password` (for sites that refuse a password containing the email). Never shown to the model. |

## Rules

`rules` is an ordered list. Each field's label is tested against every `pattern` (a case-insensitive regular expression); the **first match wins**. Fields that no rule matches go to memory and then to the model.

| Key | Effect |
|---|---|
| `pattern` | Regex tested against the field label. Required. |
| `unless` | Regex that cancels the match (for example "prior salary" but not "do not list your prior salary"). |
| `answer` | The literal answer. For choice fields, the closest option is picked. |
| `answer_from` | Read the answer from this file by path, for example `identity.email` or `education.0.school`. |
| `alternates` | Fallback answers when no option matches `answer`. |
| `answer_numeric` | The answer for number-only fields. |
| `skip` / `skip_if_optional` | Leave the field blank (always / only when optional). |
| `clear` + `answer_if_required` | Blank the field (wiping a resume parser's guess); a required one gets `answer_if_required`. |
| `flag` | Never answer: show this reason at review instead. |
| `flag_if_missing` | With `answer_from`: flag a required field when the value is empty. |
| `note` | For you. `"CONFIRM during setup"` marks a statement about you that setup asks you to check. |

Standing answers (`answer` rules) are also given to the model and the rescue agent, so they answer the same way when they fill a page themselves.
