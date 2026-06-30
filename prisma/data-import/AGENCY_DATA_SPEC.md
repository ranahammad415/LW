# Localwaves Agency Data Import — Agent Specification v1.1

> **Purpose:** Your data agent produces a single JSON file following this spec. A future importer reads it and creates/updates projects, tasks, **posts progress as task comments**, and **marks tasks complete or not** based on `projectUpdates`.

**Template file:** `agency-data.template.json`  
**JSON Schema:** `agency-data.schema.json`

---

## 1. Output rules for the data agent

1. **One JSON document** per plan/sync run. Filename suggestion: `agency-data.{planLabel-slug}.{date}.json`
2. **Stable `ref` IDs** — use lowercase kebab-case (`task-meta-optimisation`). Never change a ref once published; importers match on ref during `sync_progress` mode.
3. **Never invent emails** — every `assigneeKey` / `authorKey` must exist in `teamRoster` with a real email from the agency.
4. **Match existing DB projects** via `projectMatch` when the client/project already exists (preferred). Only use `clients[]` when onboarding net-new accounts.
5. **Three-level task hierarchy** (matches current Localwaves UI + May 2026 seeder):

```
taskGroup.milestone  →  Parent / Main task (column group header)
  task.title         →  Sub-task (work item with goal + description)
    step.title       →  Step task (checklist child)
```

6. **`projectUpdates` is required when reporting progress** — this is how the agent communicates what happened; the importer posts each `taskUpdates[].update` as a **task comment** and sets **task status** from `completion`.
7. **Progress on tasks** (`progress` blocks) is the *initial snapshot* at import time. **`projectUpdates` is the source of truth** for comments + final status when both are present (latest `postedAt` wins).
8. **Dates** — ISO 8601 (`2026-06-30` for dates, full timestamp for date-times).

---

## 2. Document structure

```
{
  meta              → plan metadata + import behaviour
  teamRoster        → who can be assigned (key → email)
  clients[]         → optional; for new clients only
  projects[]        → one bundle per project
    projectMatch    → find existing project in DB
    project         → project metadata
    taskGroups[]    → milestones + tasks + steps (the plan)
    projectUpdates[]→ ★ progress reports → comments + status ★
    pmUpdates[]     → client-facing PM weekly summaries (dashboard)
    businessUpdates[] → client business change log
    keywords[]      → optional keyword tracking seeds
}
```

### `projectUpdates` vs `pmUpdates`

| Section | Audience | Importer action |
|---------|----------|-----------------|
| **`projectUpdates`** | Internal / task-level | Post `update` text → **TaskComment**; apply `completion.status` → **Task.status** |
| **`pmUpdates`** | Client dashboard | Insert → **ClientPMUpdate** (high-level narrative only) |

---

## 2b. How project updates drive comments + completion (importer contract)

For **each** `taskUpdates[]` entry inside `projectUpdates[]`:

```
1. Resolve taskRef → Task row (step, sub-task, or milestone parent)
2. Create TaskComment:
     content  = taskUpdate.update
     userId   = authorKey → teamRoster email
     createdAt = postedAt (or reportedAt if omitted)
3. Apply completion:
     if completion.isComplete === true AND completion.needsPmReview !== true
       → Task.status = COMPLETED
     if completion.isComplete === true AND completion.needsPmReview === true
       → Task.status = NEEDS_REVIEW
     if completion.isComplete === false
       → Task.status = completion.status (IN_PROGRESS, BLOCKED, etc.)
4. Log TaskActivityLog:
     action = comment_added + status_change
5. After all taskUpdates in a period, roll up parent tasks:
     all steps COMPLETED     → parent IN_PROGRESS or COMPLETED
     any step IN_PROGRESS    → parent IN_PROGRESS
     any step BLOCKED        → parent BLOCKED
```

**Agent rules when writing `taskUpdates`:**

