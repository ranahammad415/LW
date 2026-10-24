/**
 * Detached worker entry: `node --max-old-space-size=512 src/lib/osBackup/worker.js <jobId>` (spawned by
 * jobs.spawnWorker). Loads apps/backend/.env first (the mailer reads SMTP_* at import), then runs the job.
 * Exit code 0 = the job reached a final state (it may still be FAILED; the job file / row says so).
 */
import '../../loadEnv.js';

const jobId = process.argv[2];
const { runJob } = await import('./runner.js');
let res = { status: 'FAILED' };
try {
  res = await runJob(jobId);
} finally {
  // Do not wait for stray timers (SMTP pools etc.).
  setTimeout(() => process.exit(res?.status === 'FAILED' && res?.error === 'NO_JOB' ? 2 : 0), 200).unref();
}
