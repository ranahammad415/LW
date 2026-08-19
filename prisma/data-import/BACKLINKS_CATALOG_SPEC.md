# Backlinks Hub catalog import spec

The Backlinks Hub catalog is maintained as JSON and upserted into `BacklinkSite`
keyed on `domain`. This lets inventory be refreshed repeatedly without touching
the database by hand and without disturbing existing order history.

## Hard rules

- **USD only.** `priceUsd` is the absolute client-facing price in whole dollars.
  No other currency, cost, or margin field is accepted or stored.
- **No supplier data.** Vendor names, payment terms, batch labels ("New Added -
  8 April"), and availability notes are not part of the schema. Strip them before
  producing the JSON.
- **`domain` is the identity.** Lowercase, no `www.`, no scheme, no path. A repeat
  import of the same domain updates the existing listing rather than duplicating it.

## Document shape

```json
{
  "version": 1,
  "generatedAt": "2026-08-18T09:00:00.000Z",
  "currency": "USD",
  "source": "inventory-august.xlsx",
  "sites": [
    {
      "domain": "theactionelite.com",
      "url": "https://theactionelite.com/",
      "da": 52,
      "dr": 45,
      "monthlyTraffic": 137400,
      "priceUsd": 8,
      "dofollowLinks": 2,
      "placementType": "GUEST_POST"
    }
  ]
}
```

JSON Schema: [`backlinks-catalog.schema.json`](./backlinks-catalog.schema.json)

### Required fields

| Field | Type | Notes |
| --- | --- | --- |
| `domain` | string | Bare hostname, unique. Upsert key. |
| `da` | integer | Domain Authority, 0-100. Out-of-range rows are rejected. |
| `dr` | integer | Domain Rating, 0-100. |
| `monthlyTraffic` | integer | Absolute visits. `"137.4K"`, `"1.5M"`, `"5k+"` are normalized on import. |
| `priceUsd` | number | Must be greater than zero. |

### Optional fields

`url`, `dofollowLinks` (default 1), `placementType` (`GUEST_POST` | `PROFILE`),
`category`, `country`, `language`, `turnaroundDays`, `sampleUrl`, `isActive`
(default true), `isFeatured`, `tags`.

`valueScore` is always recomputed server-side from DA, DR, traffic and price, so
any supplied value is ignored.

## Converting a spreadsheet

`convert-backlinks-xlsx.mjs` turns a supplier price list into a valid catalog
document with zero dependencies. It auto-detects the header row and the
`Website / DA / DR / Traffic / Price / Link Type` columns, ignores every other
column, and writes both the catalog and an audit report.

```bash
node prisma/data-import/convert-backlinks-xlsx.mjs "../inventory.xlsx"
# -> prisma/data-import/backlinks-catalog.json
# -> prisma/data-import/backlinks-catalog.report.json
```

Options:

- `--out <file>` write the catalog somewhere else
- `--rate <pkrPerUsd>` source-currency conversion divisor (default `200`)

Conversion behaviour worth knowing:

- **Price conversion** rounds up: `ceil(amount / rate)`. At the default rate,
  1000 -> `$5` and 1500 -> `$8`, so a converted price never lands under cost.
- **Duplicate domains are merged** into one listing that keeps the **highest**
  price and the strongest metric seen for each field, so a blank in one row is
  filled from its twin. Every collision is listed in the report with both prices.
- **Invalid rows are quarantined**, never silently coerced. A DA of 261 or a
  missing price puts the row in `rejectedRows` with a reason instead of importing it.
- **Link type** maps to `{ dofollowLinks, placementType }`; anything containing
  "sample" becomes a `PROFILE` placement.

Always read `backlinks-catalog.report.json` before importing. `totals.rejected`
should be a number you recognise and accept.

## Importing

Owner-only endpoint, dry run by default:

```http
POST /api/admin/backlinks/import
{
  "filePath": "prisma/data-import/backlinks-catalog.json",
  "dryRun": true,
  "mode": "merge"
}
```

Pass the document inline as `data` instead of `filePath` when uploading from the
admin UI. `filePath` is resolved relative to the backend root.

- `mode: "merge"` (default) only touches domains present in the payload.
- `mode: "replace"` additionally **deactivates** any active site missing from the
  payload. It never deletes rows, because order items reference them.

The response summary reports `created`, `updated`, `unchanged`, `deactivated`,
`mergedDuplicates`, `priceChanges` and `errors`. Run with `dryRun: true`, review
`priceChanges`, then re-send with `dryRun: false`.
