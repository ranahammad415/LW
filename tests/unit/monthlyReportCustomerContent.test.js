import { describe, it, expect } from 'vitest';
import {
  CLIENT_SYSTEM_PROMPT,
  snippet,
  plainTitleForTaskType,
  plainLabelForKpi,
  shapeCompletedTasks,
  shapeIssues,
  groupTasksIntoSections,
  buildFallbackFormalContent,
} from '../../src/lib/monthlyReport/generateForCycle.js';

describe('monthlyReport/generateForCycle customer content', () => {
  it('prompt requires plain-language customer rules', () => {
    expect(CLIENT_SYSTEM_PROMPT).toMatch(/non-technical/i);
    expect(CLIENT_SYSTEM_PROMPT).toMatch(/Paraphrase/i);
    expect(CLIENT_SYSTEM_PROMPT).toMatch(/Never invent/i);
    expect(CLIENT_SYSTEM_PROMPT).toMatch(/VALUE DELIVERED/i);
    expect(CLIENT_SYSTEM_PROMPT).toMatch(/Master Visibility Score|Growth Index|score names/i);
  });

  it('snippets truncate without inventing content', () => {
    expect(snippet('  hello   world  ', 20)).toBe('hello world');
    expect(snippet('a'.repeat(50), 10)).toBe(`${'a'.repeat(10)}…`);
    expect(snippet(null)).toBe('');
  });

  it('maps task types to plain customer titles', () => {
    expect(plainTitleForTaskType('Technical SEO')).toMatch(/Google/i);
    expect(plainTitleForTaskType('LOCAL SEO')).toMatch(/nearby|find/i);
    expect(plainTitleForTaskType('Weird_Custom_Type')).toBe('Weird Custom Type');
  });

  it('attaches plain KPI meaning hints', () => {
    expect(plainLabelForKpi('GROWTH_INDEX', 'Growth Index')).toMatch(/trending/i);
    expect(plainLabelForKpi('unknown', 'Master Visibility Score')).toMatch(/visible/i);
  });

  it('shapes completed tasks with bounded comments and no author fields', () => {
    const from = new Date('2026-07-01T00:00:00.000Z');
    const to = new Date('2026-08-01T00:00:00.000Z');
    const shaped = shapeCompletedTasks(
      [
        {
          title: 'Fix redirects',
          taskType: 'Technical SEO',
          description: 'Done',
          clientRequestNote: 'Please fix header links',
          clientProvidedResponse: 'Approved',
          deliverables: [{ fileUrl: 'https://example.com/a', notes: 'shipped' }],
          comments: [
            { parentId: null, content: 'Live on staging', createdAt: new Date('2026-07-10') },
            { parentId: 'reply', content: 'nested should skip', createdAt: new Date('2026-07-11') },
            { parentId: null, content: 'x'.repeat(300), createdAt: new Date('2026-07-12') },
            { parentId: null, content: 'outside month', createdAt: new Date('2026-06-01') },
          ],
        },
      ],
      { from, to },
    );

    expect(shaped).toHaveLength(1);
    expect(shaped[0].plainTitle).toMatch(/Google/i);
    expect(shaped[0].commentSnippets).toHaveLength(2);
    expect(shaped[0].commentSnippets[1].endsWith('…')).toBe(true);
    expect(shaped[0].clientRequestNote).toContain('header');
    expect(JSON.stringify(shaped[0])).not.toMatch(/userId|author/i);
  });

  it('shapes issues with resolution notes only', () => {
    const issues = shapeIssues({
      resolvedList: [
        {
          title: 'Broken contact form',
          priority: 'HIGH',
          description: 'Form 500s',
          comments: [{ body: 'Fixed and verified' }],
        },
      ],
      openedList: [
        { title: 'New logo request', status: 'OPEN', priority: 'LOW', description: 'Need SVG' },
      ],
    });
    expect(issues.resolvedCount).toBe(1);
    expect(issues.openedCount).toBe(1);
    expect(issues.resolved[0].resolutionNote).toContain('Fixed');
    expect(issues.opened[0].status).toBe('OPEN');
  });

  it('fallback sections use plain titles and add issues collaboration when present', () => {
    const facts = {
      clientName: 'Roman Electric',
      preparedBy: 'Local Waves',
      month: 7,
      year: 2026,
      tasks: {
        completed: 2,
        created: 2,
        stillOpen: 0,
        recentCompleted: [
          {
            title: 'Crawl audit',
            taskType: 'Technical SEO',
            description: 'Crawl done',
            deliverables: [],
            commentSnippets: [],
          },
        ],
      },
      content: { published: 1 },
      keywords: { accepted: 3 },
      aiVisibility: { promptsTested: 0, cited: 0, citationRate: 0, platforms: [] },
      searchKpis: [
        { metric: 'GROWTH_INDEX', label: 'Growth Index', value: '-10%', change: 'down', plainLabel: plainLabelForKpi('GROWTH_INDEX') },
      ],
      collaboration: { commentActivityCount: 4, tasksWithComments: 1 },
      issues: {
        resolvedCount: 1,
        openedCount: 0,
        resolved: [{ title: 'Form bug', priority: 'HIGH', description: 'fixed', resolutionNote: 'ok' }],
        opened: [],
      },
      clientInputs: [],
    };

    const sections = groupTasksIntoSections(facts);
    expect(sections.some((s) => /GOOGLE|EASIER/i.test(s.title))).toBe(true);
    expect(sections.some((s) => /ISSUES WE RESOLVED/i.test(s.title))).toBe(true);
    expect(sections.length).toBeLessThanOrEqual(6);

    const fallback = buildFallbackFormalContent(facts);
    expect(fallback.coverSummary).toMatch(/Roman Electric/);
    expect(fallback.coverSummary).not.toMatch(/workstream/i);
    expect(fallback.executive.performanceGains).toMatch(/plain terms|visibility|trending/i);
    expect(fallback.sections.some((s) => /RESOLVED/i.test(s.title))).toBe(true);
  });
});