| Work state | `isComplete` | `status` | Example update text |
|------------|--------------|----------|---------------------|
| Not started | `false` | `TO_DO` | "Not started yet — scheduled for next week." |
| In progress | `false` | `IN_PROGRESS` | "Drafting outreach templates — 40% done." |
| Done, needs PM | `true` | `NEEDS_REVIEW` + `needsPmReview: true` | "Drafts complete — ready for PM review." |
| Fully done | `true` | `COMPLETED` | "Published all meta updates to WordPress." |
| Blocked | `false` | `BLOCKED` | "Blocked waiting on client brand guidelines." + `blockedReason` |
| Waiting on other task | `false` | `WAITING_DEPENDENCY` | "On hold until gap analysis task completes." |

**One `taskRef` may appear in multiple reporting periods** — each becomes a new comment; the **latest** `postedAt` sets the current status.


## 3. Field reference

### `meta`

| Field | Required | Values | Notes |
|-------|----------|--------|-------|
| `version` | yes | `"1.0"` | Schema version |
| `planLabel` | yes | string | e.g. `"June 2026 SEO Plan"` |
| `importMode` | yes | see below | Controls default status handling |
| `generatedAt` | no | ISO datetime | When agent produced file |
| `generatedBy` | no | string | Agent or human name |
| `notes` | no | string | Freeform |

**`importMode` values:**

| Mode | Behaviour |
|------|-----------|
| `plan_only` | Create all tasks as `TO_DO`; ignore `progress` unless explicitly set |
| `plan_with_progress` | Create tasks **and** apply `progress`, `clientInput`, `deliverables`, `comments`, `activity` |
| `sync_progress` | Match existing tasks by `ref` (stored in importer metadata) or title; update status/dates only |

---

### `teamRoster`

Map of short keys used throughout the file.

