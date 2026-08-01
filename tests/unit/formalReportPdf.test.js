import { describe, it, expect } from 'vitest';
import { renderFormalReportHtml } from '../../src/lib/monthlyReport/formalTemplate/renderFormalHtml.js';
import { renderFormalPdfBuffer } from '../../src/lib/monthlyReport/renderFormalPdf.js';

const runPdf = process.env.PLAYWRIGHT_PDF !== '0';

describe('formal PDF render (Playwright)', () => {
  it.skipIf(!runPdf)('produces a PDF buffer with %PDF magic', async () => {
    const html = renderFormalReportHtml({
      clientName: 'PDF Smoke Client',
      websiteUrl: 'https://example.com',
      month: 6,
      year: 2026,
      agency: { email: 'a@b.com', phone: '1', address: 'WI' },
      aiContent: {
        coverSummary: 'Smoke cover.',
        preparedBy: 'Local Waves',
        executive: {
          strategicApproach: 'Plan',
          performanceGains: 'Gains',
          localVisibility: '',
          technicalHealth: '',
          nextSteps: 'Next',
        },
        sections: [
          {
            number: 2,
            title: 'TEST SECTION',
            intro: 'Intro',
            blocks: [{ heading: 'Work', bullets: ['Item one'] }],
            valueDelivered: 'Value',
          },
        ],
        conclusion: 'Done.',
      },
    });
    const buf = await renderFormalPdfBuffer(html);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 4).toString('utf8')).toBe('%PDF');
  }, 90_000);
});
