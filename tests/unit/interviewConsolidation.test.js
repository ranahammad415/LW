import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  sessionFindUnique: vi.fn(),
  draftFindMany: vi.fn(),
  draftFindFirst: vi.fn(),
  draftUpdate: vi.fn(),
  readOkfFile: vi.fn(),
  generateChat: vi.fn(),
  logCreate: vi.fn(),
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    voiceInterviewSession: { findUnique: m.sessionFindUnique },
    okfDraftChange: { findMany: m.draftFindMany, findFirst: m.draftFindFirst, update: m.draftUpdate },
    interviewDispatchLog: { create: m.logCreate },
  },
}));
vi.mock('../../src/lib/knowledgeEngine.js', () => ({
  readOkfFile: m.readOkfFile,
  listClientFiles: () => [],
  searchKnowledgeContext: () => [],
}));
vi.mock('../../src/lib/ai.js', () => ({
  generateChat: m.generateChat,
  isAiConfigured: () => true,
  sanitizeUserInputForPrompt: (s) => String(s || ''),
}));

import {
  computeDedupeHash,
  classifyRisk,
  parseRestrictedPhrases,
  matchRestrictedClaims,
  detectHesitation,
  applyAiVerdict,
  mergeIntoCurrent,
  consolidateSession,
} from '../../src/lib/interviewConsolidation.js';

beforeEach(() => {
  vi.clearAllMocks();
  m.draftFindFirst.mockResolvedValue(null);
  m.draftUpdate.mockResolvedValue({});
  m.sessionFindUnique.mockResolvedValue({ id: 's1', clientId: 'c1', inviteId: 'inv-1', transcript: [] });
});

