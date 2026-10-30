# The job tracker: `data/jobs.json`

One JSON array, one object per posting. The dashboard lists the `new` and `interested` ones. Submissions set `applied`, and the duplicate check skips anything `applied`, `interview`, `offer` or `rejected`.

You can edit the file by hand, or have a job-search script or an AI agent write it. Only `url` is required; the harness fills in the rest (`id`, `key`, timestamps, `events`) the next time it reads the file.

```json
[
  {
    "url": "https://job-boards.greenhouse.io/acme/jobs/123",
    "company": "Acme",
    "role": "Data Analyst",
    "status": "new",
    "location": "Remote (US)",
    "priority": "high",
    "notes": "Referral from a friend",
    "source": "my-job-search-agent",
    "posted_at": "2026-10-01"
  }
]
```

| Field | Meaning |
|---|---|
| `url` | The posting (or its application page). Required. |
| `company`, `role` | Shown in the dashboard, and used for the company + role duplicate check. |
| `status` | `new`, `interested`, `applied`, `interview`, `offer`, `rejected`, `pass` or `closed`. Default `new`. |
| `location`, `priority`, `notes`, `source`, `posted_at` | Optional; shown or used for sorting. |
| `id`, `key`, `added_at`, `updated_at` | Filled in by the harness. `key` is the canonical job key (for example `greenhouse:acme:123`). |
| `events` | The history the harness appends: added, submitted, passed, closed, corrections. |

Rules for tools that write the file:

- Write the whole array back as valid JSON. The harness writes with write-then-rename, so a reader never sees half a file. Do the same, and don't write while a run is recording a submission.
- Don't change `status` on records you didn't create, except to move them along (`applied` → `interview` and so on).
- To add jobs without touching the file, run `npm run add-job -- <url> --company X --role Y`, or POST `{ "items": [{ "url": "…" }] }` to `http://localhost:4321/api/tracker/add` while the dashboard runs.

Receipts for each submission are also written to `data/ledger.jsonl` (append-only) and `data/runs/<run>/<job>/receipt.json`.
