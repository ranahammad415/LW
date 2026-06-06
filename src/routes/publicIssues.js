import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { notify } from '../lib/notificationService.js';

export async function publicIssuesRoutes(app) {
  // GET /api/public/issues/action
  app.get(
    '/issues/action',
    async (request, reply) => {
      reply.type('text/html');

      const { id, action, token } = request.query || {};

      if (!id || !action || !token) {
        return reply.status(400).send(renderResponseHtml({
          type: 'error',
          title: 'Missing Parameters',
          message: 'The link is missing required parameters. Please make sure you clicked the full URL.',
          portalUrl: process.env.FRONTEND_URL || 'https://app.localwaves.ai'
        }));
      }

      // Verify the JWT token
      try {
        const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
        if (decoded.issueId !== id || decoded.action !== action) {
          return reply.status(400).send(renderResponseHtml({
            type: 'error',
            title: 'Invalid Link',
            message: 'This link is invalid or has been tampered with.',
            portalUrl: process.env.FRONTEND_URL || 'https://app.localwaves.ai'
          }));
        }
      } catch (err) {
        return reply.status(400).send(renderResponseHtml({
          type: 'error',
          title: 'Link Expired',
          message: 'This link has expired or the review window is closed.',
          portalUrl: process.env.FRONTEND_URL || 'https://app.localwaves.ai'
        }));
      }

      try {
        // Fetch issue
        const issue = await prisma.clientIssue.findUnique({
          where: { id },
          include: {
            client: { select: { id: true, agencyName: true } },
            reportedBy: { select: { id: true, name: true, email: true } },
          },
        });

        if (!issue) {
          return reply.status(404).send(renderResponseHtml({
            type: 'error',
            title: 'Not Found',
            message: 'The support request could not be found or has already been rejected and removed.',
            portalUrl: process.env.FRONTEND_URL || 'https://app.localwaves.ai'
          }));
        }

        if (issue.status !== 'REQUESTED') {
          return reply.send(renderResponseHtml({
            type: 'info',
            title: 'Already Processed',
            message: `This support request has already been processed and its current status is: <strong>${issue.status}</strong>.`,
            portalUrl: process.env.FRONTEND_URL || 'https://app.localwaves.ai'
          }));
        }

        if (action === 'approve') {
          // Approve: Change status to 'OPEN'
          await prisma.clientIssue.update({
            where: { id },
            data: { status: 'OPEN' },
          });

          // Log status change
          await prisma.issueActivityLog.create({
            data: {
              issueId: id,
              actorId: issue.reportedById,
              action: 'status_change',
              detail: 'Support request approved via email link',
            },
          });

          // Dispatch PM and Client team notifications (deferred on creation)
          try {
            const issueProject = issue.projectId
              ? await prisma.project.findUnique({ where: { id: issue.projectId }, select: { leadPmId: true } })
              : null;
            const owners = await prisma.user.findMany({ where: { role: 'OWNER', isActive: true }, select: { id: true } });
            const clientAccount = await prisma.clientAccount.findUnique({ where: { id: issue.clientId }, select: { agencyName: true, leadPmId: true } });
            
            const issueRecipients = [
              issueProject?.leadPmId,
              clientAccount?.leadPmId,
              ...owners.map((o) => o.id),
            ].filter((uid) => uid && uid !== issue.reportedById);
            
            if (issueRecipients.length > 0) {
              notify({
                slug: 'issue_created',
                recipientIds: issueRecipients,
                variables: {
                  issueTitle: issue.title,
                  clientName: clientAccount?.agencyName || '',
                  reportedBy: issue.reportedBy?.name || '',
                },
                actionUrl: `/portal/admin/issues`,
                metadata: { issueId: issue.id },
              }).catch(() => {});
            }
          } catch (_) {}

          try {
            const otherUsers = await prisma.clientUser.findMany({
              where: { clientId: issue.clientId, userId: { not: issue.reportedById } },
              select: { userId: true },
            });
            if (otherUsers.length > 0) {
              const clientAccount = await prisma.clientAccount.findUnique({ where: { id: issue.clientId }, select: { agencyName: true } });
              notify({
                slug: 'client_issue_created_team',
                recipientIds: otherUsers.map((cu) => cu.userId),
                variables: { reporterName: issue.reportedBy?.name || 'A team member', issueTitle: issue.title, clientName: clientAccount?.agencyName || '' },
                actionUrl: '/portal/client/issues',
                metadata: { issueId: issue.id },
              }).catch(() => {});
            }
          } catch (_) {}

          return reply.send(renderResponseHtml({
            type: 'success',
            title: 'Support Request Approved!',
            message: `The support request <strong>"${escapeHtml(issue.title)}"</strong> from <strong>${escapeHtml(issue.client.agencyName)}</strong> has been approved and is now visible to the project team.`,
            portalUrl: process.env.FRONTEND_URL || 'https://app.localwaves.ai'
          }));

        } else if (action === 'reject') {
          // Reject: Delete support request
          await prisma.clientIssue.delete({
            where: { id },
          });

          return reply.send(renderResponseHtml({
            type: 'success',
            title: 'Support Request Rejected',
            message: `The support request <strong>"${escapeHtml(issue.title)}"</strong> has been rejected and successfully removed from the stack.`,
            portalUrl: process.env.FRONTEND_URL || 'https://app.localwaves.ai'
          }));
        }

        return reply.status(400).send(renderResponseHtml({
          type: 'error',
          title: 'Invalid Action',
          message: 'The requested action is invalid.',
          portalUrl: process.env.FRONTEND_URL || 'https://app.localwaves.ai'
        }));

      } catch (err) {
        request.log.error({ err }, 'Public issues action error');
        return reply.status(500).send(renderResponseHtml({
          type: 'error',
          title: 'System Error',
          message: 'An error occurred while processing the request.',
          portalUrl: process.env.FRONTEND_URL || 'https://app.localwaves.ai'
        }));
      }
    }
  );
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderResponseHtml({ type, title, message, portalUrl }) {
  const isSuccess = type === 'success';
  const isInfo = type === 'info';
  
  let iconHtml = '';
  if (isSuccess) {
    iconHtml = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" style="width: 32px; height: 32px;"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>`;
  } else if (isInfo) {
    iconHtml = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" style="width: 32px; height: 32px;"><path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 111.063.852l-.708 2.836a.75.75 0 001.063.852l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>`;
  } else {
    iconHtml = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" style="width: 32px; height: 32px;"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>`;
  }

  const iconClass = isSuccess ? 'success' : isInfo ? 'info' : 'error';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body {
      background-color: #0b0f19;
      color: #f3f4f6;
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .card {
      background: rgba(255, 255, 255, 0.03);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      padding: 40px;
      max-width: 480px;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
    }
    .icon-container {
      width: 64px;
      height: 64px;
      margin: 0 auto 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
    }
    .icon-container.success {
      background-color: rgba(16, 185, 129, 0.1);
      color: #10b981;
      border: 1px solid rgba(16, 185, 129, 0.2);
    }
    .icon-container.info {
      background-color: rgba(59, 130, 246, 0.1);
      color: #3b82f6;
      border: 1px solid rgba(59, 130, 246, 0.2);
    }
    .icon-container.error {
      background-color: rgba(239, 68, 68, 0.1);
      color: #ef4444;
      border: 1px solid rgba(239, 68, 68, 0.2);
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      margin: 0 0 12px;
      color: #ffffff;
    }
    p {
      font-size: 15px;
      line-height: 1.6;
      color: #9ca3af;
      margin: 0 0 24px;
    }
    .btn {
      display: inline-block;
      padding: 12px 24px;
      font-size: 14px;
      font-weight: 600;
      color: #ffffff;
      background: #4f46e5;
      border-radius: 10px;
      text-decoration: none;
      transition: background 0.2s ease;
    }
    .btn:hover {
      background: #4338ca;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-container ${iconClass}">
      ${iconHtml}
    </div>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="${escapeHtml(portalUrl)}" class="btn">Go to Dashboard</a>
  </div>
</body>
</html>`;
}
