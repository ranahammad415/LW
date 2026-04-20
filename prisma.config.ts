import path from 'path';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

// Load .env from current working directory (run "npx prisma db seed" from backend folder)
dotenv.config({ path: path.join(process.cwd(), '.env') });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and set DATABASE_URL (e.g. mysql://USER:PASSWORD@localhost:3306/agency_portal).'
  );
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.cjs',
  },
  datasource: {
    url: databaseUrl,
  },
});
