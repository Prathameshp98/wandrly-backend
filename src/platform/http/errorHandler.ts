/**
 * Terminal error and 404 handlers.
 *
 * TECHNICAL_DESIGN §8.3. Must be registered LAST, and the error handler must
 * keep its 4-argument signature or Express will treat it as ordinary middleware.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express';

import { AppError, InternalError, NotFoundError } from '../errors/AppError';
import { LedgerImbalanceError as MoneyImbalanceError } from '../../money/index';
import { LedgerImbalanceError, ValidationError } from '../errors/AppError';
import { logger } from '../logging/logger';
import { isProduction } from '../config/env';

/** Postgres error shape we care about mapping to friendly failures. */
interface PgError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
}

const isPgError = (error: unknown): error is PgError =>
  error instanceof Error && typeof (error as PgError).code === 'string';

/**
 * Translate infrastructure errors into the domain taxonomy.
 *
 * The deferred ledger triggers (§5.3) surface as raised exceptions, so they are
 * mapped here into `LEDGER_*` codes rather than leaking as a 500.
 */
function normalise(error: unknown): AppError {
  if (error instanceof AppError) return error;

  // The money layer's own imbalance guard — a corrupt ledger, not user error.
  if (error instanceof MoneyImbalanceError) {
    return new LedgerImbalanceError(error.residual);
  }

  if (error instanceof ValidationError) return error;

  if (isPgError(error)) {
    switch (error.code) {
      case '23505': // unique_violation is 23505 in some drivers' reporting
      case '23P01':
      case '23514': // check_violation
        return new (class extends AppError {
          readonly code = 'DOMAIN_RULE_VIOLATION' as const;
          readonly status = 422;
        })('This change violates a data rule for this trip', {
          constraint: error.constraint,
        });
      case '23503': // foreign_key_violation
        return new NotFoundError('A referenced item');
      case '40001': // serialization_failure
      case '40P01': // deadlock_detected
        return new (class extends AppError {
          readonly code = 'CONFLICT_STALE' as const;
          readonly status = 409;
        })('That change collided with another edit. Please retry.');
      default:
        break;
    }

    // Raised by the deferred ledger invariant triggers.
    if (/do not sum to expense total/i.test(error.message)) {
      return new (class extends AppError {
        readonly code = 'LEDGER_SHARES_MISMATCH' as const;
        readonly status = 422;
        override readonly isExpected = false;
      })('The expense split does not add up. The change was rejected.');
    }
  }

  // body-parser rejects a malformed or oversized body before any route sees
  // it, and neither error had a mapping — so broken JSON and an over-limit
  // upload both surfaced as 500s. Both are the client's doing, and a 500 tells
  // the caller to retry something that will never work.
  if (typeof error === 'object' && error !== null && 'type' in error) {
    const { type } = error as { type?: string };

    if (type === 'entity.too.large') {
      return new (class extends AppError {
        readonly code = 'LIMIT_EXCEEDED' as const;
        readonly status = 413;
      })('That file is larger than the upload limit.');
    }

    if (type === 'entity.parse.failed' || type === 'encoding.unsupported') {
      return new (class extends AppError {
        readonly code = 'VALIDATION_FAILED' as const;
        readonly status = 400;
      })('The request body could not be parsed as JSON.');
    }
  }

  return new InternalError();
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const appError = normalise(error);
  const requestId = req.ctx?.requestId ?? req.id ?? undefined;

  const logContext = {
    err: error,
    requestId,
    userId: req.ctx?.userId,
    route: `${req.method} ${req.path}`,
    code: appError.code,
    status: appError.status,
  };

  if (!appError.isExpected || appError.status >= 500) {
    logger.error(logContext, appError.message);
  } else if (appError.status === 429) {
    logger.warn(logContext, 'rate limited');
  } else {
    logger.debug(logContext, 'request rejected');
  }

  // Never leak an internal message in production, even accidentally.
  const payload = appError.toPayload(requestId);
  if (isProduction && appError.status >= 500) {
    res.status(appError.status).json({
      error: {
        code: appError.code,
        message: 'Something went wrong on our side',
        ...(requestId ? { requestId } : {}),
      },
    });
    return;
  }

  res.status(appError.status).json(payload);
};
