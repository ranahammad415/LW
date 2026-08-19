/**
 * Nightly analytics sync orchestrator (GA4 + GMB + DataForSEO).
 * GSC remains on its existing cron via runGscSync.
 */
import { runGa4Sync } from './ga4Sync.js';
import { runGmbSync } from './gmbSync.js';
import { runDataForSeoSync } from './dfsSync.js';

export async function runNativeAnalyticsSync(log = console) {
  const out = {};
  try {
    out.ga4 = await runGa4Sync();
    log?.info?.(out.ga4, 'GA4 sync complete');
  } catch (err) {
    out.ga4 = { error: err.message };
    log?.error?.({ err }, 'GA4 sync failed');
  }
  try {
    out.gmb = await runGmbSync();
    log?.info?.(out.gmb, 'GMB sync complete');
  } catch (err) {
    out.gmb = { error: err.message };
    log?.error?.({ err }, 'GMB sync failed');
  }
  try {
    out.dataforseo = await runDataForSeoSync();
    log?.info?.(out.dataforseo, 'DataForSEO sync complete');
  } catch (err) {
    out.dataforseo = { error: err.message };
    log?.error?.({ err }, 'DataForSEO sync failed');
  }
  return out;
}
