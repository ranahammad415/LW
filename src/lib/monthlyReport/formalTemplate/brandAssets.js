/**
 * Bundled Local Waves brand assets for formal monthly report PDFs.
 * Official wordmark: assets/local-waves-logo.png (white background).
 * Icon: assets/local-waves-icon.png
 */
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, 'assets');

/** Public contact defaults from https://localwaves.ai/ */
export const LOCAL_WAVES_CONTACT = {
  agencyName: 'Local Waves',
  email: 'hello@localwaves.ai',
  phone: '(414) 803-1047',
  address: 'Milwaukee, Wisconsin',
  website: 'https://localwaves.ai/',
};

const cache = new Map();

function readPngDataUrl(filename) {
  if (cache.has(filename)) return cache.get(filename);
  const absolute = join(ASSETS, filename);
  if (!existsSync(absolute)) {
    cache.set(filename, null);
    return null;
  }
  const buf = readFileSync(absolute);
  const url = `data:image/png;base64,${buf.toString('base64')}`;
  cache.set(filename, url);
  return url;
}

export function getLocalWavesLogoDataUrl() {
  return readPngDataUrl('local-waves-logo.png');
}

export function getLocalWavesIconDataUrl() {
  return readPngDataUrl('local-waves-icon.png');
}
