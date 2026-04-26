import { prisma } from '../../lib/prisma.js';
import { clearAgencySettingsCache } from '../../lib/emailLayout.js';

/**
 * Singleton agency settings — always returns/creates a single row.
 */
async function getOrCreateSettings() {
  let settings = await prisma.agencySetting.findFirst();
  if (!settings) {
    settings = await prisma.agencySetting.create({ data: {} });
  }
  return settings;
}

export async function adminAgencySettingsRoutes(app) {
  // ── Get agency settings ──
  app.get(
    '/agency-settings',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
    },
    async (request, reply) => {
      const settings = await getOrCreateSettings();
      return reply.send(settings);
    }
  );

  // ── Update agency settings ──
  app.patch(
    '/agency-settings',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        body: {
          type: 'object',
          properties: {
            agencyName:       { type: 'string', maxLength: 255 },
            logoUrl:          { type: 'string', maxLength: 500, nullable: true },
            address:          { type: 'string', maxLength: 500, nullable: true },
            phone:            { type: 'string', maxLength: 50, nullable: true },
            website:          { type: 'string', maxLength: 500, nullable: true },
            emailFromName:    { type: 'string', maxLength: 255, nullable: true },
            emailFromAddress: { type: 'string', maxLength: 255, nullable: true },
            emailHeaderHtml:  { type: 'string', nullable: true },
            emailFooterHtml:  { type: 'string', nullable: true },
            emailPrimaryColor:{ type: 'string', maxLength: 20 },
            emailFooterText:  { type: 'string', maxLength: 500, nullable: true },
            copyrightText:    { type: 'string', maxLength: 255, nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const existing = await getOrCreateSettings();
      const body = request.body || {};
      const data = {};

      const stringFields = [
        'agencyName', 'logoUrl', 'address', 'phone', 'website',
        'emailFromName', 'emailFromAddress', 'emailHeaderHtml',
        'emailFooterHtml', 'emailPrimaryColor', 'emailFooterText',
        'copyrightText',
      ];

      for (const field of stringFields) {
        if (body[field] !== undefined) {
          data[field] = body[field] ? String(body[field]).trim() : null;
        }
      }

      // agencyName should never be null
      if (data.agencyName === null) data.agencyName = 'Localwaves';

      if (Object.keys(data).length === 0) {
        return reply.send(existing);
      }

      const updated = await prisma.agencySetting.update({
        where: { id: existing.id },
        data,
      });

      // Clear email layout cache so next email uses new settings
      clearAgencySettingsCache();

      return reply.send(updated);
    }
  );

  // ── Upload logo ──
  app.post(
    '/agency-settings/logo',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
    },
    async (request, reply) => {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ message: 'No file uploaded' });
      }

      const allowedMimes = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
      if (!allowedMimes.includes(data.mimetype)) {
        return reply.status(400).send({ message: 'Only PNG, JPEG, WebP, and SVG files are allowed' });
      }

      // Save to uploads directory
      const fs = await import('fs');
      const path = await import('path');
      const now = new Date();
      const dateDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const uploadDir = path.default.join(process.cwd(), 'uploads', dateDir);
      fs.default.mkdirSync(uploadDir, { recursive: true });

      const ext = path.default.extname(data.filename) || '.png';
      const fileName = `agency-logo-${Date.now()}${ext}`;
      const filePath = path.default.join(uploadDir, fileName);

      const writeStream = fs.default.createWriteStream(filePath);
      await data.file.pipe(writeStream);
      await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      const logoUrl = `/uploads/${dateDir}/${fileName}`;

      const existing = await getOrCreateSettings();
      const updated = await prisma.agencySetting.update({
        where: { id: existing.id },
        data: { logoUrl },
      });

      return reply.send(updated);
    }
  );
}