```json
"mudassar": {
  "email": "mudassar@thephinixsolutions.com",
  "name": "Mudassar Nazar",
  "role": "TEAM_MEMBER",
  "required": true
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `email` | **yes** | Primary lookup — must match `User.email` in DB |
| `name` | no | Fallback lookup (name contains) |
| `role` | no | `PM` \| `TEAM_MEMBER` \| `CONTRACTOR` |
| `required` | no | If `true` and user missing, import aborts |

**Importer resolution order:** email exact match → name contains → project `leadPmKey` fallback.

---

### `projects[]` bundle

#### `projectMatch` (existing projects)

At least one of:

| Field | Example | Matches |
|-------|---------|---------|
| `projectNameContains` | `"Roman Electric"` | `Project.name` contains |
| `clientNameContains` | `"Broaching"` | `ClientAccount.agencyName` contains |

#### `project` metadata

| Field | Required | Enum / notes |
|-------|----------|--------------|
| `name` | yes | Display name |
| `projectType` | yes | `SEO_CAMPAIGN`, `AEO_GEO_CAMPAIGN`, `WEBSITE_DESIGN`, `WEBSITE_DEVELOPMENT`, `SOCIAL_MEDIA_CAMPAIGN`, `ONE_OFF_PROJECT` |
| `status` | no | `SETUP`, `ACTIVE`, `PAUSED`, `COMPLETED`, `ARCHIVED` |
| `leadPmKey` | no | Key from `teamRoster` |
| `wpUrl` | no | WordPress site URL |

---

### `taskGroups[]` → Localwaves mapping

| Agent field | DB / UI |
|-------------|---------|
| `milestone` | **Parent task** `title` |
| `tasks[].title` | **Sub-task** `title` (`parentTaskId` → parent) |
| `tasks[].steps[].title` | **Step task** `title` (`parentTaskId` → sub-task) |
| `tasks[].goal` + `description` | Sub-task `description` as Markdown: `**Goal:** …` |
| All parents in a group | Parent `description` = aggregated Markdown of all sub-tasks (auto-built by importer) |

---

### `tasks[]` work items

| Field | Required | Maps to |
|-------|----------|---------|
| `ref` | yes | Stable ID for sync |
| `title` | yes | `Task.title` |
| `taskType` | yes | `Task.taskType` — see allowed list below |
| `assigneeKey` | yes* | Primary assignee via roster |
| `assigneeKeys` | no | Multiple assignees (`Task.assignees[]`) |
| `priority` | no | `LOW` \| `MEDIUM` \| `HIGH` \| `CRITICAL` |
| `goal` | no | Part of description Markdown |
| `description` | no | `Task.description` |
| `steps[]` | no | Child step tasks |
| `dependsOnRefs[]` | no | `Task` dependency edges (other task `ref`s in same project) |
| `dueDate` | no | `Task.dueDate` |
| `clientVisible` | no | Default `true` |
| `progress` | no | `Task.status` + timestamps |
| `clientInput` | no | `requiresClientInput`, `clientRequestNote`, etc. |
| `deliverables[]` | no | `DeliverableVersion` rows |
| `comments[]` | no | `TaskComment` rows |
| `activity[]` | no | `TaskActivityLog` rows |

#### Allowed `taskType` values

```
content-writing, meta-optimisation, technical-seo, monthly-report,
strategy-call, onboarding-task, crawl-fix, schema-deployment,
content-audit, on-page-seo, local-seo, keyword-research,
link-building, aeo-geo, ux-audit, cro, reporting
```

#### `progress` block

| Field | Maps to |
|-------|---------|
| `status` | `Task.status` |
| `blockedReason` | Stored in activity log detail (no dedicated column yet) |
| `startedAt` | Activity / future `started_at` |
| `completedAt` | Activity / future `completed_at` |
| `percentComplete` | Informational for agent; optional in UI |

**Roll-up rule for agents:** Parent/sub-task status should reflect children:

| Child state | Suggested parent `progress.status` |
|-------------|-----------------------------------|
| All steps `COMPLETED` | `COMPLETED` or `NEEDS_REVIEW` |
| Any step `IN_PROGRESS` | `IN_PROGRESS` |
| Any step `BLOCKED` | `BLOCKED` |
| Dependency not done | `WAITING_DEPENDENCY` |
| None started | `TO_DO` |

---

### `clientInput` (waiting on client)

| Field | Maps to |
|-------|---------|
| `required: true` | `Task.requiresClientInput = true` |
| `requestNote` | `Task.clientRequestNote` + `ClientInputRequest` |
| `status: "PENDING"` | Awaiting client |
| `status: "FULFILLED"` | `clientProvidedInput = true`, `clientProvidedResponse` |
| `clientResponse` | `Task.clientProvidedResponse` |

---

### `deliverables[]`

| Field | Maps to |
|-------|---------|
| `label` | `DeliverableVersion.notes` or filename context |
| `version` | `DeliverableVersion.version` |
| `fileUrl` | `DeliverableVersion.fileUrl` |
| `uploadedByKey` | Resolved to `uploadedById` |
| `uploadedAt` | `DeliverableVersion.createdAt` |

---

### `projectUpdates[]` ★ progress → comments + status ★

Reporting periods (weekly, daily, etc.). **Required when syncing real progress.**

```json
{
  "ref": "pu-week-1",
  "periodLabel": "Week 1 — Jun 23–27",
  "reportedAt": "2026-06-27T17:00:00.000Z",
  "reportedByKey": "hamza",
  "narrative": "Optional summary of the week",
  "taskUpdates": [
    {
      "ref": "tu-step-1",
      "taskRef": "step-authority-1",
      "update": "Prospect list complete — 120 domains uploaded.",
      "authorKey": "mudassar",
      "postedAt": "2026-06-10T16:30:00.000Z",
      "completion": {
        "isComplete": true,
        "status": "COMPLETED",
        "completedAt": "2026-06-10T16:30:00.000Z"
      }
    }
  ]
}
```

| Field | Required | Maps to |
|-------|----------|---------|
| `ref` | yes | Stable ID for this reporting period |
| `periodLabel` | no | Display label only |
| `reportedAt` | yes | When the report was filed |
| `reportedByKey` | yes | PM or lead who filed the report |
| `narrative` | no | Optional; not auto-posted (use `pmUpdates` for client narrative) |
| `taskUpdates[]` | yes | Per-task progress entries |

#### `taskUpdates[]` entry

| Field | Required | Importer action |
|-------|----------|-----------------|
| `ref` | yes | Stable ID for this update line |
| `taskRef` | yes | Match to `task.ref` or `step.ref` in `taskGroups` |
| `update` | yes | **Posted as `TaskComment.content`** |
| `authorKey` | yes | Comment author (`TaskComment.userId`) |
| `postedAt` | no | Comment timestamp (defaults to `reportedAt`) |
| `completion` | yes | Sets **`Task.status`** after comment is posted |

#### `completion` block

| Field | Required | Behaviour |
|-------|----------|-----------|
| `isComplete` | yes | `true` = work finished for this item |
| `status` | yes | Target status after this update |
| `needsPmReview` | no | If `true` + `isComplete`, use `NEEDS_REVIEW` not `COMPLETED` |
| `blockedReason` | no | Appended to activity log when `status` is `BLOCKED` |
| `completedAt` | no | Stored in activity log detail |

---

### `pmUpdates[]` (client dashboard updates)

| Field | Maps to |
|-------|---------|
| `message` | `ClientPMUpdate.message` (Markdown OK) |
| `authorKey` | `ClientPMUpdate.authorId` |
| `createdAt` | `ClientPMUpdate.createdAt` |

---

### `businessUpdates[]`

| Field | Maps to |
|-------|---------|
| `updateType` | `BusinessUpdate.updateType` |
| `details` | `BusinessUpdate.details` |

**`updateType` enum:** `NEW_PRODUCT`, `NEW_LOCATION`, `PRICING_CHANGE`, `TEAM_CHANGE`, `REBRAND`, `SEASONAL`, `OTHER`

---

### `keywords[]` (optional)

| Field | Maps to |
|-------|---------|
| `keyword` | `KeywordTrack.keyword` |
| `volume` | `KeywordTrack.volume` |
| `currentRank` | `KeywordTrack.currentRank` |
| `targetUrl` | `KeywordTrack.targetUrl` |
| `status` | `PROPOSED` \| `APPROVED` \| `TRACKING` \| `PAUSED` |

---

## 4. Importer mapping (what happens when you feed data)

When you provide a filled JSON file, the importer will:

```
1. Validate against agency-data.schema.json
2. Resolve teamRoster → User IDs
3. For each project bundle:
   a. Find project via projectMatch (or create if net-new)
   b. For each taskGroup — create task tree (parent → sub → step)
   c. Apply initial progress.status from task.progress (if importMode allows)
   d. For each projectUpdates[] period (chronological order):
      - For each taskUpdates[] entry:
          → POST TaskComment (update text)
          → PATCH Task.status from completion
          → LOG TaskActivityLog (comment_added, status_change)
      - Roll up parent task statuses from children
   e. Insert pmUpdates → ClientPMUpdate (client dashboard)
   f. Insert businessUpdates → BusinessUpdate
   g. Insert keywords → KeywordTrack
