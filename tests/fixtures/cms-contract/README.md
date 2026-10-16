# EmDash bridge contract fixtures (read-only copy)

Copied verbatim from the framework repo `oasis-astro`, package `packages/os-bridge-contract`,
at oasis-astro HEAD `2c59003` (the contract package last changed in `bac6426`; contract v1 with errata through v1.5.0: v1.2.1 `5d28192`, v1.3.0 `5b6a2a2`, v1.4.0 `6b19bc7`, v1.5.0 `c777f4c`; v1.1.0 came in 9c62490, v1.0.7 in 18b2b83, the v1.0.6 `live` object in 82476f8, the outline in f2c7b6f). Request vectors 9–13 are signed `pipeline-client-review`, `media-import`, `pipeline-publish`, `proposal-create` and `migration-map`:

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
