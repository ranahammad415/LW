import { describe, it, expect, vi } from 'vitest';

const findFirst = vi.fn(async () => ({ agencyName: 'FromDb' }));
vi.mock('../../../src/lib/prisma.js', () => ({ prisma: { agencySetting: { findFirst } } }));
vi.mock('../../../src/lib/mailer.js', () => ({ sendEmail: vi.fn(async () => ({ success: true })), smtpConfigured: true }));

const { render, sendTemplate, templates } = await import('../../../src/lib/osBackup/emails.js');
const { wrapInBrandedLayout, clearAgencySettingsCache } = await import('../../../src/lib/emailLayout.js');

const branding = { agencyName: 'Wave <Agency>', emailPrimaryColor: '#123456' };

describe('osBackup emails render without the DB', () => {
  it('wrapInBrandedLayout with settings never calls Prisma; without, it does (backward compatible)', async () => {
    clearAgencySettingsCache();
    findFirst.mockClear();
    const html = await wrapInBrandedLayout({ bodyHtml: '<p>x</p>', settings: branding, category: 'security' });
    expect(findFirst).not.toHaveBeenCalled();
    expect(html).toContain('#123456');
    await wrapInBrandedLayout({ bodyHtml: '<p>x</p>', settings: null });
    expect(findFirst).not.toHaveBeenCalled();
    const fromDb = await wrapInBrandedLayout({ bodyHtml: '<p>x</p>' });
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(fromDb).toContain('FromDb');
  });

  it('every template renders with captured branding and no DB call', async () => {
    findFirst.mockClear();
    const data = { code: '123456', backupAt: '2026-11-15T08:50:00Z', backupBytes: 5_000_000, actorEmail: 'a@x.io', at: new Date(), ip: '1.2.3.4', userAgent: 'UA', paused: true, failures: 2, error: 'DISK_LOW', freeBytes: 1, requiredBytes: 2, safetyFile: 'lwos-x.lwbk', durationMs: 1000, missingCount: 1, now: new Date('2026-11-15T12:50:00Z') };
    for (const name of Object.keys(templates)) {
      const m = await render(name, data, branding);
      expect(m.subject).toBeTruthy();
      expect(m.html).toContain('<!DOCTYPE html>');
      expect(m.text).toBeTruthy();
    }
    const fr = await render('restoreFailed', { ...data, rollbackFailed: true }, branding);
    expect(fr.text).toContain('npm run os-backup -- restore --file');
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('the OTP code is in the body, never the subject; values are escaped', async () => {
    const m = await render('restoreOtp', { code: '987654', backupAt: '2026-11-15T08:50:00Z', backupBytes: 1, name: '<b>x</b>', now: new Date('2026-11-15T12:50:00Z') }, branding);
    expect(m.subject).not.toContain('987654');
    expect(m.html).toContain('987654');
    expect(m.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(m.text).toContain('Up to 4 hours');
  });

  it('sendTemplate sends one message per recipient', async () => {
    const send = vi.fn(async () => ({ success: true }));
    const n = await sendTemplate('backupStale', { lastSuccessAt: null }, [{ email: 'a@x.io' }, { email: 'b@x.io' }, {}], { settings: branding, send });
    expect(n).toBe(2);
    expect(send.mock.calls.map((c) => c[0].to)).toEqual(['a@x.io', 'b@x.io']);
  });
});
