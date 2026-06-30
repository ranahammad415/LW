# Phinix → Agency OS Upload (June 2026)

Uploads all 7 Phinix client task plans from Google Sheets into Localwaves Agency OS:
tasks, assignees, **task comments** (from completion details), and **status** (Completed / In Progress / To Do).

## Source spreadsheets

| Project | Spreadsheet |
|---------|-------------|
| Roman Electric Q2 | `1N-RbkXB9rSXqYiGkaJc3p5ARwIzQkFmgwOdcVgmcLU0` |
| Milwaukee Signs Q2 | `1rYzJpiYc7Miw9VuJ-PnSZ4dgZGrGfMyKJkVmpcG_igI` |
| P2EzPay Q2 | `1jnCPtFqC6CIBkWj-A6VA7ZdnWfrHjKfz96_5a3qnW-g` |
| Great Lakes Power Vac Q1 | `1oztGtps4U7PejoEtTS8poz4haAbDRYNEgKffeY1xlY0` |
| Keyway Broaching Q1 | `1tpCB4K-1vOkV0HWGn_Mb74bm6jl7Z7KlrXsb0NUleH4` |
| Wilhelmina Balloon Q1 | `1MXgTYYt4IO_ORvPmD8d21cc3kXFOYO5LjV7zKbMiO-M` |
| SouthGate Lease | `1o95Y5k-XyDuGr6bjnMRDm-z0uGva3ON_UpVAgU6W0z0` |

Master index: `1QKeal5ODU-6Wy4p0fbiZr_e6NoMAX_RtWzyK0hbpeck`

## Prerequisites

1. Localwaves DB running with projects seeded (Roman Electric, Milwaukee Signs, etc.)
2. Team users in DB (`npm run db:seed` or `seed-team.js`)
3. Sheets must be **publicly readable** (Anyone with link → Viewer) for gviz CSV export
4. Optional: add `haider@thephinixsolutions.com` to DB if Haider tasks should assign to him (otherwise falls back to PM)

## Commands

```bash
cd Localwaves/backend

# 1. Build JSON only (review before import)
npm run build:phinix

# 2. Preview import (no DB writes)
npm run upload:phinix

# 3. Live import — creates tasks + comments + statuses
npm run upload:phinix -- --confirm

# Single project only
node prisma/upload-phinix-to-agency-os.cjs --project "Roman Electric" --confirm

# Re-import from saved JSON (skip Google fetch)
node prisma/upload-phinix-to-agency-os.cjs --skipBuild --file prisma/data-import/agency-data.phinix-june-2026.json --confirm
```

## What gets created

| Sheet field | Agency OS |
|-------------|-----------|
| Main Task | Milestone (parent task group) |
| Sub Task | Sub-task title |
| Steps | Step checklist items |
| Task Assignee Name / tab name | `assigneeKey` → User |
| Status (Completed / Pending) | Task status |
| Completion Details / File Link | **Task comment** with deliverable notes + **Google Sheet links** |
| Milestone parent | Summary comment + project spreadsheet link in **Attachments** |

## Enrich existing tasks (comments + sheet links)

If tasks show **Completed** but comments/attachments look empty:

```bash
npm run enrich:phinix              # preview
npm run enrich:phinix -- --confirm # apply to all 7 projects
```

This adds:
- Rich deliverable comments on each sub-task (goal, steps, completion notes, sheet URLs)
- **Working sheet** links on parent milestones and sub-tasks
- **TaskAttachment** rows so the Attachments panel shows clickable Google Sheet links

Refresh the project page after running.

## Client PM updates (positive summaries)

Publish client-facing progress narratives to the **Client Dashboard → PM Updates** panel:

```bash
npm run sync:phinix-pm              # preview
npm run sync:phinix-pm -- --confirm # publish / replace import-style updates
```

Summaries are generated from completed milestones and deliverable highlights — plain text, positive tone, no internal tags.

## Output file

`prisma/data-import/agency-data.phinix-june-2026.json` — validates against `agency-data.schema.json`.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `project not found` | Run project seed; check `projectMatch` names in `phinixSheetConfig.js` |
| `Missing required team members` | Run `node prisma/seed-team.js` |
| `Sheet requires Google sign-in` | Share spreadsheet publicly or use `extract:google` with service account |
| Duplicate milestones on re-run | Importer skips existing milestone titles; wipe May tasks first if needed |
