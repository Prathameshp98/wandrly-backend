/**
 * Process entrypoint.
 *
 * TECHNICAL_DESIGN §9 — the WebSocket server attaches to the SAME Node HTTP
 * server Express is mounted on, so there is one port, one container, one deploy.
 */

import http from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import { buildApp } from './app';
import { env } from './platform/config/env';
import { closeDatabase } from './platform/db/index';
import { logger } from './platform/logging/logger';
import { authenticateUpgrade } from './platform/realtime/upgrade';
import { hub } from './platform/realtime/hub';
import { startJobs, stopJobs } from './platform/jobs/index';
import { drainBackground } from './platform/background';

const HEARTBEAT_MS = 20_000;

async function main(): Promise<void> {
  const app = buildApp();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  /**
   * Authorize at the upgrade, not after connecting. An unauthenticated socket
   * that attaches first and is checked later is a window in which a client is
   * subscribed to a trip channel it may not be allowed to see.
   */
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      try {
        const { userId, tripId } = await authenticateUpgrade(req);
        wss.handleUpgrade(req, socket, head, (ws) => {
          hub.register(tripId, userId, ws);
        });
      } catch (error) {
        logger.debug({ err: error }, 'websocket upgrade rejected');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      }
    })();
  });

  // Drop peers that stop responding, so the room map does not leak sockets.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const socket = client as WebSocket & { isAlive?: boolean };
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  await startJobs();

  server.listen(env.PORT, '0.0.0.0', () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, corsOrigins: env.CORS_ORIGINS },
      'wandrly-api listening',
    );
  });

  // ── Graceful shutdown ────────────────────────────────────────────
  // Koyeb sends SIGTERM on redeploy. Finish in-flight requests, close sockets,
  // and release the pool so a rolling deploy does not drop a write mid-flight.

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutting down');
    clearInterval(heartbeat);
    hub.closeAll();

    server.close(() => logger.info('http server closed'));

    const forceExit = setTimeout(() => {
      logger.warn('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      await drainBackground();
      await stopJobs();
      await closeDatabase();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled rejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception; exiting');
    process.exit(1);
  });
}

void main();
