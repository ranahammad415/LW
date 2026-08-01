import { describe, it, expect } from 'vitest';
import {
  renderFormalReportHtml,
  normalizeAiContent,
  esc,
  buildExecPagination,
  sectionPagesHtml,
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
    expect(html).toContain('footer-left');
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
  });
});
