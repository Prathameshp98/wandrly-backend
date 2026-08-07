/**
 * Structured logging.
 *
 * TECHNICAL_DESIGN §16 and the §14 security checklist: redaction is configured
 * here, once, so sensitive fields cannot leak through a log line added later.
 */

import { pino } from 'pino';

import { env, isProduction, isTest } from '../config/env';

/**
 * Paths scrubbed from every log record.
 *
 * Booking details, payment identifiers, and tokens are the categories that must
 * never appear in logs (FR-NFR-SEC-02, FR-NFR-SEC-11). Wildcards cover nesting
 * because these arrive inside request bodies and domain objects alike.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-cron-secret"]',
  'password',
  'passwordHash',
  'token',
  'tokenHash',
  'accessToken',
  'refreshToken',
  '*.password',
  '*.token',
  '*.tokenHash',
  'booking',
  '*.booking',
  'sections.booking',
  '*.sections.booking',
  'payoutUpiId',
  '*.payoutUpiId',
  'payoutBankRef',
  '*.payoutBankRef',
  'pnr',
  '*.pnr',
  'confirmation',
  '*.confirmation',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  base: { service: 'wandrly-api', env: env.NODE_ENV },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pretty output locally; JSON in production for Koyeb's log stream; nothing
  // extra in tests, where a transport worker would just slow the suite down.
  transport: isProduction || isTest
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service,env' },
      },
});

export type Logger = typeof logger;

/** Child logger for a bounded context, so module logs are filterable. */
export const loggerFor = (module: string): Logger => logger.child({ module });
