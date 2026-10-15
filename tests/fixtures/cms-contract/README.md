# EmDash bridge contract fixtures (read-only copy)

Copied verbatim from the framework repo `oasis-astro`, package `packages/os-bridge-contract`,
at commit `10af057` ("Contract v1.0.3: counterFloor, re-pair semantics, dev-only insecure URLs"; contract v1, errata v1.0.3):

| Folder | Source |
| --- | --- |
| `schemas/` | `packages/os-bridge-contract/schemas/*.json` (JSON Schema 2020-12) |
| `examples/` | `packages/os-bridge-contract/examples/*.json` (one valid payload per schema) |
| `vectors/` | `packages/os-bridge-contract/vectors/signature-vectors.json` (HMAC test vectors; v1.0.3 adds the counterFloor pairing response) |

The contract spec itself is `packages/os-bridge-contract/contract.md` in that repo; the OS-side summary
is `docs/ledger/emdash-bridge.md`. Keys in these files are public test values (vector keys are
`aosk1_` + base64url(sha256(label))); nothing here is a real secret.

Do not edit these files by hand. When the contract changes, copy the new files from the framework repo,
update the commit above, and re-run `npm run test:backend`.
