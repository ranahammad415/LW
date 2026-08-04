/**
 * Generate strong passwords for all CLIENT portal users and print a
 * project-wise credential list.
 *
 * EXCLUDES Brad Gardner permanently:
 *   bradsgardner@gmail.com
 *
 * SAFE GUARDS:
 * - Requires --confirm (or use --dry-run first).
 * - Never touches excluded emails (case-insensitive).
 * - Never touches non-CLIENT users (OWNER / PM / TEAM_MEMBER / CONTRACTOR).
 * - Bumps tokenVersion so existing sessions are invalidated.
 * - Does NOT email users — credentials are only written to the output files.
 *
 * Usage on VPS (~/LW/backend or wherever the API lives):
 *   node scripts/resetAllClientPasswords.js --dry-run
 *   node scripts/resetAllClientPasswords.js --confirm
 *
 * Optional:
 *   node scripts/resetAllClientPasswords.js --confirm --out=./client-passwords.csv
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { randomInt } from 'crypto';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/passwordPolicy.js';

const prisma = new PrismaClient();

const EXCLUDED_EMAILS = new Set(['bradsgardner@gmail.com']);

const dryRun = process.argv.includes('--dry-run');
const confirm = process.argv.includes('--confirm');

function argValue(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}

/**
 * Strong temp password: 20 chars, guaranteed upper + lower + digit + symbol.
 * Avoids ambiguous characters (0/O, 1/l/I).
 */
function generateStrongPassword(length = 20) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*-_=+';
  const all = upper + lower + digits + symbols;

  const picks = [
    upper[randomInt(upper.length)],
    lower[randomInt(lower.length)],
    digits[randomInt(digits.length)],
    symbols[randomInt(symbols.length)],
  ];
  for (let i = picks.length; i < length; i++) {
    picks.push(all[randomInt(all.length)]);
  }
  // Fisher–Yates shuffle
  for (let i = picks.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }
  return picks.join('');
}

