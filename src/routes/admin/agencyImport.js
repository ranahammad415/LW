import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { importAgencyData } from '../../lib/dataImport/importAgencyData.js';
import { mapExtractionPackage } from '../../lib/dataImport/mapExtractionPackage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '../..');

export async function adminAgencyImportRoutes(app) {
  app.post(
    '/import/agency-data',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        body: {
          type: 'object',
          properties: {
            data: { type: 'object' },
            filePath: { type: 'string' },
            dryRun: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { data: bodyData, filePath, dryRun = true } = request.body || {};

      let data = bodyData;
      if (!data && filePath) {
        const resolved = path.isAbsolute(filePath) ? filePath : path.join(BACKEND_ROOT, filePath);
        try {
          const raw = await fs.readFile(resolved, 'utf8');
          data = JSON.parse(raw);
        } catch (err) {
          return reply.status(400).send({ message: `Cannot read file: ${err.message}` });
        }
      }

      if (!data?.projects?.length) {
        return reply.status(400).send({ message: 'Provide data object or valid filePath' });
      }

      try {
        const summary = await importAgencyData(data, { dryRun: Boolean(dryRun) });
        return reply.send({ summary, dryRun: Boolean(dryRun) });
      } catch (err) {
        request.log.error({ err }, 'Agency data import failed');
        return reply.status(500).send({ message: err.message || 'Import failed' });
      }
    },
  );

  app.post(
    '/import/map-extraction',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        body: {
          type: 'object',
          required: ['extractionDir', 'projectMatch'],
          properties: {
            extractionDir: { type: 'string' },
            projectMatch: { type: 'string' },
            clientMatch: { type: 'string' },
            planLabel: { type: 'string' },
            useAi: { type: 'boolean' },
            importMode: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { extractionDir, projectMatch, clientMatch, planLabel, useAi, importMode } =
        request.body || {};

      let resolvedDir = extractionDir;
      if (!path.isAbsolute(resolvedDir)) {
        resolvedDir = path.join(BACKEND_ROOT, resolvedDir);
      }

      try {
        const data = await mapExtractionPackage(resolvedDir, {
          useAi: Boolean(useAi),
          projectNameContains: projectMatch,
          clientNameContains: clientMatch,
          planLabel,
          importMode,
        });
        return reply.send({ data, taskGroupCount: data.projects?.[0]?.taskGroups?.length || 0 });
      } catch (err) {
        request.log.error({ err }, 'Extraction mapping failed');
        return reply.status(500).send({ message: err.message || 'Mapping failed' });
      }
    },
  );
}
