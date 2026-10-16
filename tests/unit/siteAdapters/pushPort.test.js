/**
 * Port parity for lib/siteAdapters/push.js: the contract's own push.test.mjs / blocks.test.mjs cases (oasis-astro
 * 2c59003), minus the JSON-schema `validate()` checks, run against the copied fixtures.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { prepareDraftPush, checkMediaItems, checkLayout, MEDIA_LIMITS, MEDIA_IMPORT_TIMEOUT_MS } from '../../../src/lib/siteAdapters/push.js';
import { ERROR_CODES } from '../../../src/lib/siteAdapters/signing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = (n) => JSON.parse(readFileSync(path.join(here, '../../fixtures/cms-contract/examples', `${n}.json`), 'utf8'));
const si = ex('site-info.response');
const blockSchemas = si.framework.blockSchemas;

describe('checkLayout (blocks.mjs)', () => {
  it('the draft-upsert example layout passes the site-info example blockSchemas', () => {
    expect(checkLayout(ex('draft-upsert.request').layout, blockSchemas).errors).toEqual([]);
  });
  it('old example fields are SCHEMA_INVALID', () => {
    const r = checkLayout([{ _type: 'page_hero', heading: 'H', lead: 'old field' }, { _type: 'related_links', links: [{ label: 'Spa', href: '/spa/' }] }], blockSchemas);
    expect(r.errors.map((e) => [e.code, e.path])).toEqual([
      ['SCHEMA_INVALID', '$.layout[0].lead'],
      ['SCHEMA_INVALID', '$.layout[1].links[0].href'],
      ['SCHEMA_INVALID', '$.layout[1].links[0].url'],
    ]);
  });
  it('_version optional; must equal blockSchemas[type].version when sent', () => {
    const v = blockSchemas.page_hero.version;
    expect(checkLayout([{ _type: 'page_hero', heading: 'H' }], blockSchemas).ok).toBe(true);
    expect(checkLayout([{ _type: 'page_hero', _version: v, heading: 'H' }], blockSchemas).ok).toBe(true);
    expect(checkLayout([{ _type: 'page_hero', _version: v + 1, heading: 'H' }], blockSchemas).errors.map((e) => [e.code, e.path])).toEqual([['SCHEMA_INVALID', '$.layout[0]._version']]);
  });
  it('unknown block, maxLength, select options, repeater limits', () => {
    const r = checkLayout(
      [
        { _type: 'html_block', html: '<p>x</p>' },
        { _type: 'page_hero', heading: 'x'.repeat(71), variant: 'Huge' },
        { _type: 'faq', heading: 'Q', items: [] },
        { _type: 'related_links', links: Array.from({ length: 7 }, () => ({ label: 'a', url: '/a/' })) },
      ],
      blockSchemas
    );
    const codes = r.errors.map((e) => `${e.code} ${e.path} ${e.message}`);
    expect(codes.some((c) => c.startsWith('UNKNOWN_BLOCK $.layout[0]'))).toBe(true);
    expect(codes.some((c) => c.startsWith('SCHEMA_INVALID $.layout[1].heading longer than 70'))).toBe(true);
    expect(codes.some((c) => c.startsWith('SCHEMA_INVALID $.layout[1].variant must be one of'))).toBe(true);
    expect(codes.some((c) => c.startsWith('SCHEMA_INVALID $.layout[2].items needs at least 1'))).toBe(true);
    expect(codes.some((c) => c.startsWith('SCHEMA_INVALID $.layout[3].links allows at most 6'))).toBe(true);
  });
});

describe('prepareDraftPush / checkMediaItems (push.mjs)', () => {
  it('the push examples pass', () => {
    for (const n of ['draft-upsert.request--create-exact', 'draft-upsert.request--post-bylines', 'draft-upsert.request--update']) {
      expect(prepareDraftPush(si, ex(n)).errors, n).toEqual([]);
    }
  });
  it('parent, _version, layout and baseRev problems; unknown terms are warnings', () => {
    const d = ex('draft-upsert.request--create-exact');
    d.target.parent = 'spa-repair';
    d.layout[0]._version = 99;
    d.layout[1].tone = 'Purple';
    expect(prepareDraftPush(si, d).errors.map((e) => [e.code, e.path])).toEqual([
      ['PARENT_NOT_FOUND', '$.target.parent'],
      ['SCHEMA_INVALID', '$.layout[0]._version'],
      ['SCHEMA_INVALID', '$.layout[1].tone'],
    ]);
    const p = ex('draft-upsert.request--post-bylines');
    p.taxonomies = { category: ['spa-care', 'new-term'], tags: ['x'] };
    const tr = prepareDraftPush(si, p);
    expect(tr.ok).toBe(true);
    expect(tr.warnings.map((w) => [w.code, w.path])).toEqual([['TERM_NOT_FOUND', '$.taxonomies.category[1]'], ['TERM_NOT_FOUND', '$.taxonomies.tags']]);
    const u = ex('draft-upsert.request--update');
    delete u.baseRev;
    expect(prepareDraftPush(si, u).errors.map((e) => e.path)).toEqual(['$.baseRev']);
  });
  it('bylines: the requesting human or the team; agents get the team byline', () => {
    const agent = ex('draft-upsert.request--post-bylines');
    expect(prepareDraftPush(si, agent).ok).toBe(true);
    agent.bylines = ['jane-pm'];
    expect(prepareDraftPush(si, agent).errors[0].code).toBe('BYLINE_NOT_ALLOWED');
    const human = { ...ex('draft-upsert.request--post-bylines'), actor: { kind: 'human', osUserId: '8f14e45f-ceea-467a-9575-5f3c1b2a7d90', name: 'Jane PM', role: 'PM' }, bylines: ['jane-pm'] };
    expect(prepareDraftPush(si, human).ok).toBe(true);
    human.actor = { ...human.actor, osUserId: '3b0d9a1e-6c2f-4d8a-9e57-0f1a2b3c4d5e', name: 'Agency Owner', role: 'OWNER' };
    expect(prepareDraftPush(si, human).errors[0].code).toBe('BYLINE_NOT_ALLOWED');
    human.bylines = ['ghost-writer'];
    expect(prepareDraftPush(si, human).errors[0].code).toBe('BYLINE_NOT_ALLOWED');
  });
  it('v1.2.1 helper fixes', () => {
    const create = ex('draft-upsert.request--create-exact');
    expect(prepareDraftPush(si, { ...create, body: { markdown: 'x' } }).errors[0].message).toMatch(/exactly one of layout, body.markdown, portableText/);
    const none = { ...create };
    delete none.layout;
    expect(prepareDraftPush(si, none).errors[0].message).toMatch(/got none/);
    expect(prepareDraftPush(si, { ...ex('draft-upsert.request--update'), slug: 'Bad Slug' }, { collection: 'pages' }).errors.map((e) => e.path)).toEqual(['$.slug']);
    expect(prepareDraftPush(si, { ...create, taxonomies: { category: ['spa-care'] } }).warnings.map((w) => [w.code, w.path])).toEqual([['TERM_NOT_FOUND', '$.taxonomies.category']]);
    expect(prepareDraftPush(si, { ...create, bylines: ['oasis-team'] }).errors[0].code).toBe('BYLINE_NOT_ALLOWED');
    expect(prepareDraftPush(si, ex('draft-upsert.request--agent')).ok).toBe(true);
    expect(prepareDraftPush(si, null).ok).toBe(false);
    const m = si.media;
    expect(checkMediaItems(m, [{ url: 'https://old.oasispoolspas.com/a.jpg', upload: { filename: 'a', contentType: 'image/png', dataBase64: 'AA' }, alt: 'x' }]).errors[0].message).toBe('exactly one of url or upload');
    expect(checkMediaItems(m, [{ alt: 'x' }]).errors[0].message).toBe('exactly one of url or upload');
    expect(checkMediaItems(m, [{ url: 'https://old.oasispoolspas.com/a.jpg', alt: 'x'.repeat(301) }]).errors[0].message).toMatch(/longer than 300/);
    expect(checkMediaItems(m, [{ upload: { filename: 'a.png', contentType: 'image/png' }, alt: 'x' }]).errors[0].code).toBe('VALIDATION');
    expect(checkMediaItems({ ...m, allowedSourceHosts: ['OLD.OasisPoolSpas.com'] }, [{ url: 'https://old.oasispoolspas.com/a.jpg', alt: 'x' }]).ok).toBe(true);
    const wrapped = 'QUFB\nQUFB\n'.repeat(10);
    expect(checkMediaItems(m, [{ upload: { filename: 'a.png', contentType: 'image/png', dataBase64: wrapped }, alt: 'x' }]).ok).toBe(true);
    expect(checkMediaItems(m, [{ url: 'https://user:pw@old.oasispoolspas.com/a.jpg', alt: 'x' }]).errors[0].code).toBe('MEDIA_HOST_NOT_ALLOWED');
  });
  it('allowedSourcePathPrefixes (OS staging area)', () => {
    const m = si.media;
    expect(checkMediaItems(m, [{ url: 'https://account.localwaves.ai/uploads/cms-staging/abc.webp', alt: 'x' }]).ok).toBe(true);
    expect(checkMediaItems(m, [{ url: 'https://account.localwaves.ai/uploads/other/abc.webp', alt: 'x' }]).ok).toBe(false);
    expect(checkMediaItems(m, [{ url: 'https://account.localwaves.ai.evil.example/uploads/cms-staging/a.webp', alt: 'x' }]).ok).toBe(false);
    expect(checkMediaItems(m, ex('media-import.request').items.slice(0, 3)).ok).toBe(true);
  });
  it('media pre-check: https, wildcard hosts, alt, type, size, per-call limits', () => {
    const req = ex('media-import.request');
    expect(checkMediaItems(si.media, req.items).errors.map((e) => [e.index, e.code])).toEqual([[3, 'MEDIA_HOST_NOT_ALLOWED']]);
    expect(checkMediaItems(si.media, [{ url: 'https://a.localwaves-cdn.example/x.webp', alt: 'x' }]).ok).toBe(true);
    expect(checkMediaItems(si.media, [{ url: 'https://localwaves-cdn.example/x.webp', alt: 'x' }]).ok).toBe(false);
    expect(checkMediaItems(si.media, [{ url: 'http://old.oasispoolspas.com/x.jpg', alt: 'x' }]).errors[0].code).toBe('MEDIA_HOST_NOT_ALLOWED');
    expect(checkMediaItems(si.media, [{ url: 'https://old.oasispoolspas.com/x.jpg', alt: ' ' }]).errors[0].message).toBe('alt text is required');
    const up = ex('media-import.request--upload').items[0];
    expect(checkMediaItems(si.media, [up]).ok).toBe(true);
    expect(checkMediaItems(si.media, [up, up]).errors[0].code).toBe('VALIDATION');
    expect(checkMediaItems(si.media, [{ ...up, upload: { ...up.upload, dataBase64: 'A'.repeat(1_400_000) } }]).errors[0].code).toBe('MEDIA_TOO_LARGE');
    expect(checkMediaItems(si.media, [{ ...up, upload: { ...up.upload, contentType: 'image/svg+xml' } }]).errors[0].code).toBe('MEDIA_TYPE_UNSUPPORTED');
    expect(checkMediaItems(si.media, Array.from({ length: 21 }, () => req.items[0])).errors[0].code).toBe('VALIDATION');
  });
  it('v1.2.1 constants and error codes', () => {
    expect(MEDIA_LIMITS).toEqual({ itemsPerCall: 20, maxBytes: 1048576, maxDimension: 4000, altMax: 300, uploadsPerCall: 1 });
    expect(MEDIA_IMPORT_TIMEOUT_MS).toBe(30_000);
    expect(ERROR_CODES.ENTRY_LOCKED).toEqual({ status: 409, retryable: false });
    for (const c of ['SLUG_TAKEN', 'PARENT_NOT_FOUND', 'CONTRACT_LOCKED', 'SERVICE_TOKEN_UNAVAILABLE', 'BYLINE_NOT_ALLOWED']) expect(ERROR_CODES[c], c).toBeTruthy();
    expect(ERROR_CODES.SERVICE_TOKEN_UNAVAILABLE).toEqual({ status: 503, retryable: false });
    expect(ex('inventory.response').items.every((e) => e.rev)).toBe(true);
    expect(ex('handshake.response').team.length).toBeGreaterThan(0);
  });
});
