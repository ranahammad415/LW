/**
 * Local SEO identity: identifier normalisation (incl. legacy "place_id:" in gmbCid after the 20261107 migration),
 * short links through the SSRF-guarded fetch, strict domain matching, Find-business auto-match, manual binding.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  normalizeGmbIdentifier,
  dfsIdentifierForProject,
  dfsKeywordForProject,
  hasGbpIdentity,
  gbpIdentityKind,
  resolveMapsShortLink,
  isAllowedMapsUrl,
  MAX_SHORT_LINK_REDIRECTS,
  storedCid,
} from '../../../src/lib/analytics/gmbIdentifier.js';
import { registrableDomain, sameSite } from '../../../src/lib/analytics/domainMatch.js';
import { candidateMatchesSite, projectSiteDomain, identityDataFromProfile } from '../../../src/lib/analytics/gbpIdentity.js';
import { manualIdentityData } from '../../../src/routes/admin/integrations.js';

describe('normalizeGmbIdentifier', () => {
  it('reads every legacy and current form', () => {
    expect(normalizeGmbIdentifier('cid:123456789')).toMatchObject({ identifier: 'cid:123456789', kind: 'cid', cid: '123456789' });
    expect(normalizeGmbIdentifier('123456789012')).toMatchObject({ identifier: 'cid:123456789012', kind: 'cid' });
    expect(normalizeGmbIdentifier('place_id:ChIJabc123xyz')).toMatchObject({ identifier: 'place_id:ChIJabc123xyz', kind: 'place_id', placeId: 'ChIJabc123xyz' });
    expect(normalizeGmbIdentifier('ChIJN1t_tDeuEmsRUsoyG83frY4')).toMatchObject({ kind: 'place_id' });
    expect(normalizeGmbIdentifier('https://www.google.com/maps/place/Joe+Pizza/@1,2,17z/data=!4m6!3m5!1s0x8805:0x2b3c4d5e6f7a8b9c')).toMatchObject({ kind: 'cid', cid: BigInt('0x2b3c4d5e6f7a8b9c').toString(10), displayName: 'Joe Pizza' });
    expect(normalizeGmbIdentifier('https://maps.google.com/?cid=987654321')).toMatchObject({ kind: 'cid', cid: '987654321' });
    expect(normalizeGmbIdentifier('Joe Pizza', { targetMarket: 'Milwaukee' })).toMatchObject({ identifier: 'Joe Pizza Milwaukee', kind: 'name' });
    expect(normalizeGmbIdentifier('')).toMatchObject({ identifier: null, kind: 'empty' });
  });

  it('short links need a network hop: kind short_link, no identifier', () => {
    expect(normalizeGmbIdentifier('https://maps.app.goo.gl/AbCdEf123')).toEqual({ identifier: null, displayName: null, kind: 'short_link', url: 'https://maps.app.goo.gl/AbCdEf123' });
    expect(normalizeGmbIdentifier('maps.app.goo.gl/AbCdEf123').url).toBe('https://maps.app.goo.gl/AbCdEf123');
  });

  it('project identifier priority: CID, then place_id, then legacy value (migration compatibility)', () => {
    expect(dfsIdentifierForProject({ gmbCid: '111111111', gmbPlaceId: 'ChIJplace1' })).toMatchObject({ identifier: 'cid:111111111', kind: 'cid' });
    expect(dfsIdentifierForProject({ gmbCid: 'cid:111111111' })).toMatchObject({ identifier: 'cid:111111111' }); // not yet migrated
    expect(dfsIdentifierForProject({ gmbCid: null, gmbPlaceId: 'ChIJplace1' })).toMatchObject({ identifier: 'place_id:ChIJplace1', kind: 'place_id' });
    // A row the migration has not touched yet still works.
    expect(dfsIdentifierForProject({ gmbCid: 'place_id:ChIJlegacy1' })).toMatchObject({ identifier: 'place_id:ChIJlegacy1', placeId: 'ChIJlegacy1' });
    expect(dfsKeywordForProject({ gmbCid: 'Joe Pizza', targetMarket: 'Milwaukee' })).toBe('Joe Pizza Milwaukee');
    expect(dfsIdentifierForProject({}).identifier).toBeNull();
  });

  it('GBP identity: native, CID or place_id; a bare name does not count', () => {
    expect(hasGbpIdentity({ gmbLocationId: 'accounts/1/locations/2' })).toBe(true);
    expect(hasGbpIdentity({ gmbCid: '123456789' })).toBe(true);
    expect(hasGbpIdentity({ gmbPlaceId: 'ChIJplace1' })).toBe(true);
    expect(hasGbpIdentity({ gmbCid: 'Joe Pizza' })).toBe(false);
    expect(gbpIdentityKind({ gmbCid: 'Joe Pizza' })).toBe('name');
    expect(hasGbpIdentity({})).toBe(false);
  });

  it('storedCid keeps digits only', () => {
    expect(storedCid('cid:123456')).toBe('123456');
    expect(storedCid('12a')).toBeNull();
  });
});

describe('short link resolution (SSRF guard, google maps hosts only, capped)', () => {
  const redirect = (location) => ({ status: 302, headers: new Headers({ location }) });

  it('follows maps.app.goo.gl to the long Google Maps URL', async () => {
    const fetchImpl = vi.fn(async () => redirect('https://www.google.com/maps/place/Joe/@1,2,17z/data=!1s0x1:0xabc'));
    const r = await resolveMapsShortLink('https://maps.app.goo.gl/AbC', { fetchImpl });
    expect(r).toEqual({ ok: true, url: 'https://www.google.com/maps/place/Joe/@1,2,17z/data=!1s0x1:0xabc' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', maxBytes: 262144 });
  });

  it('refuses a redirect off Google Maps hosts, a private address and plain http', async () => {
    for (const loc of ['https://evil.example/maps', 'https://127.0.0.1/maps', 'http://www.google.com/maps/place/x', 'https://google.com.evil.net/maps']) {
      const r = await resolveMapsShortLink('https://maps.app.goo.gl/AbC', { fetchImpl: async () => redirect(loc) });
      expect(r).toEqual({ ok: false, code: 'HOST_NOT_ALLOWED' });
    }
    expect(await resolveMapsShortLink('https://169.254.169.254/latest', { fetchImpl: vi.fn() })).toEqual({ ok: false, code: 'HOST_NOT_ALLOWED' });
  });

  it('stops after MAX_SHORT_LINK_REDIRECTS hops', async () => {
    const fetchImpl = vi.fn(async () => redirect('https://maps.app.goo.gl/again'));
    expect(await resolveMapsShortLink('https://maps.app.goo.gl/AbC', { fetchImpl })).toEqual({ ok: false, code: 'TOO_MANY_REDIRECTS' });
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_SHORT_LINK_REDIRECTS + 1);
  });

  it('unwraps a consent.google.com interstitial without fetching it', async () => {
    const target = 'https://www.google.com/maps?cid=55555555';
    const fetchImpl = vi.fn(async () => redirect(`https://consent.google.com/m?continue=${encodeURIComponent(target)}`));
    expect(await resolveMapsShortLink('https://maps.app.goo.gl/AbC', { fetchImpl })).toEqual({ ok: true, url: target });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a fetch error (e.g. the guard refusing a private resolution) is FETCH_FAILED; no redirect is NO_REDIRECT', async () => {
    expect(await resolveMapsShortLink('https://maps.app.goo.gl/AbC', { fetchImpl: async () => { throw Object.assign(new Error('blocked'), { code: 'EAI_BLOCKED' }); } })).toEqual({ ok: false, code: 'FETCH_FAILED' });
    expect(await resolveMapsShortLink('https://maps.app.goo.gl/AbC', { fetchImpl: async () => ({ status: 200, headers: new Headers() }) })).toEqual({ ok: false, code: 'NO_REDIRECT' });
  });

  it('allowed hosts', () => {
    expect(isAllowedMapsUrl(new URL('https://www.google.co.uk/maps/place/x'))).toBe(true);
    expect(isAllowedMapsUrl(new URL('https://maps.google.com/?cid=1'))).toBe(true);
    expect(isAllowedMapsUrl(new URL('https://goo.gl/maps/abc'))).toBe(true);
    expect(isAllowedMapsUrl(new URL('https://goo.gl/other'))).toBe(false);
    expect(isAllowedMapsUrl(new URL('https://www.google.com/search?q=x'))).toBe(false);
    expect(isAllowedMapsUrl(new URL('https://user:pw@www.google.com/maps'))).toBe(false);
  });
});

describe('strict domain match', () => {
  it('same registrable domain only', () => {
    expect(sameSite('https://www.abc.com/page', 'abc.com')).toBe(true);
    expect(sameSite('shop.abc.com', 'abc.com')).toBe(true);
    expect(sameSite('xabc.com', 'abc.com')).toBe(false);
    expect(sameSite('abc.com.evil.net', 'abc.com')).toBe(false);
    expect(sameSite('https://abc.co.uk', 'www.abc.co.uk')).toBe(true);
    expect(sameSite('xyz.co.uk', 'abc.co.uk')).toBe(false);
    expect(sameSite('abc.wixsite.com', 'xyz.wixsite.com')).toBe(false);
    expect(sameSite('', 'abc.com')).toBe(false);
    expect(registrableDomain('https://a.b.example.com.au/x')).toBe('example.com.au');
  });
});

describe('Find business auto-match and identity data', () => {
  const project = { dataforseoDomain: null, wpUrl: 'https://www.joespizza.com', client: { websiteUrl: 'https://other.com' } };
  it('marks a candidate whose website is the project site', () => {
    const site = projectSiteDomain(project);
    expect(site).toBe('joespizza.com');
    expect(candidateMatchesSite({ url: 'https://joespizza.com/menu' }, site)).toBe(true);
    expect(candidateMatchesSite({ domain: 'www.xjoespizza.com' }, site)).toBe(false);
    expect(candidateMatchesSite({ url: null, domain: null }, site)).toBe(false);
  });

  it('persists cid, place_id, feature_id, lat/lng, address, phone, category, url, rating and count', () => {
    const now = new Date('2026-10-22T00:00:00Z');
    const d = identityDataFromProfile(
      { cid: '777777777', placeId: 'ChIJp', featureId: '0x1:0x2', lat: 43.1, lng: -87.9, address: 'A', phone: 'P', category: 'C', url: 'https://u', rating: 4.567, reviewsCount: 212, title: 'Joe' },
      { source: 'dataforseo', now, verified: true, setName: true, setIdentitySource: true }
    );
    expect(d).toEqual({
      gmbProfileSyncedAt: now, gmbCid: '777777777', gmbPlaceId: 'ChIJp', gmbFeatureId: '0x1:0x2', gmbLat: 43.1, gmbLng: -87.9, gmbAddress: 'A', gmbPhone: 'P',
      gmbCategory: 'C', gmbWebsite: 'https://u', gmbRating: 4.57, gmbReviewsCount: 212, gmbLocationName: 'Joe', gmbIdentitySource: 'dataforseo', gmbIdentityVerifiedAt: now,
    });
    // Missing fields never blank stored values.
    expect(identityDataFromProfile({ rating: null }, { source: 'native', now })).toEqual({ gmbProfileSyncedAt: now });
  });
});

describe('manual binding (admin Integrations)', () => {
  it('unchanged identifier changes nothing (re-saving a row keeps place_id, verification and profile)', () => {
    expect(manualIdentityData({ gmbCid: '123456789', gmbPlaceId: 'ChIJp' }, normalizeGmbIdentifier('123456789'))).toEqual({});
    expect(manualIdentityData({ gmbCid: null, gmbPlaceId: 'ChIJp12345678' }, normalizeGmbIdentifier('place_id:ChIJp12345678'))).toEqual({});
  });
  it('a new identifier replaces the other id and resets verification/profile', () => {
    const d = manualIdentityData({ gmbCid: '1', gmbPlaceId: 'ChIJold', gmbIdentityVerifiedAt: new Date() }, normalizeGmbIdentifier('place_id:ChIJnew12345'));
    expect(d).toMatchObject({ gmbCid: null, gmbPlaceId: 'ChIJnew12345', gmbIdentitySource: 'manual', gmbIdentityVerifiedAt: null, gmbRating: null, gmbReviewsTaskId: null });
  });
  it('clearing keeps a native binding as the identity source', () => {
    expect(manualIdentityData({ gmbCid: '1', gmbLocationId: 'loc' }, normalizeGmbIdentifier(''))).toMatchObject({ gmbCid: null, gmbPlaceId: null, gmbIdentitySource: 'native' });
  });
});
