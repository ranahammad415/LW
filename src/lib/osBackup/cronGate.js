/**
 * node-cron with a maintenance gate (plan e.6): same schedule(expr, fn, opts) API, but a tick that fires while
 * maintenance.json exists is skipped (the DB may be half-restored). Used by src/index.js, lib/signals/jobs.js and
 * lib/ghlForms/jobs.js. The OS Backups crash-recovery cron uses plain node-cron on purpose: it must run in maintenance.
 */
import nodeCron from 'node-cron';
import { isMaintenance } from './maintenance.js';

export function makeGatedCron(base, gate) {
  return {
    schedule(expr, fn, opts) {
      return base.schedule(
        expr,
        (...args) => {
          if (gate()) return undefined;
          return fn(...args);
        },
        opts
      );
    },
    validate: (expr) => base.validate(expr),
  };
}

export const cron = makeGatedCron(nodeCron, () => isMaintenance());
export default cron;