function isExcluded(email) {
  return EXCLUDED_EMAILS.has(String(email || '').trim().toLowerCase());
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  if (!dryRun && !confirm) {
    console.error(`
Refusing to run without --confirm (or use --dry-run first).

  node scripts/resetAllClientPasswords.js --dry-run
  node scripts/resetAllClientPasswords.js --confirm
`);
    process.exit(1);
  }

  // All CLIENT users that are linked to at least one client account.
  const clientUsers = await prisma.clientUser.findMany({
    where: {
      user: { role: 'CLIENT', isActive: true },
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
        },
      },
      client: {
        select: {
          id: true,
          agencyName: true,
          isActive: true,
          projects: {
            select: { id: true, name: true, status: true },
            orderBy: { name: 'asc' },
          },
        },
      },
    },
    orderBy: [{ client: { agencyName: 'asc' } }],
  });

  // One password per unique user id (a user may belong to multiple clients).
  const byUserId = new Map();
  const skipped = [];

  for (const cu of clientUsers) {
    const u = cu.user;
    if (!u || u.role !== 'CLIENT') continue;

    if (isExcluded(u.email)) {
      skipped.push({
        reason: 'excluded',
        email: u.email,
        name: u.name,
        client: cu.client.agencyName,
      });
      continue;
    }

    if (!byUserId.has(u.id)) {
      byUserId.set(u.id, {
        userId: u.id,
        email: u.email,
        name: u.name,
        password: generateStrongPassword(20),
        clients: [],
      });
    }
    const entry = byUserId.get(u.id);
    entry.clients.push({
      clientId: cu.client.id,
      agencyName: cu.client.agencyName,
      clientActive: cu.client.isActive,
      projects: cu.client.projects,
      isPrimaryContact: cu.isPrimaryContact,
      clientRole: cu.role,
    });
  }

  const users = [...byUserId.values()].sort((a, b) =>
    a.email.localeCompare(b.email, undefined, { sensitivity: 'base' }),
  );

  console.log(
    JSON.stringify(
      {
        mode: dryRun ? 'dry-run' : 'confirm',
        willReset: users.length,
        skippedExcluded: skipped.length,
        skipped,
      },
      null,
      2,
    ),
  );

  if (dryRun) {
    console.log('\n[dry-run] No passwords were changed. Re-run with --confirm to apply.\n');
    // Preview project-wise listing without revealing final passwords as "SET"
    for (const u of users) {
      for (const c of u.clients) {
        const projectNames =
          c.projects.length > 0 ? c.projects.map((p) => p.name).join(' | ') : '(no projects)';
        console.log(
          `[dry-run] ${projectNames}  →  ${c.agencyName}  →  ${u.name} <${u.email}>  (would reset)`,
        );
      }
    }
    return;
  }

  // Apply password resets
  for (const u of users) {
    const passwordHash = await hashPassword(u.password);
    await prisma.user.update({
      where: { id: u.userId },
      data: {
        passwordHash,
        tokenVersion: { increment: 1 },
      },
    });
  }

  // Project-wise rows (one row per user × project; if no projects, one row per client)
  const rows = [];
  for (const u of users) {
    for (const c of u.clients) {
      if (c.projects.length === 0) {
        rows.push({
          projectName: '',
          projectStatus: '',
          clientAgency: c.agencyName,
          userName: u.name,
          email: u.email,
          password: u.password,
          isPrimaryContact: c.isPrimaryContact ? 'yes' : 'no',
          clientUserRole: c.clientRole,
        });
      } else {
        for (const p of c.projects) {
          rows.push({
            projectName: p.name,
            projectStatus: p.status,
            clientAgency: c.agencyName,
            userName: u.name,
            email: u.email,
            password: u.password,
            isPrimaryContact: c.isPrimaryContact ? 'yes' : 'no',
            clientUserRole: c.clientRole,
          });
        }
      }
    }
  }

  rows.sort((a, b) => {
    const pa = a.projectName || a.clientAgency;
    const pb = b.projectName || b.clientAgency;
    const byProject = pa.localeCompare(pb, undefined, { sensitivity: 'base' });
    if (byProject !== 0) return byProject;
    return a.email.localeCompare(b.email, undefined, { sensitivity: 'base' });
  });

  // Console: project-wise readable list
  console.log('\n===== PROJECT-WISE CLIENT CREDENTIALS =====\n');
  let currentProject = null;
  for (const r of rows) {
    const key = r.projectName || `(no project) — ${r.clientAgency}`;
    if (key !== currentProject) {
      currentProject = key;
      console.log(`\n## ${key}${r.projectStatus ? ` [${r.projectStatus}]` : ''}`);
      console.log(`   Client: ${r.clientAgency}`);
    }
    console.log(`   - ${r.userName} <${r.email}>`);
    console.log(`     password: ${r.password}`);
  }

  // Files
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const defaultOut = resolve(scriptDir, 'output', `client-passwords-${stamp}.csv`);
  const outPath = resolve(argValue('out', defaultOut));
  const jsonPath = outPath.replace(/\.csv$/i, '.json');

  mkdirSync(dirname(outPath), { recursive: true });

  const header = [
    'projectName',
    'projectStatus',
    'clientAgency',
    'userName',
    'email',
    'password',
    'isPrimaryContact',
    'clientUserRole',
  ];
  const csvLines = [
    header.join(','),
    ...rows.map((r) => header.map((h) => csvEscape(r[h])).join(',')),
  ];
  writeFileSync(outPath, csvLines.join('\n'), { encoding: 'utf8', mode: 0o600 });
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        excludedEmails: [...EXCLUDED_EMAILS],
        resetCount: users.length,
        skipped,
        rows,
      },
      null,
      2,
    ),
    { encoding: 'utf8', mode: 0o600 },
  );

  console.log(`\nWrote CSV:  ${outPath}`);
  console.log(`Wrote JSON: ${jsonPath}`);
  console.log(
    `\nDone. Reset ${users.length} CLIENT user(s). Skipped ${skipped.length} excluded. Treat these files as secrets.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
