import { describe, it, expect } from 'vitest';
import { parseCsv, detectColumnMap, rowsToTaskGroups } from '../../src/lib/dataImport/csvTaskParser.js';
import { normalizeStatus, slugRef } from '../../src/lib/dataImport/constants.js';

describe('csvTaskParser', () => {
  it('parses CSV with quoted fields', () => {
    const csv = 'Main Task,Sub Task,Assignee,Status\n"Authority / Links","Build list",mudassar,Done';
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe('Authority / Links');
    expect(rows[1][3]).toBe('Done');
  });

  it('detects column aliases', () => {
    const map = detectColumnMap(['Main Task', 'Sub Task', 'Assignee', 'Status', 'Step 1']);
    expect(map.milestone).toBe(0);
    expect(map.title).toBe(1);
    expect(map.assignee).toBe(2);
    expect(map.status).toBe(3);
    expect(map.stepCols).toEqual([4]);
  });

  it('maps rows to task groups', () => {
    const rows = [
      ['Milestone', 'Sub Task', 'Assignee', 'Status'],
      ['On-Page SEO', 'Meta optimisation', 'bisma', 'In Progress'],
      ['On-Page SEO', 'Internal linking', 'awais', 'To Do'],
    ];
    const groups = rowsToTaskGroups(rows, 'test');
    expect(groups).toHaveLength(1);
    expect(groups[0].milestone).toBe('On-Page SEO');
    expect(groups[0].tasks).toHaveLength(2);
    expect(groups[0].tasks[0].progress.status).toBe('IN_PROGRESS');
  });
});

describe('constants', () => {
  it('normalizes status strings', () => {
    expect(normalizeStatus('done')).toBe('COMPLETED');
    expect(normalizeStatus('IN_PROGRESS')).toBe('IN_PROGRESS');
  });

  it('slugRef produces kebab-case', () => {
    expect(slugRef('task', 'Meta Title & Desc')).toMatch(/^task-meta-title/);
  });
});
