import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  upsert: vi.fn(),
  draftCreate: vi.fn(),
  inviteFindUnique: vi.fn(),
  inviteUpdate: vi.fn(),
  activityCreate: vi.fn(),
  sessionUpdate: vi.fn(),
  readOkfFile: vi.fn(),
  createDelegation: vi.fn(),
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    okfDraftChange: { create: m.draftCreate },
    knowledgeInterviewInvite: { findUnique: m.inviteFindUnique, update: m.inviteUpdate },
    clientActivityLog: { create: m.activityCreate },
    voiceInterviewSession: { update: m.sessionUpdate },
  },
}));
vi.mock('../../src/lib/expertInterview.js', async (orig) => ({ ...(await orig()), upsertInterviewDrafts: m.upsert }));
vi.mock('../../src/lib/knowledgeEngine.js', () => ({
  readOkfFile: m.readOkfFile,
  listClientFiles: () => [],
  searchKnowledgeContext: () => [],
}));
vi.mock('../../src/lib/interviewDelegation.js', async (orig) => ({ ...(await orig()), createDelegation: m.createDelegation }));

import {
  applyChangeToBody,
  inferFactType,
  processInterviewTool,
  mergeTranscript,
  coerceFolder,
  allowLookup,
} from '../../src/lib/interviewCapture.js';

const invite = {
  id: 'inv-1',
  rootInviteId: 'inv-1',
  clientId: 'c1',
  createdById: 'owner1',
  recipientName: 'Hina',
  respondentRole: 'CLIENT',
  templateKey: 'MONTHLY_UPDATE',
};
const session = { id: 's1', mode: 'VOICE' };

beforeEach(() => {
  vi.clearAllMocks();
  m.upsert.mockResolvedValue([{ id: 'd1', title: 'Opening hours', folder: 'company', filename: 'hours' }]);
  m.inviteFindUnique.mockResolvedValue({ agenda: { questions: [{ id: 'company-hours' }], gaps: [] } });
  m.inviteUpdate.mockResolvedValue({});
  m.draftCreate.mockImplementation(async ({ data }) => ({ id: 'd2', ...data }));
  m.sessionUpdate.mockResolvedValue({});
  m.activityCreate.mockResolvedValue({});
});

describe('helpers', () => {
  it('applyChangeToBody replaces a single matching line in place', () => {
    const { body, replacedInPlace } = applyChangeToBody('# Hours\n\nMon–Fri 8am–6pm\nSat closed\n', {
      field: 'opening hours', oldValue: '8am–6pm', newValue: '7am–7pm',
    });
    expect(replacedInPlace).toBe(true);
    expect(body).toContain('Mon–Fri 7am–7pm');
    expect(body).toContain('Sat closed');
  });

  it('applyChangeToBody appends an Update section when no single line matches', () => {
    const { body, replacedInPlace } = applyChangeToBody('From £80\nalso £80 call-out', {
      field: 'price from', oldValue: '£80', newValue: '£95', effectiveFrom: 'November', date: new Date('2026-10-15'),
    });
    expect(replacedInPlace).toBe(false);
    expect(body).toContain('## Update (2026-10-15)');
    expect(body).toContain('**price from**: £80 → £95 (from November)');
  });

  it('inferFactType', () => {
    expect(inferFactType('price from')).toBe('price');
    expect(inferFactType('opening hours')).toBe('hours');
    expect(inferFactType('phone number')).toBe('contact');
    expect(inferFactType('guarantee')).toBe('claim');
    expect(inferFactType('service area')).toBe('location');
    expect(inferFactType('team size')).toBe('person');
  });

  it('coerceFolder only allows capture folders', () => {
    expect(coerceFolder('proof/case-studies')).toBe('proof/case-studies');
    expect(coerceFolder('services/boilers')).toBe('services');
    expect(coerceFolder('../etc')).toBeNull();
  });

  it('mergeTranscript is append-only by index', () => {
    const a = mergeTranscript([], [{ index: 1, role: 'user', content: 'b' }, { index: 0, role: 'assistant', content: 'a' }]);
    const b = mergeTranscript(a, [{ index: 1, role: 'user', content: 'rewritten' }, { index: 2, role: 'user', content: 'c' }]);
    expect(b.map((t) => t.content)).toEqual(['a', 'b', 'c']);
  });

  it('lookup limiter allows 60 per window', () => {
    let allowed = 0;
    for (let i = 0; i < 70; i++) if (allowLookup('sess-x', 1000)) allowed++;
    expect(allowed).toBe(60);
  });
});

