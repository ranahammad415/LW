/**
 * Load the backend `.env` from an absolute path relative to this file, so the
 * environment loads correctly regardless of the process working directory
 * (PM2, cron, systemd, running from a parent dir, etc.). Import this FIRST in
 * the entrypoint — before any module that reads process.env at import time.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const dir = dirname(fileURLToPath(import.meta.url));
// This file lives in <backend>/src/, so the .env is one level up.
dotenv.config({ path: join(dir, '..', '.env') });
