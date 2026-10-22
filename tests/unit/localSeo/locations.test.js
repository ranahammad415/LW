/**
 * Location picker: DataForSEO locations of one country (free endpoint), cached per country, postal codes dropped,
 * cities first; the stored name always comes from the list (never from the browser).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { countryLocations, searchLocations, findLocation, filterLocations, _clearLocationCache, isCountryCode } from '../../../src/lib/analytics/dfsLocations.js';

const PAYLOAD = {
  status_code: 20000,
  tasks: [{
    status_code: 20000,
    cost: 0,
    result: [
      { location_code: 2840, location_name: 'United States', location_type: 'Country', country_iso_code: 'US' },
      { location_code: 21167, location_name: 'Wisconsin,United States', location_type: 'State', country_iso_code: 'US' },
      { location_code: 1023191, location_name: 'Milwaukee,Wisconsin,United States', location_type: 'City', country_iso_code: 'US' },
      { location_code: 9059583, location_name: 'Milwaukee County,Wisconsin,United States', location_type: 'County', country_iso_code: 'US' },
      { location_code: 9018765, location_name: '53202,Wisconsin,United States', location_type: 'Postal Code', country_iso_code: 'US' },
    ],
  }],
};

beforeEach(() => _clearLocationCache());

describe('locations', () => {
  it('one free call per country, cached', async () => {
    const get = vi.fn(async () => PAYLOAD);
    const list = await countryLocations('us', { get });
    await countryLocations('us', { get });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe('/v3/serp/google/locations/us');
    expect(list.map((l) => l.code)).not.toContain(9018765);
  });

  it('search ranks cities first', async () => {
    const out = await searchLocations({ country: 'us', q: 'milwaukee', get: async () => PAYLOAD });
    expect(out.map((l) => l.code)).toEqual([1023191, 9059583]);
    expect(filterLocations([], 'm')).toEqual([]);
  });

  it('findLocation returns the canonical entry or null; bad country codes are refused', async () => {
    expect(await findLocation('us', 1023191, { get: async () => PAYLOAD })).toMatchObject({ name: 'Milwaukee,Wisconsin,United States', type: 'City' });
    expect(await findLocation('us', 5, { get: async () => PAYLOAD })).toBeNull();
    expect(isCountryCode('usa')).toBe(false);
    await expect(countryLocations('../x', { get: vi.fn() })).rejects.toThrow(/Invalid country/);
  });

  it('a DataForSEO error is not cached', async () => {
    const get = vi.fn(async () => ({ status_code: 40100, status_message: 'auth', tasks: [] }));
    await expect(countryLocations('gb', { get })).rejects.toThrow(/40100/);
    await expect(countryLocations('gb', { get })).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
