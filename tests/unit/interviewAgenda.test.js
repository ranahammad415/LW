import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }));

import { composeAgenda, MAX_PRIMARY, MAX_FOLLOWUP, openQuestions, sanitizeQuestion } from '../../src/lib/interviewAgenda.js';
import { QUESTION_BANK, TEMPLATE_KEYS, bankForTemplate } from '../../src/lib/interviewQuestionBank.js';
import { CAPTURE_FOLDERS } from '../../src/lib/expertInterview.js';

const NOW = new Date('2026-10-15T09:00:00Z');

describe('interview question bank', () => {
  it('only uses capture folders and has unique ids', () => {
    const ids = new Set();
    for (const q of QUESTION_BANK) {
      expect(CAPTURE_FOLDERS).toContain(q.folder);
      expect(ids.has(q.id)).toBe(false);
      ids.add(q.id);
      expect(q.topic.length).toBeLessThanOrEqual(120);
    }
  });

  it('every template has bank questions', () => {
    for (const key of TEMPLATE_KEYS) expect(bankForTemplate(key).length).toBeGreaterThan(0);
  });
});

describe('composeAgenda', () => {
  it('puts KB gaps first, then stale files, then the bank', () => {
    const agenda = composeAgenda({
      templateKey: 'ONBOARDING',
      assessment: { missing: ['voice/brand-voice.md'], profileComplete: true },
      gapReport: {
        items: [
          { category: 'proof', severity: 'Low', description: 'No case studies.' },
          { category: 'services', severity: 'High', description: 'No pricing info.' },
        ],
        recommendedQuestions: [{ category: 'services', question: 'What does your main service cost?' }],
      },
      files: [
        { folder: 'services', filename: 'boiler-repair.md', title: 'Boiler repair', updated_at: '2025-01-01T00:00:00Z' },
        { folder: 'company', filename: 'profile.md', title: 'Profile', updated_at: '2026-10-01T00:00:00Z' },
      ],
      now: NOW,
    });
    const ids = agenda.questions.map((q) => q.id);
    expect(ids[0]).toBe('voice-tone');
    // HIGH severity gap comes before LOW
    expect(agenda.questions[1].prompt).toBe('What does your main service cost?');
    expect(agenda.questions[1].folder).toBe('services');
    expect(ids).toContain('confirm-services-boiler-repair');
    // covered profile → the "what you do" bank question is skipped
    expect(ids).not.toContain('company-what-you-do');
    expect(agenda.doNotAsk.some((d) => d.includes('company/profile'))).toBe(true);
    expect(agenda.goals.length).toBe(1);
  });

  it('caps primary and follow-up questions', () => {
    const agenda = composeAgenda({
      templateKey: 'ONBOARDING',
      assessment: { missing: [] },
      gapReport: { items: Array.from({ length: 10 }, (_, i) => ({ category: 'faq', severity: 'High', description: `Gap ${i}` })) },
      files: [],
      now: NOW,
    });
    const primary = agenda.questions.filter((q) => q.kind === 'primary');
    const followup = agenda.questions.filter((q) => q.kind === 'followup');
    expect(primary.length).toBeLessThanOrEqual(MAX_PRIMARY);
    expect(followup.length).toBeLessThanOrEqual(MAX_FOLLOWUP);
  });

  it('monthly update never asks the basics again', () => {
    const agenda = composeAgenda({ templateKey: 'MONTHLY_UPDATE', assessment: { missing: ['company/profile.md'] }, files: [], now: NOW });
    expect(agenda.questions.map((q) => q.id)).not.toContain('company-what-you-do');
    expect(agenda.questions.map((q) => q.id)).toContain('company-changes');
  });

  it('applies owner overrides (full replacement from the editor)', () => {
    const agenda = composeAgenda({
      templateKey: 'CUSTOM',
      assessment: {},
      files: [],
      overrides: {
        goals: ['Plan the spring push'],
        questions: [
          { prompt: 'What is the spring offer?', folder: 'seo/local' },
          { prompt: '  ', folder: 'x' },
          { prompt: 'Anything else?', folder: 'not-a-folder' },
        ],
      },
      now: NOW,
    });
    expect(agenda.goals).toEqual(['Plan the spring push']);
    expect(agenda.questions).toHaveLength(2);
    expect(agenda.questions[0].folder).toBe('seo/local');
    expect(agenda.questions[1].folder).toBe('company');
  });

  it('remove/add overrides keep ids unique', () => {
    const base = composeAgenda({ templateKey: 'MONTHLY_UPDATE', assessment: {}, files: [], now: NOW });
    const removed = base.questions[0].id;
    const agenda = composeAgenda({
      templateKey: 'MONTHLY_UPDATE',
      assessment: {},
      files: [],
      overrides: { removeQuestionIds: [removed], addQuestions: [{ prompt: 'New van?', folder: 'company' }] },
      now: NOW,
    });
    const ids = agenda.questions.map((q) => q.id);
    expect(ids).not.toContain(removed);
    expect(new Set(ids).size).toBe(ids.length);
    expect(agenda.questions[0].prompt).toBe('New van?');
  });

  it('openQuestions skips answered and delegated', () => {
    const open = openQuestions({ questions: [{ id: 'a' }, { id: 'b', answeredBy: 'x' }, { id: 'c', delegatedTo: 'y' }] });
    expect(open.map((q) => q.id)).toEqual(['a']);
  });

  it('sanitizeQuestion trims and bounds input', () => {
    const q = sanitizeQuestion({ prompt: 'x'.repeat(500), folder: 'services/boilers' });
    expect(q.prompt.length).toBeLessThanOrEqual(300);
    expect(q.folder).toBe('services');
    expect(sanitizeQuestion({ prompt: '' })).toBeNull();
  });
});
