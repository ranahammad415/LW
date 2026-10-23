/**
 * Bing auto-bind: registrable-domain match (dataforseoDomain → GSC → wpUrl → client website), verified sites only,
 * www / non-www variants narrowed by the exact GSC / site host, ambiguous when still several, an existing binding is
 * never overwritten and a site is never bound to two projects; the bind PUT accepts only listed verified sites.
 */
import { describe, it, expect } from 'vitest';
import { pickBingSite, planAutoBind, projectBingDomain, isListedVerifiedSite } from '../../../src/lib/bing/bingBinding.js';

const SITES = [
  { siteUrl: 'https://www.harbordental.com/', verified: true },
  { siteUrl: 'https://harbordental.com/', verified: true },
  { siteUrl: 'https://joespizza.com/', verified: true },
  { siteUrl: 'https://unverified.com/', verified: false },
  { siteUrl: 'https://xjoespizza.com/', verified: true },
];

describe('projectBingDomain', () => {
  it('uses dataforseoDomain, then GSC (sc-domain too), then wpUrl, then the client website', () => {
    expect(projectBingDomain({ dataforseoDomain: 'joespizza.com', gscSiteUrl: 'https://other.com/' })).toBe('joespizza.com');
    expect(projectBingDomain({ gscSiteUrl: 'sc-domain:harbordental.com' })).toBe('harbordental.com');
    expect(projectBingDomain({ wpUrl: 'https://shop.joespizza.com' })).toBe('joespizza.com');
    expect(projectBingDomain({ client: { websiteUrl: 'joespizza.com' } })).toBe('joespizza.com');
    expect(projectBingDomain({})).toBe('');
  });
});

describe('pickBingSite', () => {
  it('one verified match binds; look-alikes never match', () => {
    expect(pickBingSite({ wpUrl: 'https://www.joespizza.com' }, SITES)).toEqual({ site: 'https://joespizza.com/' });
  });
  it('several variants: the exact GSC URL-prefix host wins, else the site host, else ambiguous', () => {
    expect(pickBingSite({ gscSiteUrl: 'https://www.harbordental.com/' }, SITES)).toEqual({ site: 'https://www.harbordental.com/' });
    expect(pickBingSite({ gscSiteUrl: 'sc-domain:harbordental.com', wpUrl: 'https://harbordental.com' }, SITES)).toEqual({ site: 'https://harbordental.com/' });
    expect(pickBingSite({ gscSiteUrl: 'sc-domain:harbordental.com' }, SITES)).toEqual({ ambiguous: ['https://www.harbordental.com/', 'https://harbordental.com/'] });
  });
  it('unverified or missing sites are reported, not bound', () => {
    expect(pickBingSite({ wpUrl: 'https://unverified.com' }, SITES)).toEqual({ none: 'NOT_VERIFIED' });
    expect(pickBingSite({ wpUrl: 'https://nothere.com' }, SITES)).toEqual({ none: 'NO_SITE' });
    expect(pickBingSite({}, SITES)).toEqual({ none: 'NO_DOMAIN' });
  });
});

describe('planAutoBind', () => {
  it('never overwrites a binding and never binds one site twice', () => {
    const projects = [
      { id: 'a', name: 'A', bingSiteUrl: 'https://joespizza.com/', wpUrl: 'https://joespizza.com' },
      { id: 'b', name: 'B', bingSiteUrl: null, dataforseoDomain: 'joespizza.com' },
      { id: 'c', name: 'C', bingSiteUrl: null, gscSiteUrl: 'https://www.harbordental.com/' },
      { id: 'd', name: 'D', bingSiteUrl: null, gscSiteUrl: 'sc-domain:harbordental.com' },
      { id: 'e', name: 'E', bingSiteUrl: null, wpUrl: 'https://none.example' },
    ];
    const out = planAutoBind(projects, SITES);
    expect(out.bound).toEqual([{ projectId: 'c', name: 'C', siteUrl: 'https://www.harbordental.com/' }]);
    expect(out.ambiguous.map((x) => [x.projectId, x.reason])).toEqual([['b', 'ALREADY_BOUND'], ['d', 'SEVERAL_VARIANTS']]);
    expect(out.unmatched).toEqual([{ projectId: 'e', name: 'E', reason: 'NO_SITE' }]);
    expect(out.bound.some((b) => b.projectId === 'a')).toBe(false);
  });
});

describe('isListedVerifiedSite', () => {
  it('exact string and verified only', () => {
    expect(isListedVerifiedSite('https://joespizza.com/', SITES)).toBe(true);
    expect(isListedVerifiedSite('https://joespizza.com', SITES)).toBe(false);
    expect(isListedVerifiedSite('https://unverified.com/', SITES)).toBe(false);
  });
});
