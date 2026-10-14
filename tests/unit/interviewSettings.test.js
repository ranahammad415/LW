import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settingFindUnique: vi.fn(),
  sessionAggregate: vi.fn(),
  sessionCount: vi.fn(),
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    interviewSetting: { findUnique: mocks.settingFindUnique },
    voiceInterviewSession: { aggregate: mocks.sessionAggregate, count: mocks.sessionCount },
  },
}));

import {
  mergeSettings,
  baseDefaults,
  sanitizeSettingsPatch,
  resolveInterviewSettings,
} from '../../src/lib/interviewSettings.js';
import { getUsage } from '../../src/lib/voiceUsage.js';

describe('interview settings resolution (D5/D6/D7)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('uses built-in defaults: auto-approve ON, transcripts hidden, 365-day retention', () => {
    delete process.env.VOICE_AGENT_MONTHLY_MINUTES_PER_CLIENT;
    delete process.env.INTERVIEW_TRANSCRIPT_RETENTION_DAYS;
    const d = baseDefaults();
    expect(d.monthlyMinutesPerClient).toBe(120);
    expect(d.autoApproveLowRisk).toBe(true);
    expect(d.clientCanViewOwnTranscripts).toBe(false);
    expect(d.clientCanViewWorkerTranscripts).toBe(false);
    expect(d.transcriptRetentionDays).toBe(365);
  });

  it('env vars are only a fallback', () => {
    process.env.VOICE_AGENT_MONTHLY_MINUTES_PER_CLIENT = '50';
    const merged = mergeSettings(baseDefaults(), null, null);
    expect(merged.monthlyMinutesPerClient).toBe(50);
    expect(merged.sources.monthlyMinutesPerClient).toBe('default');
    const withAgency = mergeSettings(baseDefaults(), { monthlyMinutesPerClient: 80 }, null);
    expect(withAgency.monthlyMinutesPerClient).toBe(80);
  });

  it('client override beats agency default; null inherits', () => {
    const merged = mergeSettings(
      baseDefaults(),
      { monthlyMinutesPerClient: 80, autoApproveLowRisk: true, agencyMonthlyMinutes: 999 },
      { monthlyMinutesPerClient: 30, autoApproveLowRisk: null, agencyMonthlyMinutes: 1 }
    );
    expect(merged.monthlyMinutesPerClient).toBe(30);
    expect(merged.sources.monthlyMinutesPerClient).toBe('client');
    expect(merged.autoApproveLowRisk).toBe(true);
    expect(merged.sources.autoApproveLowRisk).toBe('agency');
    // agency cap cannot be overridden per client
    expect(merged.agencyMonthlyMinutes).toBe(999);
  });

  it('validates patches', () => {
    expect(sanitizeSettingsPatch({ monthlyMinutesPerClient: -1 }, { isAgency: true }).error).toBeTruthy();
    expect(sanitizeSettingsPatch({ autoApproveLowRisk: 'yes' }, { isAgency: true }).error).toBeTruthy();
    expect(sanitizeSettingsPatch({ agencyMonthlyMinutes: 10 }, { isAgency: false }).data).toEqual({});
    expect(
      sanitizeSettingsPatch({ transcriptRetentionDays: 30, clientCanViewOwnTranscripts: null }, { isAgency: false }).data
    ).toEqual({ transcriptRetentionDays: 30, clientCanViewOwnTranscripts: null });
  });

  it('resolveInterviewSettings reads agency + client rows', async () => {
    mocks.settingFindUnique.mockImplementation(({ where }) =>
      Promise.resolve(where.scope === 'AGENCY' ? { monthlyMinutesPerClient: 200 } : { monthlyMinutesPerClient: 10 })
    );
    const s = await resolveInterviewSettings('client-1');
    expect(s.monthlyMinutesPerClient).toBe(10);
  });
});

describe('getUsage uses the settings limit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes remaining minutes from the effective monthly limit and counts VOICE only', async () => {
    mocks.sessionAggregate.mockResolvedValue({ _sum: { durationSeconds: 600 } });
    mocks.sessionCount.mockResolvedValue(1);
    const usage = await getUsage('c1', { settings: { monthlyMinutesPerClient: 25 } });
    expect(usage.usedMinutes).toBe(10);
    expect(usage.remainingMinutes).toBe(15);
    expect(usage.remainingSeconds).toBe(900);
    expect(usage.monthlyLimitMinutes).toBe(25);
    expect(mocks.sessionAggregate.mock.calls[0][0].where.mode).toBe('VOICE');
  });
});
