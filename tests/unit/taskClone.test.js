import { describe, it, expect } from 'vitest';
import { shiftDueDateOneMonth } from '../../src/lib/taskClone.js';

describe('shiftDueDateOneMonth', () => {
  it('returns null for nullish input', () => {
    expect(shiftDueDateOneMonth(null)).toBeNull();
    expect(shiftDueDateOneMonth(undefined)).toBeNull();
  });

  it('shifts mid-month dates by one calendar month', () => {
    const input = new Date(Date.UTC(2026, 6, 15, 12, 0, 0)); // Jul 15
    const out = shiftDueDateOneMonth(input);
    expect(out.getUTCFullYear()).toBe(2026);
    expect(out.getUTCMonth()).toBe(7); // Aug
    expect(out.getUTCDate()).toBe(15);
  });

  it('clamps end-of-month days (Jan 31 → Feb 28/29)', () => {
    const input = new Date(Date.UTC(2026, 0, 31)); // Jan 31
    const out = shiftDueDateOneMonth(input);
    expect(out.getUTCMonth()).toBe(1); // Feb
    expect(out.getUTCDate()).toBe(28);
  });

  it('rolls year forward from December', () => {
    const input = new Date(Date.UTC(2026, 11, 10)); // Dec 10
    const out = shiftDueDateOneMonth(input);
    expect(out.getUTCFullYear()).toBe(2027);
    expect(out.getUTCMonth()).toBe(0);
    expect(out.getUTCDate()).toBe(10);
  });
});
