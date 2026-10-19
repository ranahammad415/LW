/** v1.5.6 §32.1: deciding whether a revokePrev rotation is confirmed by the site's health.keys. */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: {} }));
vi.mock('../../../src/lib/notificationService.js', () => ({ notify: vi.fn(), notifyTest: vi.fn() }));
vi.mock('../../../src/lib/contentMapSync.js', () => ({ reconcileProjectMapsSafe: vi.fn(), mirrorPipelineToMaps: vi.fn() }));

import { revokeConfirmOutcome } from '../../../src/lib/emdashSync.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (n) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', n + '.json'), 'utf8'));

describe('revokeConfirmOutcome', () => {
  const rotatedAt = new Date('2026-10-19T09:00:00Z');
  it('confirms the contract example (keyId = new id, fresh prevRevokedAt)', () => {
    expect(revokeConfirmOutcome(ex('health.response--prev-revoked'), { keyId: 3, rotatedAt })).toMatchObject({ ok: true });
  });
  it('refuses another key id, a stale or missing prevRevokedAt and an older site without keys', () => {
    const h = ex('health.response--prev-revoked');
    expect(revokeConfirmOutcome(h, { keyId: 4, rotatedAt }).code).toBe('KEY_MISMATCH');
    expect(revokeConfirmOutcome({ ...h, keys: { ...h.keys, prevRevokedAt: '2026-10-18T09:00:00Z' } }, { keyId: 3, rotatedAt }).code).toBe('PREV_NOT_REVOKED');
    expect(revokeConfirmOutcome({ ...h, keys: { ...h.keys, prevRevokedAt: null } }, { keyId: 3, rotatedAt }).code).toBe('PREV_NOT_REVOKED');
    expect(revokeConfirmOutcome({ ok: true }, { keyId: 3, rotatedAt }).code).toBe('NO_KEY_STATE');
  });
});
