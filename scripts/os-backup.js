#!/usr/bin/env node
/**
 * OS Backups CLI (docs/ledger/features/os-backups.md). Owner shell only, no HTTP. `npm run os-backup -- <command>`.
 * Refuses to do anything without an explicit command; every command that writes (run, restore, maintenance, prune)
 * also needs --yes. Arguments are checked BEFORE the env or any DB module is loaded.
 *
 *   detect                                  binaries, server facts, grants, GET_LOCK, largest tables, disk, directory
 *   list                                    backups on disk (signed manifests)
 *   verify <id|file>                        full decrypt + structure + hash check
 *   decrypt <file> --out f.jsonl.gz         decrypted payload (JSON Lines, gzip)
 *   export-sql <id|file> --out f.sql.gz     plain SQL for a manual `mysql` import
 *   run --yes                               one backup now (trigger CLI)
 *   restore (--id <id> | --file <f>) --yes [--allow-different-db]   restore without the app (works on an empty DB)
 *   maintenance on|off --yes                write / remove ~/os-backups/maintenance.json
 *   prune --yes                             retention now
 */
import { pathToFileURL } from 'url';

const USAGE = `Usage: npm run os-backup -- <command> [options]
  detect | list | verify <id|file> | decrypt <file> --out <f.jsonl.gz> | export-sql <id|file> --out <f.sql.gz>
  run --yes | prune --yes | maintenance on|off --yes
  restore (--id <id> | --file <path>) --yes [--allow-different-db]
Writes need --yes. See docs/ledger/features/os-backups.md.`;

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  const pos = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--yes' || a === '--allow-different-db' || a === '--json') flags[a.slice(2)] = true;
    else if (a === '--out' || a === '--id' || a === '--file') {
      flags[a.slice(2)] = rest[i + 1];
      i += 1;
    } else if (a.startsWith('--')) return { error: `Unknown option ${a}` };
    else pos.push(a);
  }
  const needYes = ['run', 'prune', 'maintenance', 'restore'];
  const known = ['detect', 'list', 'verify', 'decrypt', 'export-sql', ...needYes];
  if (!cmd || !known.includes(cmd)) return { error: cmd ? `Unknown command ${cmd}` : 'No command given' };
  if (needYes.includes(cmd) && !flags.yes) return { error: `${cmd} changes data or files: add --yes` };
  if ((cmd === 'verify' || cmd === 'decrypt' || cmd === 'export-sql') && !pos[0]) return { error: `${cmd} needs an id or a file` };
  if ((cmd === 'decrypt' || cmd === 'export-sql') && !flags.out) return { error: `${cmd} needs --out <file>` };
  if (cmd === 'maintenance' && !['on', 'off'].includes(pos[0])) return { error: 'maintenance needs on or off' };
  if (cmd === 'restore' && !flags.id === !flags.file) return { error: 'restore needs exactly one of --id or --file' };
  return { cmd, flags, pos };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`${args.error}\n\n${USAGE}`);
    process.exit(2);
  }
  await import('../src/loadEnv.js');
  const fs = await import('fs');
  const path = await import('path');
  const zlib = await import('zlib');
  const { loadConfig, decryptKeys, featureProblem } = await import('../src/lib/osBackup/config.js');
  const { layout, ensureDirs } = await import('../src/lib/osBackup/jobs.js');
  const { readManifest, verifyManifestHmac, manifestNameFor, isBackupFileName } = await import('../src/lib/osBackup/manifest.js');
  const { verifyBackupFile } = await import('../src/lib/osBackup/verify.js');
  const cfg = loadConfig();
  const keys = decryptKeys(cfg);
  const problem = featureProblem(cfg, { requireEnabled: false });
  if (problem && args.cmd !== 'detect') {
    console.error(`Refusing: ${problem}`);
    process.exit(1);
  }
  const l = ensureDirs(cfg.dir);

  const manifests = async () => {
    const out = [];
    for (const f of fs.readdirSync(l.backups).filter(isBackupFileName).sort()) {
      try {
        const m = await readManifest(path.join(l.backups, manifestNameFor(f)));
        out.push({ file: path.join(l.backups, f), manifest: m, signed: verifyManifestHmac(m, keys) });
      } catch {
        out.push({ file: path.join(l.backups, f), manifest: null, signed: false });
      }
    }
    return out;
  };
  const resolve = async (idOrFile) => {
    if (fs.existsSync(idOrFile)) {
      const mp = idOrFile.replace(/\.lwbk$/, '.manifest.json');
      const m = fs.existsSync(mp) ? await readManifest(mp) : null;
      return { file: idOrFile, manifest: m, signed: m ? verifyManifestHmac(m, keys) : false };
    }
    const hit = (await manifests()).find((x) => x.manifest?.id === idOrFile);
    if (!hit) throw new Error(`No backup with id ${idOrFile} in ${l.backups}`);
    return hit;
  };

  switch (args.cmd) {
    case 'detect': {
      const { detect } = await import('../src/lib/osBackup/detect.js');
      const { openDataConnection, dataAdapter } = await import('../src/lib/osBackup/dbConn.js');
      let data = null;
      try {
        data = dataAdapter(await openDataConnection(cfg.databaseUrl));
      } catch (err) {
        console.error(`DB connection failed (${err?.code || 'ERROR'}); reporting the rest`);
      }
      const res = await detect({ cfg, data });
      if (data) await data.end();
      console.log(JSON.stringify(res, null, 2));
      if (problem) console.error(`Note: ${problem}`);
      break;
    }
    case 'list': {
      for (const x of await manifests()) {
        const m = x.manifest;
        console.log(`${path.basename(x.file)}  ${m ? `${m.id}  ${m.kind}  ${m.startedAt}  ${m.totals?.tables} tables  ${m.totals?.rows} rows  ${m.totals?.fileBytes} B  latest ${m.migrations?.latest}` : 'NO MANIFEST'}  ${x.signed ? 'signed' : 'SIGNATURE INVALID'}`);
      }
      break;
    }
    case 'verify': {
      const x = await resolve(args.pos[0]);
      if (x.manifest && !x.signed) console.error('WARNING: manifest signature does not match');
      const v = await verifyBackupFile(x.file, keys, x.signed ? x.manifest : null);
      console.log(JSON.stringify({ ok: v.ok, error: v.error || null, tables: v.tables?.length, rows: v.totalRows, durationMs: v.durationMs }, null, 2));
      process.exitCode = v.ok ? 0 : 1;
      break;
    }
    case 'decrypt': {
      const { pipeline } = await import('stream/promises');
      const { createDecryptStream } = await import('../src/lib/osBackup/crypto.js');
      await pipeline(fs.createReadStream(args.pos[0]), createDecryptStream(keys), fs.createWriteStream(args.flags.out, { mode: 0o600, flags: 'wx' }));
      console.log(`Wrote ${args.flags.out} (gzip JSON Lines). It holds the full database: keep it safe and delete it after use.`);
      break;
    }
    case 'export-sql': {
      const x = await resolve(args.pos[0]);
      const { readPayload } = await import('../src/lib/osBackup/payload.js');
      const gz = zlib.createGzip({ level: 6 });
      const out = fs.createWriteStream(args.flags.out, { mode: 0o600, flags: 'wx' });
      gz.pipe(out);
      const w = (s) => (gz.write(s) ? null : new Promise((r) => gz.once('drain', r)));
      await w("SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET UNIQUE_CHECKS=0;\nSET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\nSET time_zone='+00:00';\n");
      await readPayload(x.file, keys, async (r) => {
        if (r.k === 'table') await w(`DROP TABLE IF EXISTS \`${String(r.t).replace(/`/g, '``')}\`;\n${r.ddl};\n`);
        else if (r.k === 'rows') await w(`${r.sql};\n`);
        else if (r.k === 'view') await w(`DROP VIEW IF EXISTS \`${String(r.name).replace(/`/g, '``')}\`;\n${r.ddl};\n`);
        else if (r.k === 'trigger') await w(`DELIMITER ;;\n${r.ddl};;\nDELIMITER ;\n`);
      });
      await w('SET FOREIGN_KEY_CHECKS=1;\nSET UNIQUE_CHECKS=1;\n');
      gz.end();
      await new Promise((r) => out.on('finish', r));
      console.log(`Wrote ${args.flags.out}. It holds the full database: keep it safe and delete it after use.`);
      break;
    }
    case 'run': {
      const { openControlConnection } = await import('../src/lib/osBackup/dbConn.js');
      const store = await import('../src/lib/osBackup/store.js');
      const { runJob } = await import('../src/lib/osBackup/runner.js');
      const { writeJobFile } = await import('../src/lib/osBackup/jobs.js');
      const ctl = await openControlConnection(cfg.databaseUrl);
      const db = store.mysqlSql(ctl);
      const job = await store.insertJob(db, { id: store.newId(), type: 'BACKUP', trigger: 'CLI', status: 'QUEUED', phase: 'QUEUED' });
      writeJobFile(cfg.dir, job.id, { type: 'BACKUP', trigger: 'CLI', status: 'QUEUED' });
      await ctl.end();
      const res = await runJob(job.id, { cfg });
      console.log(JSON.stringify({ jobId: job.id, ...res }, null, 2));
      process.exitCode = res.status === 'SUCCEEDED' ? 0 : 1;
      break;
    }
    case 'prune': {
      const { openControlConnection } = await import('../src/lib/osBackup/dbConn.js');
      const store = await import('../src/lib/osBackup/store.js');
      const { runRetention } = await import('../src/lib/osBackup/catalog.js');
      const ctl = await openControlConnection(cfg.databaseUrl);
      try {
        console.log(JSON.stringify(await runRetention({ db: store.mysqlSql(ctl), cfg }), null, 2));
      } finally {
        await ctl.end();
      }
      break;
    }
    case 'maintenance': {
      const { writeMaintenance, clearMaintenance, readMaintenance } = await import('../src/lib/osBackup/maintenance.js');
      if (args.pos[0] === 'on') {
        writeMaintenance(cfg.dir, { kind: 'cli', phase: 'MANUAL', startedAt: new Date().toISOString() });
        console.log('Maintenance ON: every API request now gets 503 until "maintenance off --yes".');
      } else {
        const was = readMaintenance(cfg.dir);
        clearMaintenance(cfg.dir);
        console.log(was ? `Maintenance OFF (was ${was.phase || 'on'}).` : 'Maintenance was not on.');
      }
      break;
    }
    case 'restore': {
      const x = await resolve(args.flags.id || args.flags.file);
      if (!x.manifest || !x.signed) throw new Error('The manifest is missing or its signature does not match: refusing');
      const { parseDatabaseUrl, openDataConnection, dataAdapter } = await import('../src/lib/osBackup/dbConn.js');
      const dbName = parseDatabaseUrl(cfg.databaseUrl).database;
      if (dbName !== x.manifest.database && !args.flags['allow-different-db']) throw new Error(`The backup is of database "${x.manifest.database}" but DATABASE_URL points at "${dbName}": add --allow-different-db to continue`);
      console.log('Verifying the file...');
      const v = await verifyBackupFile(x.file, keys, x.manifest);
      if (!v.ok) throw new Error(`Verify failed: ${v.error}`);
      const { writeMaintenance, clearMaintenance, readMaintenance } = await import('../src/lib/osBackup/maintenance.js');
      const { restoreDatabase, verifyRestore } = await import('../src/lib/osBackup/restoreEngine.js');
      const { applyCarryForward } = await import('../src/lib/osBackup/securityCarryForward.js');
      const wasOn = !!readMaintenance(cfg.dir);
      if (!wasOn) writeMaintenance(cfg.dir, { kind: 'cli-restore', phase: 'RESTORING', startedAt: new Date().toISOString() });
      const data = dataAdapter(await openDataConnection(cfg.databaseUrl));
      try {
        console.log(`Restoring ${path.basename(x.file)} (${x.manifest.totals?.tables} tables, ${x.manifest.totals?.rows} rows)...`);
        const loaded = await restoreDatabase(data, x.file, keys, x.manifest, { onProgress: (p) => p.table && process.stdout.write(`\r${p.phase} ${p.i || ''}/${p.n || ''} ${p.table.slice(0, 40).padEnd(40)}`) });
        process.stdout.write('\n');
        await applyCarryForward(data, null, { mode: 'rollback' });
        const problems = await verifyRestore(data, x.manifest, { purged: loaded.purged, requirePreserved: false });
        if (problems.length) throw new Error(`Restore verify failed: ${problems.join('; ')}`);
        console.log('Restore verified. Everyone must sign in again.');
      } finally {
        await data.end();
      }
      if (!wasOn) clearMaintenance(cfg.dir);
      else console.log('Maintenance is still ON (it was on before). When the app is ready: npm run os-backup -- maintenance off --yes');
      break;
    }
    default:
      break;
  }
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main()
    .then(() => setTimeout(() => process.exit(process.exitCode || 0), 100))
    .catch((err) => {
      // Driver errors can quote row values ("Duplicate entry 'x@y.com'"): print their codes only.
      const msg = err?.errno || err?.sqlState ? `${err.code || 'DB_ERROR'} errno=${err.errno || ''} sqlState=${err.sqlState || ''}${err.lwosTable ? ` table=${err.lwosTable}` : ''}` : err?.message || 'error';
      console.error(`Failed: ${msg}`);
      process.exit(1);
    });
}
