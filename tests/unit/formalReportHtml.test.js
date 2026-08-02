import { describe, it, expect } from 'vitest';
import {
  renderFormalReportHtml,
  normalizeAiContent,
  esc,
  buildExecPagination,
  sectionPagesHtml,
  paginateUnits,
  groupUnits,
} from '../../src/lib/monthlyReport/formalTemplate/renderFormalHtml.js';

describe('formalTemplate/renderFormalHtml', () => {
  it('escapes HTML in user content', () => {
    expect(esc('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('normalizes legacy aiContent into formal shape', () => {
    const n = normalizeAiContent({
      executiveSummary: 'Cover style summary',
      seoPerformance: 'SEO notes',
      highlights: ['Win A', 'Win B'],
    });
    expect(n.coverSummary).toContain('Cover style');
    expect(n.executive.strategicApproach).toContain('Cover style');
    expect(n.executive.performanceGains).toContain('SEO notes');
  });

  it('renders cover, exec 01, section, and conclusion markers', () => {
    const html = renderFormalReportHtml({
      clientName: 'Test Client <LLC>',
      websiteUrl: 'https://example.com',
      month: 6,
      year: 2026,
      clientLogoDataUrl: null,
      foldDataUrl: null,
      agency: {
        agencyName: 'Local Waves',
        email: 'ops@example.com',
        phone: '+1 555',
        address: 'Milwaukee, WI',
        logoDataUrl: 'data:image/png;base64,aaa',
      },
      aiContent: {
        coverSummary: 'June was productive for Test Client.',
        preparedBy: 'Hamza Ashraf',
        executive: {
          strategicApproach: 'We prioritized authority.',
          performanceGains: 'CTR improved.',
          localVisibility: '',
          technicalHealth: 'CWV good.',
          nextSteps: 'Continue outreach.',
        },
        sections: [
          {
            number: 2,
            title: 'LOCAL SEO',
            intro: 'Citations this month.',
            blocks: [{ heading: 'Work completed', bullets: ['Listed on Hotfrog'] }],
            valueDelivered: 'Stronger local signals.',
          },
        ],
        conclusion: 'Solid month overall.',
      },
    });

    expect(html).toContain('SEO &amp; PERFORMANCE');
    expect(html).toContain('JUNE 2026');
    expect(html).toContain('Test Client &lt;LLC&gt;');
    expect(html).toContain('Executive Summary');
    expect(html).toContain('>01<');
    expect(html).toContain('LOCAL SEO');
    expect(html).toContain('VALUE DELIVERED:');
    expect(html).toContain('Stronger local signals.');
    expect(html).toContain('Conclusion');
    expect(html).toContain('ops@example.com');
    expect(html).toContain('example.com');
    expect(html).toContain('lw-wordmark');
    expect(html).toContain('– Strategic Approach –');
    expect(html).toContain('– Work completed –');
    expect(html).not.toContain('--- Work completed ---');
    expect(html).toContain('footer-left');
    // Conclusion always uses wordmark, not agency logo data URL
    expect(html).toContain('concl-logo-card');
    expect(html.match(/lw-wordmark/g)?.length || 0).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain('data:image/png;base64,aaa');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('📍');
  });

  it('paginates long executive content onto continuation pages', () => {
    const long = 'A'.repeat(900);
    const { pageCount, contHtml } = buildExecPagination(
      {
        strategicApproach: long,
        performanceGains: long,
        localVisibility: long,
        technicalHealth: long,
        nextSteps: long,
      },
      '2026 June - SEO & Performance Report',
    );
    expect(pageCount).toBeGreaterThan(1);
    expect(contHtml).toContain('(continued)');
  });

  it('never orphans a dash-heading from its following paragraph', () => {
    const long = 'X'.repeat(750);
    const nextBody = 'August will reverse the Growth Index decline with content and links.';
    const { firstHtml, contHtml } = buildExecPagination(
      {
        strategicApproach: long,
        performanceGains: long,
        localVisibility: long,
        technicalHealth: long,
        nextSteps: nextBody,
      },
      '2026 July - SEO & Performance Report',
    );

    const pages = [firstHtml, ...contHtml.split(/(?=<section class="page )/)];
    for (const page of pages) {
      if (page.includes('– Next Steps –')) {
        expect(page).toContain(nextBody);
      }
      const body = page.split('page-footer')[0] || page;
      expect(body.trim().endsWith('</h3>')).toBe(false);
    }

    const units = [
      { type: 'dash-heading', text: 'Next Steps', cost: 2 },
      { type: 'p', text: nextBody, cost: 3 },
    ];
    // Force a tiny first page so heading would orphan without keep-together
    const padded = [
      { type: 'dash-heading', text: 'A', cost: 2 },
      { type: 'p', text: 'a'.repeat(200), cost: 4 },
      { type: 'dash-heading', text: 'B', cost: 2 },
      { type: 'p', text: 'b'.repeat(200), cost: 4 },
      ...units,
    ];
    const pages2 = paginateUnits(padded, 8, 20);
    for (const page of pages2) {
      expect(page[page.length - 1].type).not.toBe('dash-heading');
    }
    const nextPage = pages2.find((p) => p.some((u) => u.text === 'Next Steps'));
    expect(nextPage?.some((u) => u.text === nextBody)).toBe(true);
  });

  it('groups subheads with bullets and keeps VALUE DELIVERED with prior content when it fits', () => {
    const grouped = groupUnits([
      { type: 'p', text: 'Intro', cost: 2 },
      { type: 'subhead', text: 'Work', cost: 2 },
      { type: 'li', text: 'Bullet one', cost: 1 },
      { type: 'li', text: 'Bullet two', cost: 1 },
      { type: 'value', text: 'Value text', cost: 2 },
    ]);
    expect(grouped).toHaveLength(3);
    expect(grouped[1].units.map((u) => u.type)).toEqual(['subhead', 'li', 'li']);
    expect(grouped[2].preferWithPrev).toBe(true);

    const pages = paginateUnits(
      [
        { type: 'p', text: 'Intro', cost: 2 },
        { type: 'subhead', text: 'Work', cost: 2 },
        { type: 'li', text: 'Bullet one', cost: 1 },
        { type: 'value', text: 'Value text', cost: 2 },
      ],
      40,
      40,
    );
    expect(pages).toHaveLength(1);
    expect(pages[0].map((u) => u.type)).toEqual(['p', 'subhead', 'li', 'value']);
  });

  it('paginates long section bullet lists across pages', () => {
    const bullets = Array.from({ length: 40 }, (_, i) => `Published citation link number ${i + 1} https://example.com/listing/${i}`);
    const html = sectionPagesHtml(
      [
        {
          number: 2,
          title: 'CITATIONS',
          intro: 'Many listings.',
          blocks: [{ heading: 'Live listings', bullets }],
          valueDelivered: 'Broad local footprint.',
        },
      ],
      '2026 June - SEO & Performance Report',
    );
    expect(html.match(/\(continued\)/g)?.length || 0).toBeGreaterThan(0);
    expect((html.match(/class="page /g) || []).length).toBeGreaterThan(1);
    expect(html).toContain('– Live listings –');
  });
});
