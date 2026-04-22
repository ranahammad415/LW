import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const prisma = new PrismaClient();
const DEFAULT_PASSWORD = 'password123';
const BCRYPT_ROUNDS = 10;

const users = [
  // PMs
  { name: 'Hamza Ashraf',    email: 'hamza@thephinixsolutions.com',    role: 'PM' },
  { name: 'Sami Ullah',      email: 'sami@thephinixsolutions.com',     role: 'PM' },
  // TEAM_MEMBERs
  { name: 'Mudassar Nazar',  email: 'mudassar@thephinixsolutions.com', role: 'TEAM_MEMBER' },
  { name: 'Bisma Syed',      email: 'bisma@thephinixsolutions.com',    role: 'TEAM_MEMBER' },
  { name: 'Awais Sadiq',     email: 'awais@thephinixsolutions.com',    role: 'TEAM_MEMBER' },
  { name: 'Ahmer Mustaifa',  email: 'ahmer@thephinixsolutions.com',    role: 'TEAM_MEMBER' },
  { name: 'Zaib Un Nisa',    email: 'zaib@thephinixsolutions.com',     role: 'TEAM_MEMBER' },
  { name: 'Arooj',           email: 'arooj@thephinixsolutions.com',    role: 'TEAM_MEMBER' },
  { name: 'Usama Azam',      email: 'usama@thephinixsolutions.com',    role: 'TEAM_MEMBER' },
];

async function main() {
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, BCRYPT_ROUNDS);

  for (const u of users) {
    const existing = await prisma.user.findUnique({ where: { email: u.email } });
    if (existing) {
      console.log(`SKIP (already exists): ${u.email} [${u.role}]`);
      continue;
    }
    await prisma.user.create({
      data: {
        email: u.email,
        passwordHash,
        role: u.role,
        name: u.name,
        twoFaBackupCodes: [],
      },
    });
    console.log(`CREATED: ${u.name} — ${u.email} [${u.role}]`);
  }

  console.log('\nDone! All users have password:', DEFAULT_PASSWORD);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
