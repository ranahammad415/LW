import { describe, it, expect } from 'vitest';
import { parsePhinixSheetRows } from '../../src/lib/dataImport/phinixAssigneeParser.js';
import { resolveAssigneeKey } from '../../src/lib/dataImport/phinixSheetConfig.js';
import {
  buildDeliverableComment,
  buildMilestoneSummaryComment,
  normalizePhinixCommentContent,
  isEnrichedPhinixComment,
} from '../../src/lib/dataImport/phinixTaskEnrichment.js';
import { buildClientPmUpdate } from '../../src/lib/dataImport/phinixPmUpdateBuilder.js';

describe('phinixAssigneeParser', () => {
  it('parses assignee sheet rows with status and completion details', () => {
    const rows = [
      [
        'Hamza — Task List',
        'Section',
        'Main Task',
        'Sub Task / Task Name',
        'Main Goal',
        'Task Description',
        'Steps',
        'Status',
        'Completion Details',
        'Start Date',
        'End Date',
      ],
      [
        '2',
        'A',
        'Local SEO Expansion',
        'GBP growth',
        'Improve local rankings',
        'Optimize GBP',
        'Optimize details / Publish posts',
        'Completed',
        'Roman Electric GMB Posts links',
        '',
        '',
      ],
      [
        '3',
        'B',
        'Advanced Technical SEO',
        'Crawl budget',
        'Improve indexing',
        'Fix crawl issues',
        'Fix robots.txt',
        'Pending',
        '',
        '',
        '',
      ],
    ];

    const { taskGroups, taskUpdates, stats } = parsePhinixSheetRows(rows, {
      defaultAssigneeKey: 'hamza',
      projectRef: 'roman',
    });

    expect(stats.tasks).toBe(2);
    expect(taskGroups).toHaveLength(2);
    expect(taskGroups[0].milestone).toBe('Local SEO Expansion');
    expect(taskGroups[0].tasks[0].progress.status).toBe('COMPLETED');
    expect(taskUpdates).toHaveLength(2);
    expect(taskUpdates[0].completion.isComplete).toBe(true);
    expect(taskUpdates[0].update).toContain('Roman Electric GMB Posts');
    expect(taskUpdates[1].completion.status).toBe('TO_DO');
  });

  it('resolveAssigneeKey maps tab names', () => {
    expect(resolveAssigneeKey('M Sami')).toBe('sami');
    expect(resolveAssigneeKey('Mudassar')).toBe('mudassar');
    expect(resolveAssigneeKey('Haider')).toBe('haider');
  });

  it('builds plain-text comments without marker or markdown', () => {
    const body = buildDeliverableComment({
      milestone: 'Local SEO Expansion',
      title: 'GBP growth',
      goal: 'Improve rankings',
      completionDetails: 'GMB posts published',
      assigneeKey: 'hamza',
      assigneeTabName: 'HA',
      spreadsheetId: 'abc123',
      projectLabel: 'Roman Electric',
      masterTab: 'Roman Electric - Q2',
    });
    expect(body).not.toContain('[phinix-sheet-enriched]');
    expect(body).not.toContain('**');
    expect(body).not.toContain('##');
    expect(body).toContain('GBP growth');
    expect(body).toContain('Source spreadsheets');
    expect(isEnrichedPhinixComment(body)).toBe(true);
  });

  it('normalizes legacy markdown comments', () => {
    const legacy = `[phinix-sheet-enriched]\n## Milestone summary: Local SEO\n\n**GBP growth** (hamza): done`;
    const clean = normalizePhinixCommentContent(legacy);
    expect(clean).not.toContain('[phinix-sheet-enriched]');
    expect(clean).not.toContain('**');
    expect(clean).not.toContain('##');
    expect(clean).toContain('Milestone summary: Local SEO');
    expect(clean).toContain('GBP growth (hamza): done');
  });

  it('buildMilestoneSummaryComment uses plain text', () => {
    const body = buildMilestoneSummaryComment(
      'Local SEO Expansion',
      [{ title: 'GBP growth', assigneeKey: 'hamza', _completionDetails: 'Done' }],
      'Roman Electric',
      'sheet-id',
      'Roman Electric - Q2',
    );
    expect(body).not.toContain('**');
    expect(body).toContain('Milestone summary: Local SEO Expansion');
  });
});

describe('phinixPmUpdateBuilder', () => {
  it('builds positive plain-text client PM update', () => {
    const message = buildClientPmUpdate({
      projectName: 'SEO - Roman Electric Co.',
      planLabel: 'Roman Electric Q2 — Jun 2026',
      taskGroups: [
        {
          milestone: 'Local SEO Expansion',
          tasks: [
            { ref: 't1', title: 'GBP growth', progress: { status: 'COMPLETED' } },
            { ref: 't2', title: 'Local schema', progress: { status: 'COMPLETED' } },
          ],
        },
      ],
      taskUpdates: [
        {
          taskRef: 't1',
          update: 'GMB posts published successfully\n\nSheet status: Completed',
          completion: { isComplete: true },
        },
      ],
      authorKey: 'hamza',
    });

    expect(message).not.toContain('**');
    expect(message).not.toContain('##');
    expect(message).toContain('Hello Roman Electric team');
    expect(message).toContain('excited to share a positive progress update');
    expect(message).toContain('local search presence');
    expect(message).toContain('GMB posts published successfully');
    expect(message).toContain('Phinix Solutions SEO Team');
  });
});