4. Emit summary: tasks created, comments posted, statuses updated
```

> **Note:** The importer script is not built yet. The existing `seed-may-2026-tasks.cjs` already implements steps 3b (plan only, no progress). Your next step is to provide filled JSON; we will wire the importer to this schema.

---

## 5. Minimal valid payload (plan + progress updates)

```json
{
  "meta": {
    "version": "1.1",
    "planLabel": "July 2026 — Roman Electric",
    "importMode": "plan_with_progress"
  },
  "teamRoster": {
    "mudassar": { "email": "mudassar@thephinixsolutions.com", "required": true },
    "hamza": { "email": "hamza@thephinixsolutions.com", "required": true }
  },
  "projects": [
    {
      "ref": "proj-roman",
      "projectMatch": { "projectNameContains": "Roman Electric" },
      "project": {
        "name": "SEO - Roman Electric Co.",
        "projectType": "SEO_CAMPAIGN",
        "status": "ACTIVE"
      },
      "taskGroups": [
        {
          "ref": "grp-reporting",
          "milestone": "Reporting",
          "tasks": [
            {
              "ref": "task-monthly-report",
              "title": "June 2026 monthly performance report",
              "taskType": "monthly-report",
              "assigneeKey": "bisma",
              "steps": [
                { "ref": "step-r-1", "title": "Pull GSC and ranking data" },
                { "ref": "step-r-2", "title": "Draft narrative and send to PM" }
              ]
            }
          ]
        }
      ],
      "projectUpdates": [
        {
          "ref": "pu-week-1",
          "periodLabel": "Week 1",
          "reportedAt": "2026-06-27T17:00:00.000Z",
          "reportedByKey": "hamza",
          "taskUpdates": [
            {
              "ref": "tu-r-1",
              "taskRef": "step-r-1",
              "update": "GSC and ranking data exported for June. Top 20 keywords pulled.",
              "authorKey": "bisma",
              "postedAt": "2026-06-25T14:00:00.000Z",
              "completion": { "isComplete": true, "status": "COMPLETED" }
            },
            {
              "ref": "tu-r-2",
              "taskRef": "step-r-2",
              "update": "Draft in progress — executive summary 50% written.",
              "authorKey": "bisma",
              "postedAt": "2026-06-26T10:00:00.000Z",
              "completion": { "isComplete": false, "status": "IN_PROGRESS" }
            }
          ]
        }
      ]
    }
  ]
}
```

## 5b. Minimal payload (plan only, no updates yet)

```json
{
  "meta": {
    "version": "1.1",
    "planLabel": "July 2026 — Roman Electric",
    "importMode": "plan_only"
  },
  "teamRoster": {
    "mudassar": { "email": "mudassar@thephinixsolutions.com", "required": true }
  },
  "projects": [
    {
      "ref": "proj-roman",
      "projectMatch": { "projectNameContains": "Roman Electric" },
      "project": {
        "name": "SEO - Roman Electric Co.",
        "projectType": "SEO_CAMPAIGN",
        "status": "ACTIVE",
        "leadPmKey": "hamza"
      },
      "taskGroups": [
        {
          "ref": "grp-reporting",
          "milestone": "Reporting",
          "tasks": [
            {
              "ref": "task-monthly-report",
              "title": "June 2026 monthly performance report",
              "taskType": "monthly-report",
              "assigneeKey": "bisma",
              "goal": "Deliver June metrics summary to client.",
              "steps": [
                { "ref": "step-r-1", "title": "Pull GSC and ranking data" },
                { "ref": "step-r-2", "title": "Draft narrative and send to PM" }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

---

## 6. Checklist before handoff

- [ ] Every `assigneeKey` exists in `teamRoster`
- [ ] Every `projectMatch` uniquely identifies one DB project
- [ ] All `dependsOnRefs` point to tasks in the **same** project
- [ ] All `taskUpdates[].taskRef` resolve to a `ref` in `taskGroups`
- [ ] Every completed item has `completion.isComplete: true` and matching `status`
- [ ] `projectUpdates` included for any work already in progress or done
- [ ] `taskType` is from the allowed list
- [ ] `ref` IDs are unique within the file
- [ ] `importMode` matches whether `progress` / `projectUpdates` are included
- [ ] File validates against `agency-data.schema.json`

---

## 7. Related code (for developers)

| File | Role |
|------|------|
| `prisma/seed-may-2026-tasks.cjs` | Current task seeder (plan only) |
| `prisma/tasks-may-2026/*.cjs` | Per-template task arrays |
| `src/routes/tasks.js` | Task API + delete/cleanup patterns |
| `src/schemas/tasks.js` | Zod validation for API creates |
