# EmDash bridge contract fixtures (read-only copy)

Copied verbatim from the framework repo `oasis-astro`, package `packages/os-bridge-contract`,
at oasis-astro `a8979a1` (contract v1.5.4: service-user role in site-info, `SERVICE_ROLE_INSUFFICIENT`, trashed slug holder, block `defaultValue`, `seo.*` cause; examples `site-info.response--service-role`, `error.response--service-role-insufficient`, `error.response--slug-taken-trashed`, `events.request--seo-cause`; no new vector. v1.5.3 came in `0d75bce`: outbox give-up paused while a migrate pairing waits for the cut-over, `outboxPause` schema, examples `health.response--paused` and `site-info.response--migration-pending`, no new vector; v1.5.2 came in `d7e4aa9`: site-issued page ids, ids on `seo.*` payloads, published review revision, vector 16; v1.5.1 `entry-get includeLayout` came in `0d6cf61`, vector 15; earlier copy at HEAD `2c59003`; contract v1 with errata through v1.5.0: v1.2.1 `5d28192`, v1.3.0 `5b6a2a2`, v1.4.0 `6b19bc7`, v1.5.0 `c777f4c`; v1.1.0 came in 9c62490, v1.0.7 in 18b2b83, the v1.0.6 `live` object in 82476f8, the outline in f2c7b6f). Request vectors 9–13 are signed `pipeline-client-review`, `media-import`, `pipeline-publish`, `proposal-create` and `migration-map`:

| Folder | Source |
| --- | --- |
| `schemas/` | `packages/os-bridge-contract/schemas/*.json` (JSON Schema 2020-12) |
| `examples/` | `packages/os-bridge-contract/examples/*.json` (one valid payload per schema) |
| `vectors/` | `packages/os-bridge-contract/vectors/signature-vectors.json` (HMAC test vectors; v1.0.3 adds the counterFloor pairing response, v1.0.4 the disconnect handshake; v1.0.6 adds the `outline` hash vector) |

The contract spec itself is `packages/os-bridge-contract/contract.md` in that repo; the OS-side summary
is `docs/ledger/emdash-bridge.md`. Keys in these files are public test values (vector keys are
`aosk1_` + base64url(sha256(label))); nothing here is a real secret.

Do not edit these files by hand. When the contract changes, copy the new files from the framework repo,
update the commit above, and re-run `npm run test:backend`.
