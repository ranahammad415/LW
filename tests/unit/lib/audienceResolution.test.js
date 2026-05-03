import { describe, it, expect } from 'vitest';
import {
  audienceForUser,
  resolveVariantForAudience,
} from '../../../src/lib/notificationService.js';

const BASE = {
  subject: 'base subject',
  bodyHtml: '<p>base</p>',
  bodyText: 'base text',
  inAppMessage: 'base inapp',
};

describe('audienceForUser', () => {
  it('OWNER maps to AGENCY_OWNER', () => {
    expect(audienceForUser({ role: 'OWNER' })).toBe('AGENCY_OWNER');
  });

  it('PM / TEAM_MEMBER / CONTRACTOR map to AGENCY_TEAM', () => {
    for (const role of ['PM', 'TEAM_MEMBER', 'CONTRACTOR']) {
      expect(audienceForUser({ role })).toBe('AGENCY_TEAM');
    }
  });

  it('CLIENT with VIEWER ClientUser row maps to CLIENT_VIEWER', () => {
    expect(
      audienceForUser({ role: 'CLIENT', clientAccess: [{ role: 'VIEWER' }] })
    ).toBe('CLIENT_VIEWER');
  });

  it('CLIENT with MANAGER ClientUser row maps to CLIENT_MANAGER', () => {
    expect(
      audienceForUser({ role: 'CLIENT', clientAccess: [{ role: 'MANAGER' }] })
    ).toBe('CLIENT_MANAGER');
  });

  it('CLIENT with no ClientUser rows defaults to CLIENT_MANAGER', () => {
    expect(audienceForUser({ role: 'CLIENT', clientAccess: [] })).toBe(
      'CLIENT_MANAGER'
    );
    expect(audienceForUser({ role: 'CLIENT' })).toBe('CLIENT_MANAGER');
  });

  it('case-insensitive VIEWER detection', () => {
    expect(
      audienceForUser({ role: 'CLIENT', clientAccess: [{ role: 'viewer' }] })
    ).toBe('CLIENT_VIEWER');
  });

  it('unknown / null role falls back to AGENCY_TEAM', () => {
    expect(audienceForUser({ role: 'XYZ' })).toBe('AGENCY_TEAM');
    expect(audienceForUser(null)).toBe('AGENCY_TEAM');
    expect(audienceForUser(undefined)).toBe('AGENCY_TEAM');
  });
});

describe('resolveVariantForAudience', () => {
  it('returns the variant fields when one exists for the audience', () => {
    const variants = {
      AGENCY_OWNER: {
        subject: 'owner subject',
        bodyHtml: '<p>owner</p>',
        bodyText: 'owner text',
        inAppMessage: 'owner inapp',
        ctaLabel: 'Open client account',
      },
    };
    const resolved = resolveVariantForAudience(variants, 'AGENCY_OWNER', BASE);
    expect(resolved.subject).toBe('owner subject');
    expect(resolved.bodyHtml).toBe('<p>owner</p>');
    expect(resolved.bodyText).toBe('owner text');
    expect(resolved.inAppMessage).toBe('owner inapp');
    expect(resolved.ctaLabel).toBe('Open client account');
    expect(resolved.source).toBe('variant');
    expect(resolved.audience).toBe('AGENCY_OWNER');
  });

  it('falls back to base template when no variant for that audience', () => {
    const resolved = resolveVariantForAudience({}, 'CLIENT_VIEWER', BASE);
    expect(resolved.subject).toBe('base subject');
    expect(resolved.bodyHtml).toBe('<p>base</p>');
    expect(resolved.bodyText).toBe('base text');
    expect(resolved.inAppMessage).toBe('base inapp');
    expect(resolved.ctaLabel).toBeNull();
    expect(resolved.source).toBe('base');
    expect(resolved.audience).toBe('CLIENT_VIEWER');
  });

  it('handles null / undefined variantsByAudience gracefully', () => {
    expect(resolveVariantForAudience(null, 'AGENCY_TEAM', BASE).source).toBe(
      'base'
    );
    expect(
      resolveVariantForAudience(undefined, 'AGENCY_TEAM', BASE).source
    ).toBe('base');
  });

  it('fills variant holes from the base template (partial variant)', () => {
    // simulate a variant with empty bodyText - should inherit base text
    const variants = {
      CLIENT_MANAGER: {
        subject: 'client subject',
        bodyHtml: '<p>client</p>',
        bodyText: null,
        inAppMessage: 'client inapp',
        ctaLabel: null,
      },
    };
    const resolved = resolveVariantForAudience(
      variants,
      'CLIENT_MANAGER',
      BASE
    );
    expect(resolved.subject).toBe('client subject');
    expect(resolved.bodyText).toBe('base text'); // inherited
    expect(resolved.ctaLabel).toBeNull();
    expect(resolved.source).toBe('variant');
  });

  it('an OWNER variant does not affect CLIENT_VIEWER resolution', () => {
    const variants = {
      AGENCY_OWNER: {
        subject: 'owner subject',
        bodyHtml: '<p>owner</p>',
        bodyText: 'owner text',
        inAppMessage: 'owner inapp',
        ctaLabel: null,
      },
    };
    const resolved = resolveVariantForAudience(
      variants,
      'CLIENT_VIEWER',
      BASE
    );
    expect(resolved.source).toBe('base');
    expect(resolved.subject).toBe('base subject');
  });
});
