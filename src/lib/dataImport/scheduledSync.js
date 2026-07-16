import { buildPhinixAgencyData } from './buildPhinixAgencyData.js';
import { importAgencyData } from './importAgencyData.js';

/**
 * Scheduled sheet → OS task sync.
 *
 * Runs the Phinix Google-Sheets import in `sync_progress` mode so recurring
 * runs update task status/comments (idempotently) against the current monthly
 * session without duplicating work or wiping existing tasks. This replaces the
 * previous "someone must run `npm run upload:phinix` by hand" workflow.
 *
 * @param {{ log?: Console, projects?: string[] }} options
 */
export async function runScheduledTaskSync({ log = console, projects } = {}) {
  const data = await buildPhinixAgencyData(projects ? { projects } : {});
  data.meta = { ...data.meta, importMode: 'sync_progress' };

  const summary = await importAgencyData(data, { dryRun: false });
  log?.info?.({ totals: summary.totals }, 'Scheduled task sync complete');
  return summary;
}