describe('processInterviewTool', () => {
  it('save_business_fact files a draft with full provenance and marks the agenda', async () => {
    const { result, ack } = await processInterviewTool({
      invite,
      session,
      tool: 'save_business_fact',
      args: {
        folder: 'company', filename: 'Opening Hours', title: 'Opening hours', content: 'Mon–Fri 7–7',
        fact_type: 'hours', source_quote: 'we open at seven now', agenda_question_id: 'company-hours', confidence: 0.9,
      },
      transcriptRef: { turnIndex: 4, at: '2026-10-15T09:00:00Z' },
    });
    expect(result.ok).toBe(true);
    expect(ack).toMatchObject({ kind: 'capture', draftId: 'd1', changeKind: 'NEW' });
    const call = m.upsert.mock.calls[0][0];
    expect(call.sourceType).toBe('INTERVIEW_LINK');
    expect(call.provenance).toEqual({ inviteId: 'inv-1', rootInviteId: 'inv-1', respondentRole: 'CLIENT', respondentName: 'Hina' });
    expect(call.captures[0]).toMatchObject({ filename: 'opening-hours', factType: 'hours', sourceQuote: 'we open at seven now' });
    expect(call.captures[0].transcriptRef).toEqual({ sessionId: 's1', turnIndex: 4, at: '2026-10-15T09:00:00Z' });
    const agendaWrite = m.inviteUpdate.mock.calls[0][0].data.agenda;
    expect(agendaWrite.questions[0].answeredBy).toBe('inv-1');
  });

  it('rejects invalid folders and unknown tools', async () => {
    expect((await processInterviewTool({ invite, session, tool: 'save_business_fact', args: { folder: 'secret', filename: 'x', title: 't', content: 'abc' } })).result.ok).toBe(false);
    expect((await processInterviewTool({ invite, session, tool: 'rm_rf', args: {} })).result.ok).toBe(false);
  });

  it('confirm_change: confirmed → UPDATE, price → HIGH, hashes the current body', async () => {
    m.readOkfFile.mockReturnValue({ metadata: { title: 'MOT', type: 'service' }, body: 'MOT from £40\n' });
    const { ack } = await processInterviewTool({
      invite, session, tool: 'confirm_change',
      args: { folder: 'services', filename: 'services/mot', field: 'price from', old_value: '£40', new_value: '£45', client_confirmed: true, source_quote: 'it is 45 now' },
    });
    const data = m.draftCreate.mock.calls[0][0].data;
    expect(data.changeKind).toBe('UPDATE');
    expect(data.riskLevel).toBe('HIGH');
    expect(data.proposedBody).toContain('MOT from £45');
    expect(data.currentBodyHash).toHaveLength(64);
    expect(data.proposedMetadata.change).toMatchObject({ old_value: '£40', new_value: '£45' });
    expect(ack.kind).toBe('change');
  });

  it('confirm_change: unconfirmed → CONFLICT, MEDIUM for a non-sensitive field', async () => {
    m.readOkfFile.mockImplementation(() => { throw new Error('nf'); });
    await processInterviewTool({
      invite, session, tool: 'confirm_change',
      args: { folder: 'locations', filename: 'areas', field: 'team size', old_value: '5', new_value: '7', client_confirmed: false },
    });
    const data = m.draftCreate.mock.calls[0][0].data;
    expect(data.changeKind).toBe('CONFLICT');
    expect(data.riskLevel).toBe('MEDIUM');
    expect(data.currentBodyHash).toBeNull();
  });

  it('delegate_questions returns needs_confirmation and a confirm-card ack', async () => {
    m.createDelegation.mockResolvedValue({
      child: { id: 'child-1', recipientName: 'Asif', sentToEmail: 'asif@alnoor.com', respondentJobRole: 'manager', status: 'PENDING_CONFIRM', questionCluster: [{ topic: 'Prices' }] },
      clusterSize: 1,
    });
    const { result, ack } = await processInterviewTool({
      invite, session, tool: 'delegate_questions',
      args: { worker_name: 'Asif', worker_email: 'asif@alnoor.com', reason: 'he knows prices', agenda_question_ids: ['svc-1'] },
    });
    expect(result.status).toBe('needs_confirmation');
    expect(result.spoken_confirmation).toContain('tap Confirm');
    expect(result.spoken_confirmation).not.toContain('asif@alnoor.com');
    expect(ack).toMatchObject({ kind: 'delegation', childId: 'child-1', clusterSize: 1 });
    expect(m.createDelegation.mock.calls[0][0].viaSpeech).toBe(true);
  });

  it('flag_knowledge_gap logs activity attributed to the invite creator', async () => {
    await processInterviewTool({ invite, session, tool: 'flag_knowledge_gap', args: { category: 'proof', description: 'No reviews yet' } });
    expect(m.activityCreate.mock.calls[0][0].data).toMatchObject({ userId: 'owner1', action: 'INTERVIEW_KNOWLEDGE_GAP' });
  });
});
