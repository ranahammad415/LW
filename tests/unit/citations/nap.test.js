/**
 * NAP normalisation and matching vectors (lib/citations/nap.js): E.164 phones, ZIP / address folding with street
 * abbreviations, fuzzy names, and compareNap's correct / wrong / unknown decision.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizePhone,
  normalizeZip,
  zipFromAddress,
  normalizeAddress,
  addressesMatch,
  nameSimilarity,
  namesMatch,
  phonesMatch,
  zipsMatch,
  compareNap,
} from '../../../src/lib/citations/nap.js';

describe('phone → E.164', () => {
  it.each([
    ['262-667-6421', '+12626676421'],
    ['(262) 667 6421', '+12626676421'],
    ['262.667.6421', '+12626676421'],
    ['1 262 667 6421', '+12626676421'],
    ['+1 (262) 667-6421', '+12626676421'],
    ['+1 262-667-6421 ext. 12', '+12626676421'],
    ['0044 20 7946 0958', '+442079460958'],
    ['+44 20 7946 0958', '+442079460958'],
    ['667-6421', null],
    ['', null],
    [null, null],
  ])('%s → %s', (input, out) => {
    expect(normalizePhone(input)).toBe(out);
  });
  it('matches across formats, never on unknown', () => {
    expect(phonesMatch('262-667-6421', '+1 (262) 667-6421')).toBe(true);
    expect(phonesMatch('262-667-6421', '262-667-6422')).toBe(false);
    expect(phonesMatch(null, null)).toBe(false);
  });
});

describe('ZIP and address', () => {
  it('US ZIP+4 folds to 5 digits; postal codes are case and punctuation insensitive', () => {
    expect(normalizeZip('53186-1234')).toBe('53186');
    expect(normalizeZip(' 53186 ')).toBe('53186');
    expect(normalizeZip('sw1a 1aa')).toBe('SW1A1AA');
    expect(zipsMatch('53186', '53186-0001')).toBe(true);
    expect(zipsMatch('53186', '53187')).toBe(false);
  });
  it('ZIP from a free-text address (the last 5-digit group)', () => {
    expect(zipFromAddress('1200 W Sunset Dr, Waukesha, WI 53189, United States')).toBe('53189');
    expect(zipFromAddress('12345 Main St, Waukesha, WI 53189-0001')).toBe('53189');
    expect(zipFromAddress('No zip here')).toBeNull();
  });
  it('St / Street, Ave., N. and punctuation fold together', () => {
    expect(normalizeAddress('1200 W. Sunset Dr., Ste #4')).toBe('1200 west sunset drive suite 4');
    expect(addressesMatch('1200 W Sunset Dr', '1200 West Sunset Drive')).toBe(true);
    expect(addressesMatch('12 Main St', '12 MAIN STREET')).toBe(true);
    expect(addressesMatch('12 Main St', '14 Main St')).toBe(false);
  });
});

describe('fuzzy names', () => {
  it.each([
    ['Oasis Pool and Spa', 'Oasis Pool & Spa', true],
    ['Oasis Pool and Spa', 'OASIS POOL AND SPA LLC', true],
    ['Oasis Pool and Spa', 'Oasis Pool and Spas', true],
    ['Oasis Pool and Spa', 'Oasis Pool and Spa Services', true],
    ['Oasis Pool and Spa', 'Desert Oasis Car Wash', false],
    ["Joe's Pizza", 'Joes Pizza', true],
    ["Joe's Pizza", 'Pizza Hut', false],
  ])('%s ~ %s → %s', (a, b, out) => {
    expect(namesMatch(a, b)).toBe(out);
  });
  it('similarity is symmetric and 1 for equal names', () => {
    expect(nameSimilarity('A B C', 'a b c')).toBe(1);
    expect(nameSimilarity('Oasis Pool', 'Pool Oasis')).toBeCloseTo(nameSimilarity('Pool Oasis', 'Oasis Pool'));
  });
});

describe('compareNap', () => {
  const canon = { name: 'Oasis Pool and Spa', phone: '262-667-6421', zip: '53186', hours: 'Mon–Fri 8–6' };
  it('all known checks true → correct', () => {
    const r = compareNap(canon, { name: 'Oasis Pool & Spa', phone: '(262) 667-6421', zip: '53186-0001', siteLink: true });
    expect(r).toEqual({ checks: { name: true, phone: true, zip: true, hours: null, areas: null, site_link: true }, napStatus: 'correct' });
  });
  it('a wrong phone or ZIP → wrong (the Yelp example of §39)', () => {
    expect(compareNap(canon, { name: 'OASIS POOL AND SPAS', phone: '262-667-6421', zip: '53187' })).toMatchObject({ napStatus: 'wrong', checks: { zip: false } });
    expect(compareNap(canon, { name: 'Oasis Pool and Spa', phone: '414-555-0100' })).toMatchObject({ napStatus: 'wrong', checks: { phone: false, zip: null } });
  });
  it('not enough seen → unknown; hours are only judged on request', () => {
    expect(compareNap(canon, { name: 'Oasis Pool and Spa' }).napStatus).toBe('unknown');
    expect(compareNap(canon, { name: 'Oasis Pool and Spa', phone: '262-667-6421', hours: 'Mon 08:00–18:00' }).checks.hours).toBeNull();
    expect(compareNap(canon, { name: 'Oasis Pool and Spa', phone: '262-667-6421', hours: 'mon-fri 8-6' }, { compareHours: true }).checks.hours).toBe(true);
  });
});
