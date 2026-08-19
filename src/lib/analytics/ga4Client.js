/**
 * GA4 Data API client (agency OAuth).
 */
import { google } from 'googleapis';
import { getAgencyOAuth2Client } from './googleAuth.js';

function fmt(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Run a GA4 report for a property.
 * @param {string} propertyId - numeric GA4 property id
 * @param {{ startDate: Date, endDate: Date, dimensions?: string[], metrics?: string[] }} opts
 */
export async function runGa4Report(propertyId, opts) {
  const auth = await getAgencyOAuth2Client();
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth });
  const dimensions = (opts.dimensions || []).map((name) => ({ name }));
  const metrics = (opts.metrics || ['sessions']).map((name) => ({ name }));

  const res = await analyticsdata.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [
        {
          startDate: opts.startDate instanceof Date ? opts.startDate.toISOString().slice(0, 10) : opts.startDate,
          endDate: opts.endDate instanceof Date ? opts.endDate.toISOString().slice(0, 10) : opts.endDate,
        },
      ],
      dimensions,
      metrics,
      limit: opts.limit || '10000',
    },
  });

  const dimHeaders = (res.data.dimensionHeaders || []).map((h) => h.name);
  const metHeaders = (res.data.metricHeaders || []).map((h) => h.name);
  return (res.data.rows || []).map((row) => {
    const out = {};
    (row.dimensionValues || []).forEach((v, i) => {
      out[dimHeaders[i]] = v.value;
    });
    (row.metricValues || []).forEach((v, i) => {
      out[metHeaders[i]] = Number(v.value) || 0;
    });
    return out;
  });
}

export { fmt as ga4DateFmt };
