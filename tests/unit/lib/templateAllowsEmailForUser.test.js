import { describe, it, expect } from 'vitest';
import { templateAllowsEmailForUser } from '../../../src/lib/notificationService.js';

const mkTemplate = (overrides = {}) => ({
  emailAgencyOwner: true,
  emailPm: true,
  emailClientManager: true,
  emailClientViewer: true,
  ...overrides,
});

describe('templateAllowsEmailForUser', () => {
  it('OWNER is gated by emailAgencyOwner', () => {
    const t = mkTemplate({ emailAgencyOwner: false });
    expect(templateAllowsEmailForUser(t, { role: 'OWNER' })).toBe(false);
    expect(
      templateAllowsEmailForUser(mkTemplate(), { role: 'OWNER' })
    ).toBe(true);
  });

  it('PM / TEAM_MEMBER / CONTRACTOR are gated by emailPm', () => {
    const t = mkTemplate({ emailPm: false });
    for (const role of ['PM', 'TEAM_MEMBER', 'CONTRACTOR']) {
      expect(templateAllowsEmailForUser(t, { role })).toBe(false);
      expect(templateAllowsEmailForUser(mkTemplate(), { role })).toBe(true);
    }
  });

  it('CLIENT Manager is gated by emailClientManager, in-app unaffected', () => {
    const t = mkTemplate({ emailClientManager: false });
    const user = { role: 'CLIENT', clientAccess: [{ role: 'MANAGER' }] };
    expect(templateAllowsEmailForUser(t, user)).toBe(false);
    expect(
      templateAllowsEmailForUser(mkTemplate(), user)
    ).toBe(true);
  });

  it('CLIENT Viewer is gated by emailClientViewer, not emailClientManager', () => {
    const user = { role: 'CLIENT', clientAccess: [{ role: 'VIEWER' }] };
    // Manager=false should NOT block a Viewer
    expect(
      templateAllowsEmailForUser(mkTemplate({ emailClientManager: false }), user)
    ).toBe(true);
    // Viewer=false blocks the Viewer
    expect(
      templateAllowsEmailForUser(mkTemplate({ emailClientViewer: false }), user)
    ).toBe(false);
  });

  it('CLIENT without ClientUser rows defaults to MANAGER semantics', () => {
    const user = { role: 'CLIENT', clientAccess: [] };
    expect(
      templateAllowsEmailForUser(mkTemplate({ emailClientManager: false }), user)
    ).toBe(false);
    expect(
      templateAllowsEmailForUser(mkTemplate({ emailClientViewer: false }), user)
    ).toBe(true);
  });

  it('missing/undefined flags fail open (backwards-compatible with old templates)', () => {
    const legacyTemplate = {}; // no role flags at all
    expect(
      templateAllowsEmailForUser(legacyTemplate, { role: 'OWNER' })
    ).toBe(true);
    expect(
      templateAllowsEmailForUser(legacyTemplate, {
        role: 'CLIENT',
        clientAccess: [{ role: 'VIEWER' }],
      })
    ).toBe(true);
  });

  it('unknown roles are allowed (fail-open)', () => {
    expect(
      templateAllowsEmailForUser(mkTemplate(), { role: 'SOMETHING_ELSE' })
    ).toBe(true);
  });

  it('null template or null user returns true', () => {
    expect(templateAllowsEmailForUser(null, { role: 'OWNER' })).toBe(true);
    expect(templateAllowsEmailForUser(mkTemplate(), null)).toBe(true);
  });
});
