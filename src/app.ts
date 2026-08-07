/**
 * Express application assembly.
 *
 * TECHNICAL_DESIGN §4.4 — middleware order matters and lives in exactly ONE
 * place. Nothing else in the codebase registers global middleware.
 */

import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';

import { env, isProduction } from './platform/config/env';
import { newRequestId } from './platform/crypto/index';
import { checkDatabase } from './platform/db/index';
import { errorHandler, notFoundHandler } from './platform/http/errorHandler';
import { initValidated } from './platform/http/validate';
import { logger } from './platform/logging/logger';
import { cronSecretAuth, requireAuth } from './platform/auth/requireAuth';
import { userSyncService } from './modules/auth/user-sync.service';
import { ledgerRouter, meLedgerRouter } from './modules/ledger/ledger.routes';
import { tripsRouter } from './modules/trips/trips.routes';
import { canvasRouter } from './modules/canvas/canvas.routes';
import { collabRouter, inviteRouter } from './modules/collab/collab.routes';
import { publicRouter, sharingRouter } from './modules/sharing/sharing.routes';
import { exportsRouter } from './modules/exports/exports.routes';
import { panelsRouter, searchRouter } from './modules/panels/panels.routes';
import { mediaRouter } from './modules/media/media.routes';
import { placesRouter } from './modules/places/places.routes';
import {
  notificationsRouter,
  unsubscribeRouter,
} from './modules/notifications/notifications.routes';
import { cronRouter } from './platform/jobs/cron.routes';
import { buildOpenApiDocument } from './contracts/generate-openapi';

import './platform/http/types.js';

export function buildApp(): Express {
  const app = express();

  // Koyeb terminates TLS and proxies; without this, every client appears to
  // share one IP and rate limits either do nothing or lock everyone out.
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req.headers['x-request-id'] as string) || newRequestId(),
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'debug';
        return 'info';
      },
      autoLogging: {
        ignore: (req) => req.url === '/health',
      },
    }),
  );

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
      maxAge: 86_400,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(initValidated);

  /**
   * Two limiters, in this order, for a reason.
   *
   * `req.ctx` is populated by `requireAuth`, so a limiter placed BEFORE auth can
   * only ever key on IP — which is not a per-user limit at all, and behind
   * Koyeb's proxy would put everyone on one NAT into a single bucket.
   *
   *   ipLimiter   — outer guard, pre-auth, protects against unauthenticated
   *                 floods. Generous, because many users can share an IP.
   *   userLimiter — the real per-user limit, mounted AFTER auth so it can key
   *                 on `req.ctx.userId`.
   */
  const ipLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.RATE_LIMIT_IP_PER_MIN,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.ip ?? 'anonymous',
  });

  const userLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.RATE_LIMIT_USER_PER_MIN,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.ctx?.userId ?? req.ip ?? 'anonymous',
  });

  // ── Unauthenticated ────────────────────────────────────────────────

  app.get('/health', async (_req, res) => {
    const database = await checkDatabase();
    res.status(database ? 200 : 503).json({
      status: database ? 'ok' : 'degraded',
      database,
      // eslint-disable-next-line no-restricted-syntax -- uptime seconds, not money
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  // Public share pages (§8.7) — no auth, IP-limited only. A share link must
  // work for someone with no account.
  app.use(ipLimiter, publicRouter);

  // One-click unsubscribe (FR-NOTIF-09) — HMAC-token authorized, no session.
  app.use(ipLimiter, unsubscribeRouter);

  // Internal cron (§10.2) — shared secret, excluded from the OpenAPI spec.
  app.use(
    '/internal/cron',
    rateLimit({ windowMs: 60_000, limit: 20, keyGenerator: (req) => req.ip ?? 'cron' }),
    cronSecretAuth,
    cronRouter,
  );

  // ── Authenticated ──────────────────────────────────────────────────

  app.use(
    '/v1',
    ipLimiter,
    requireAuth(userSyncService),
    userLimiter,
    tripsRouter,
    canvasRouter,
    collabRouter,
    inviteRouter,
    sharingRouter,
    exportsRouter,
    panelsRouter,
    searchRouter,
    mediaRouter,
    placesRouter,
    notificationsRouter,
    ledgerRouter,
    meLedgerRouter,
  );

  // ── Docs ───────────────────────────────────────────────────────────

  if (!isProduction) {
    const document = buildOpenApiDocument();
    app.get('/openapi.json', (_req, res) => res.json(document));
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(document));
  }

  // ── Terminal handlers — must be last ───────────────────────────────

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
