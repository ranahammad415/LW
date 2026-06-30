import path from 'path';
import { fileURLToPath } from 'url';
import { runExtraction } from '../../lib/googleKnowledge/runExtraction.js';
import { isWorkspaceAuthConfigured } from '../../lib/googleKnowledge/auth.js';
import { EXTRACTIONS_DIR_NAME } from '../../lib/googleKnowledge/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '../..');

export async function adminGoogleExtractRoutes(app) {
  app.post(
    '/extract/google',
    {
      onRequest: [app.verifyJwt, app.requireOwner],
      schema: {
        body: {
          type: 'object',
          properties: {
            rootUrl: { type: 'string' },
            maxDepth: { type: 'number' },
            maxFiles: { type: 'number' },
            dryRun: { type: 'boolean' },
            month: { type: 'string' },
            resume: { type: 'boolean' },
            outDir: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!isWorkspaceAuthConfigured()) {
        return reply.status(503).send({
          message:
            'Google Workspace extraction is not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_WORKSPACE_REFRESH_TOKEN.',
        });
      }

      const { rootUrl, maxDepth, maxFiles, dryRun, month, resume, outDir } = request.body || {};

      if (!resume && !rootUrl) {
        return reply.status(400).send({ message: 'rootUrl is required unless resume is true' });
      }

      let resolvedOut = outDir;
      if (resolvedOut && !path.isAbsolute(resolvedOut)) {
        resolvedOut = path.join(BACKEND_ROOT, resolvedOut);
      } else if (resume && !resolvedOut) {
        return reply.status(400).send({ message: 'resume requires outDir' });
      }

      try {
        const result = await runExtraction({
          rootUrl,
          outDir: resolvedOut,
          maxDepth,
          maxFiles,
          dryRun: Boolean(dryRun),
          resume: Boolean(resume),
          monthFilter: month || null,
        });

        return reply.send({
          runId: result.runId,
          outputPath: result.outDir,
          shareWith: result.shareWith,
          stats: result.stats,
          accessNeeded: result.accessNeeded,
          reportPath: result.reportPath,
        });
      } catch (err) {
        request.log.error({ err }, 'Google knowledge extraction failed');
        return reply.status(500).send({
          message: err.message || 'Extraction failed',
        });
      }
    },
  );
}
