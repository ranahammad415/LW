# Google Knowledge Extractor — Usage

Internal read-only MVP: start from one root Google Doc URL, recursively extract linked Docs, Sheets, and Drive files into a structured knowledge package for task/update import (Phase 2).

## Prerequisites

1. Enable in Google Cloud Console:
   - Google Drive API
   - Google Docs API
   - Google Sheets API

2. Configure auth in `backend/.env` (one of):

```env
# Option A — service account (share docs with this email as Viewer)
GOOGLE_SERVICE_ACCOUNT_KEY=C:/path/to/service-account.json

# Option B — OAuth refresh token (PM/Owner account with access)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_WORKSPACE_REFRESH_TOKEN=...
GOOGLE_WORKSPACE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
```

Optional limits:

```env
EXTRACT_MAX_DEPTH=8
EXTRACT_MAX_FILES=200
EXTRACT_RATE_LIMIT_MS=120
EXTRACT_MAX_SHEET_ROWS=500
```

## CLI

```bash
cd Localwaves/backend

# First run
node prisma/extract-google-knowledge.cjs \
  --rootUrl "https://docs.google.com/document/d/YOUR_DOC_ID/edit" \
  --out extractions/client-june-2026

# Dry run (discover file IDs only)
node prisma/extract-google-knowledge.cjs --rootUrl "..." --dryRun

# Filter month bundle
node prisma/extract-google-knowledge.cjs --rootUrl "..." --month 2026-06

# After sharing blocked files (see access-needed.json)
node prisma/extract-google-knowledge.cjs --resume --out extractions/client-june-2026
```

## Output package

Written to `backend/extractions/{runId}/` (gitignored):

| File | Purpose |
|------|---------|
| `manifest.json` | Run metadata, graph, stats |
| `index.json` | Sorted catalog (depth → sheets → docs) |
| `tree.md` | Indented link tree |
| `nodes/{fileId}.json` | Structured node |
| `nodes/{fileId}.md` | Human-readable export |
| `sheets/{fileId}/*.csv` | Per-tab CSV |
| `organized/task-sources.json` | Likely task plan files |
| `organized/update-sources.json` | Likely progress update files |
| `month-bundle.json` | Month-scoped task/update grouping |
| `access-needed.json` | Files to share, then `--resume` |
| `report.md` | Summary report |

## Admin API (OWNER only)

```http
POST /api/admin/extract/google
Authorization: Bearer <owner-jwt>
Content-Type: application/json

{
  "rootUrl": "https://docs.google.com/document/d/.../edit",
  "maxDepth": 8,
  "maxFiles": 200,
  "month": "2026-06"
}
```

Resume:

```json
{ "resume": true, "outDir": "extractions/client-june-2026" }
```

## Access handoff

1. Run extraction.
2. If `access-needed.json` lists files, share each (or parent folder) with the service account email printed at CLI start.
3. Re-run with `--resume --out <same folder>`.

## Phase 2 — Map & import into Localwaves

After extraction, map the package to `agency-data v1.1` and import tasks + progress:

```bash
# Heuristic map (reads organized/task-sources.json + sheet CSVs)
npm run map:extraction -- --extractionDir extractions/client-june-2026 --projectMatch "Roman Electric"

# AI-refined map (requires ANTHROPIC_API_KEY)
npm run map:extraction -- --extractionDir extractions/client-june-2026 --projectMatch "Roman" --ai --out agency-data.roman.json

# Dry-run import
npm run import:agency -- --file extractions/client-june-2026/agency-data.mapped.json --dryRun

# Live import
npm run import:agency -- --file agency-data.roman.json --confirm
```

Admin API (OWNER):

```http
POST /api/admin/import/map-extraction
{ "extractionDir": "extractions/client-june-2026", "projectMatch": "Roman Electric", "useAi": false }

POST /api/admin/import/agency-data
{ "filePath": "extractions/client-june-2026/agency-data.mapped.json", "dryRun": true }
```

See `prisma/data-import/DATA_AGENT_PROMPT.md` and `AGENCY_DATA_SPEC.md` for the JSON contract.
