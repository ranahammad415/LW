# EmDash bridge contract fixtures (read-only copy)

Copied verbatim from the framework repo `oasis-astro`, package `packages/os-bridge-contract`,
at commit `77a7d6a` ("Contract v1.0.4: siteId-scoped events, disconnect, block _version, preview secret"; contract v1, errata v1.0.4):

| Folder | Source |
| --- | --- |
| `schemas/` | `packages/os-bridge-contract/schemas/*.json` (JSON Schema 2020-12) |
| `examples/` | `packages/os-bridge-contract/examples/*.json` (one valid payload per schema) |
| `vectors/` | `packages/os-bridge-contract/vectors/signature-vectors.json` (HMAC test vectors; v1.0.3 adds the counterFloor pairing response, v1.0.4 the disconnect handshake) |

The contract spec itself is `packages/os-bridge-contract/contract.md` in that repo; the OS-side summary
is `docs/ledger/emdash-bridge.md`. Keys in these files are public test values (vector keys are
`aosk1_` + base64url(sha256(label))); nothing here is a real secret.

Do not edit these files by hand. When the contract changes, copy the new files from the framework repo,
update the commit above, and re-run `npm run test:backend`.