describe('pure rules', () => {
  it('dedupe hash ignores headings, case and punctuation but not the target file', () => {
    const a = computeDedupeHash({ folder: 'company', filename: 'hours', content: '# Hours\nOpen 8am–6pm!' });
    const b = computeDedupeHash({ folder: 'company', filename: 'hours', content: 'open 8am 6pm' });
    const c = computeDedupeHash({ folder: 'company', filename: 'other', content: 'open 8am 6pm' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('risk levels', () => {
    expect(classifyRisk({ folder: 'faq', content: 'We answer within a day', factType: 'faq' })).toBe('LOW');
    expect(classifyRisk({ folder: 'services', content: 'x', factType: 'price' })).toBe('HIGH');
    expect(classifyRisk({ folder: 'company', filename: 'approved-claims', content: 'x' })).toBe('HIGH');
    expect(classifyRisk({ folder: 'services', content: 'We are the cheapest in Leeds' })).toBe('HIGH');
    expect(classifyRisk({ folder: 'services', content: 'x', changeKind: 'CONFLICT' })).toBe('MEDIUM');
    expect(classifyRisk({ folder: 'voice', content: 'friendly' })).toBe('MEDIUM');
    expect(classifyRisk({ folder: 'faq', content: 'x', restrictedMatches: ['x'] })).toBe('HIGH');
  });

  it('restricted claims parsing and matching', () => {
    const phrases = parseRestrictedPhrases('# Restricted\n- Cheapest in Leeds\n* "24/7 emergency"\n');
    expect(phrases).toEqual(['cheapest in leeds', '24/7 emergency']);
    expect(matchRestrictedClaims('We offer 24/7 Emergency callouts', phrases)).toEqual(['24/7 emergency']);
  });

  it('hesitation detection', () => {
    expect(detectHesitation('I think we open at 7')).toBe(true);
    expect(detectHesitation('We open at 7, definitely')).toBe(false);
  });

  it('AI verdicts only escalate', () => {
    const base = { changeKind: 'UPDATE', riskLevel: 'LOW', notes: [] };
    expect(applyAiVerdict(base, { hesitant: true }).changeKind).toBe('CONFLICT');
    expect(applyAiVerdict(base, { changeKind: 'CONFLICT' }).riskLevel).toBe('MEDIUM');
    expect(applyAiVerdict({ changeKind: 'CONFLICT', riskLevel: 'MEDIUM', notes: [] }, { changeKind: 'NEW' }).changeKind).toBe('CONFLICT');
    expect(applyAiVerdict({ changeKind: 'NEW', riskLevel: 'HIGH', notes: [] }, { quoteSupports: false }).riskLevel).toBe('HIGH');
    expect(applyAiVerdict(base, { quoteSupports: false }).notes[0]).toMatch(/quote/);
  });

  it('mergeIntoCurrent appends a dated section', () => {
    const merged = mergeIntoCurrent('# MOT\nFrom £40', { title: 'Same-day MOT', content: '# Same-day\nWe now do same-day MOTs', date: new Date('2026-10-15') });
    expect(merged).toContain('# MOT\nFrom £40');
    expect(merged).toContain('## Same-day MOT (interview 2026-10-15)');
    expect(merged).toContain('We now do same-day MOTs');
  });
});

describe('consolidateSession', () => {
  it('rejects pure duplicates, merges updates, flags restricted claims, and logs', async () => {
    m.readOkfFile.mockImplementation((clientId, folder, filename) => {
      if (folder === 'company' && filename === 'restricted-claims') return { metadata: {}, body: '- cheapest in town' };
      if (folder === 'services' && filename === 'mot') return { metadata: {}, body: 'MOT from £40. Open 8am to 6pm weekdays.' };
      throw new Error('nf');
    });
    m.draftFindMany.mockResolvedValue([
      { id: 'dup', clientId: 'c1', folder: 'services', filename: 'mot', title: 'Hours', proposedBody: 'Open 8am to 6pm weekdays.', proposedMetadata: {}, changeKind: 'NEW' },
      { id: 'upd', clientId: 'c1', folder: 'services', filename: 'mot', title: 'Same day', proposedBody: 'We now do same-day MOTs', proposedMetadata: {}, changeKind: 'NEW', sourceQuote: 'yes we do same day' },
      { id: 'new', clientId: 'c1', folder: 'faq', filename: 'prices', title: 'Price', proposedBody: 'We are the cheapest in town', proposedMetadata: {}, changeKind: 'NEW' },
    ]);
    m.generateChat.mockResolvedValue({ parsed: { verdicts: [{ id: 'upd', hesitant: false, changeSummary: 'Adds same-day MOTs' }] } });

    const res = await consolidateSession('s1', { now: new Date('2026-10-15') });
    expect(res).toMatchObject({ processed: 2, duplicates: 1 });

    const byId = Object.fromEntries(m.draftUpdate.mock.calls.map((c) => [c[0].where.id, c[0].data]));
    expect(byId.dup).toMatchObject({ status: 'REJECTED', reviewNote: 'Duplicate of services/mot.md' });
    expect(byId.upd.changeKind).toBe('UPDATE');
    expect(byId.upd.proposedBody).toContain('MOT from £40');
    expect(byId.upd.proposedBody).toContain('We now do same-day MOTs');
    expect(byId.upd.proposedMetadata.capture_fragment).toBe('We now do same-day MOTs');
    expect(byId.upd.changeSummary).toBe('Adds same-day MOTs');
    expect(byId.upd.currentBodyHash).toHaveLength(64);
    expect(byId.new.riskLevel).toBe('HIGH');
    expect(byId.new.proposedMetadata.restricted_matches).toEqual(['cheapest in town']);
    expect(m.generateChat.mock.calls[0][0].feature).toBe('interview_consolidation');
    expect(m.logCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ kind: 'CONSOLIDATE' }) }));
  });

  it('a hesitant confirmed change becomes CONFLICT even without AI', async () => {
    m.readOkfFile.mockImplementation(() => ({ metadata: {}, body: 'Open 8am' }));
    m.draftFindMany.mockResolvedValue([
      { id: 'c', clientId: 'c1', folder: 'company', filename: 'hours', title: 'Hours', proposedBody: 'Open 7am', proposedMetadata: { change: { new_value: '7am' } }, changeKind: 'UPDATE', riskLevel: 'MEDIUM', sourceQuote: 'I think it is 7 now' },
    ]);
    await consolidateSession('s1', { useAi: false });
    expect(m.draftUpdate.mock.calls[0][0].data.changeKind).toBe('CONFLICT');
    expect(m.generateChat).not.toHaveBeenCalled();
  });

  it('survives an AI failure with the deterministic result', async () => {
    m.readOkfFile.mockImplementation(() => { throw new Error('nf'); });
    m.draftFindMany.mockResolvedValue([{ id: 'n', clientId: 'c1', folder: 'faq', filename: 'q', title: 'Q', proposedBody: 'Answer here', proposedMetadata: {}, changeKind: 'NEW' }]);
    m.generateChat.mockRejectedValue(new Error('529'));
    const res = await consolidateSession('s1');
    expect(res.byRisk.LOW).toBe(1);
  });
});
