import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../lib/prisma.js';
import { loginBodySchema } from '../schemas/auth.js';

const accessSecret = process.env.JWT_ACCESS_SECRET;
const refreshSecret = process.env.JWT_REFRESH_SECRET;
const accessExpiresIn = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
const refreshExpiresIn = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

if (!accessSecret || accessSecret.length < 32) {
  throw new Error('JWT_ACCESS_SECRET must be set and at least 32 characters');
}
if (!refreshSecret || refreshSecret.length < 32) {
  throw new Error('JWT_REFRESH_SECRET must be set and at least 32 characters');
}

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/auth/google/callback';
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

const googleEnabled = !!(googleClientId && googleClientSecret);
let googleOAuth2Client = null;
if (googleEnabled) {
  googleOAuth2Client = new OAuth2Client(googleClientId, googleClientSecret, googleRedirectUri);
}

export async function authRoutes(app) {
  app.post(
    '/login',
    {},
    async (request, reply) => {
      try {
        const parsed = loginBodySchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({
            message: 'Validation failed',
            errors: parsed.error.flatten().fieldErrors,
          });
        }
        const { email, password } = parsed.data;

        const user = await prisma.user.findUnique({
          where: { email: email.toLowerCase() },
        });
        if (!user || !user.isActive) {
          return reply.status(401).send({ message: 'Invalid email or password' });
        }

        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) {
          return reply.status(401).send({ message: 'Invalid email or password' });
        }

        const accessToken = jwt.sign(
          { sub: user.id, role: user.role },
          accessSecret,
          { expiresIn: accessExpiresIn }
        );
        const refreshToken = jwt.sign(
          { sub: user.id, type: 'refresh' },
          refreshSecret,
          { expiresIn: refreshExpiresIn }
        );

        reply.setCookie('refreshToken', refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 7 * 24 * 60 * 60,
          path: '/api/auth',
        });

        await prisma.user.update({
          where: { id: user.id },
          data: {
            lastLoginAt: new Date(),
            lastLoginIp: request.ip,
          },
        });

        return reply.send({
          accessToken,
          user: {
            id: user.id,
            email: user.email,
            role: user.role,
            name: user.name,
            avatarUrl: user.avatarUrl,
          },
        });
      } catch (err) {
        request.log.error({ err }, 'Login handler error');
        return reply.status(500).send({
          message: process.env.NODE_ENV === 'production' ? 'Login failed' : err.message,
        });
      }
    }
  );

  app.post(
    '/refresh',
    {},
    async (request, reply) => {
      const refreshToken = request.cookies?.refreshToken;
      if (!refreshToken) {
        return reply.status(401).send({ message: 'Refresh token missing' });
      }

      let payload;
      try {
        payload = jwt.verify(refreshToken, refreshSecret);
      } catch (err) {
        reply.clearCookie('refreshToken', { path: '/api/auth' });
        return reply.status(401).send({ message: 'Invalid or expired refresh token' });
      }
      if (payload.type !== 'refresh' || !payload.sub) {
        reply.clearCookie('refreshToken', { path: '/api/auth' });
        return reply.status(401).send({ message: 'Invalid refresh token' });
      }

      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, role: true, isActive: true },
      });
      if (!user || !user.isActive) {
        reply.clearCookie('refreshToken', { path: '/api/auth' });
        return reply.status(401).send({ message: 'User not found or inactive' });
      }

      const accessToken = jwt.sign(
        { sub: user.id, role: user.role },
        accessSecret,
        { expiresIn: accessExpiresIn }
      );

      return reply.send({ accessToken });
    }
  );

  // ── Google OAuth: Redirect to Google consent screen ──
  app.get(
    '/google',
    {},
    async (request, reply) => {
      if (!googleEnabled || !googleOAuth2Client) {
        return reply.status(501).send({ message: 'Google OAuth not configured' });
      }

      const state = crypto.randomBytes(32).toString('hex');
      const linkToken = request.query.token || null;
      const isLink = request.query.link === 'true';

      // Store state + optional link token in a cookie
      const statePayload = JSON.stringify({ state, link: isLink, token: linkToken });
      reply.setCookie('google_oauth_state', statePayload, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 600, // 10 minutes
        path: '/api/auth',
      });

      const authUrl = googleOAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['openid', 'email', 'profile'],
        state,
        prompt: 'select_account',
      });

      return reply.redirect(authUrl);
    }
  );

  // ── Google OAuth: Callback from Google ──
  app.get(
    '/google/callback',
    {},
    async (request, reply) => {
      if (!googleEnabled || !googleOAuth2Client) {
        return reply.redirect(`${frontendUrl}/auth/google/callback?error=Google+OAuth+not+configured`);
      }

      const { code, state: returnedState } = request.query;
      if (!code) {
        return reply.redirect(`${frontendUrl}/auth/google/callback?error=Missing+authorization+code`);
      }

      // Verify state from cookie
      let stateData;
      try {
        const raw = request.cookies?.google_oauth_state;
        if (!raw) throw new Error('Missing state cookie');
        stateData = JSON.parse(raw);
        if (stateData.state !== returnedState) throw new Error('State mismatch');
      } catch {
        reply.clearCookie('google_oauth_state', { path: '/api/auth' });
        return reply.redirect(`${frontendUrl}/auth/google/callback?error=Invalid+state`);
      }

      reply.clearCookie('google_oauth_state', { path: '/api/auth' });

      // Exchange code for tokens
      let tokens;
      try {
        const tokenResponse = await googleOAuth2Client.getToken(code);
        tokens = tokenResponse.tokens;
      } catch (err) {
        request.log.error({ err }, 'Google token exchange failed');
        return reply.redirect(`${frontendUrl}/auth/google/callback?error=Token+exchange+failed`);
      }

      // Verify ID token and extract user info
      let googlePayload;
      try {
        const ticket = await googleOAuth2Client.verifyIdToken({
          idToken: tokens.id_token,
          audience: googleClientId,
        });
        googlePayload = ticket.getPayload();
      } catch (err) {
        request.log.error({ err }, 'Google ID token verification failed');
        return reply.redirect(`${frontendUrl}/auth/google/callback?error=Token+verification+failed`);
      }

      const googleId = googlePayload.sub;
      const googleEmail = googlePayload.email;
      const googleName = googlePayload.name || googleEmail;
      const googlePicture = googlePayload.picture || null;

      // ── Link flow: user is already logged in, just link Google account ──
      if (stateData.link && stateData.token) {
        try {
          const jwtPayload = jwt.verify(stateData.token, accessSecret);
          const userId = jwtPayload.sub;

          // Check if this googleId is already used by another user
          const existingGoogle = await prisma.user.findUnique({ where: { googleId } });
          if (existingGoogle && existingGoogle.id !== userId) {
            return reply.redirect(`${frontendUrl}/auth/google/callback?error=Google+account+already+linked+to+another+user&mode=link`);
          }

          await prisma.user.update({
            where: { id: userId },
            data: {
              googleId,
              googleEmail,
              googleLinkedAt: new Date(),
              avatarUrl: googlePicture,
            },
          });

          return reply.redirect(`${frontendUrl}/auth/google/callback?mode=link&success=true`);
        } catch (err) {
          request.log.error({ err }, 'Google link flow error');
          return reply.redirect(`${frontendUrl}/auth/google/callback?error=Session+expired&mode=link`);
        }
      }

      // ── Login flow: find or match user by googleId or email ──
      let user = await prisma.user.findUnique({ where: { googleId } });

      if (!user) {
        // Try matching by email (for existing users who haven't linked Google yet)
        user = await prisma.user.findUnique({ where: { email: googleEmail.toLowerCase() } });
        if (user) {
          // Auto-link Google account on first Google sign-in
          await prisma.user.update({
            where: { id: user.id },
            data: {
              googleId,
              googleEmail,
              googleLinkedAt: new Date(),
              avatarUrl: user.avatarUrl || googlePicture,
            },
          });
        }
      }

      // If still no user, check if this Google email matches any ClientAccount.analyticsGoogleEmail
      // This allows clients whose portal email differs from their Google/analytics email to sign in
      if (!user) {
        const clientAccount = await prisma.clientAccount.findFirst({
          where: { analyticsGoogleEmail: googleEmail.toLowerCase() },
          include: {
            clientUsers: {
              include: { user: true },
              take: 1,
            },
          },
        });

        if (clientAccount?.clientUsers?.[0]?.user) {
          user = clientAccount.clientUsers[0].user;
          // Auto-link this Google account to the client user
          await prisma.user.update({
            where: { id: user.id },
            data: {
              googleId,
              googleEmail,
              googleLinkedAt: new Date(),
              avatarUrl: user.avatarUrl || googlePicture,
            },
          });
        }
      }

      if (!user || !user.isActive) {
        return reply.redirect(`${frontendUrl}/auth/google/callback?error=No+account+found+for+this+Google+email`);
      }

      // Generate tokens
      const accessTokenVal = jwt.sign(
        { sub: user.id, role: user.role },
        accessSecret,
        { expiresIn: accessExpiresIn }
      );
      const refreshTokenVal = jwt.sign(
        { sub: user.id, type: 'refresh' },
        refreshSecret,
        { expiresIn: refreshExpiresIn }
      );

      reply.setCookie('refreshToken', refreshTokenVal, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60,
        path: '/api/auth',
      });

      await prisma.user.update({
        where: { id: user.id },
        data: {
          lastLoginAt: new Date(),
          lastLoginIp: request.ip,
        },
      });

      // Encode user data as URL-safe base64 for the frontend callback
      const userData = Buffer.from(JSON.stringify({
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
        avatarUrl: user.avatarUrl,
        googleEmail: user.googleEmail,
      })).toString('base64url');

      return reply.redirect(
        `${frontendUrl}/auth/google/callback?accessToken=${accessTokenVal}&user=${userData}`
      );
    }
  );

  // ── Google Auth Status: check if client has linked Google and analytics access ──
  app.get(
    '/google/status',
    {
      onRequest: [app.verifyJwt, app.requireClient],
    },
    async (request, reply) => {
      const userId = request.user.id;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { googleId: true, googleEmail: true, googleLinkedAt: true },
      });

      const clientUsers = await prisma.clientUser.findMany({
        where: { userId },
        select: { clientId: true },
      });

      const clientIds = clientUsers.map((cu) => cu.clientId);

      let analyticsGoogleEmail = null;
      let analyticsAccessGranted = false;

      if (clientIds.length > 0) {
        const clients = await prisma.clientAccount.findMany({
          where: { id: { in: clientIds } },
          select: { analyticsGoogleEmail: true },
        });

        // Use the first non-null analyticsGoogleEmail
        const clientWithEmail = clients.find((c) => c.analyticsGoogleEmail);
        analyticsGoogleEmail = clientWithEmail?.analyticsGoogleEmail || null;

        if (!analyticsGoogleEmail) {
          // No restriction configured — allow access
          analyticsAccessGranted = true;
        } else if (user?.googleEmail) {
          // Check if linked Google email matches the required email
          analyticsAccessGranted =
            user.googleEmail.toLowerCase() === analyticsGoogleEmail.toLowerCase();
        }
      }

      return reply.send({
        googleLinked: !!(user?.googleId),
        googleEmail: user?.googleEmail || null,
        analyticsGoogleEmail,
        analyticsAccessGranted,
      });
    }
  );

}
