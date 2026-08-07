/**
 * Error taxonomy.
 *
 * TECHNICAL_DESIGN §8.3. One envelope, one hierarchy. No stack traces and no
 * driver messages ever reach a client.
 *
 * Open/Closed in practice: adding a new failure mode means adding a subclass,
 * never editing the error handler.
 */

export type ErrorCode =
  // 400
  | 'VALIDATION_FAILED'
  // 401
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID_TOKEN'
  // 403
  | 'FORBIDDEN'
  // 404
  | 'NOT_FOUND'
  // 409
  | 'CONFLICT_STALE'
  | 'CONFLICT_DATE_CHANGE'
  | 'CONFLICT_DUPLICATE'
  | 'CONFLICT_IDEMPOTENCY_MISMATCH'
  // 422 — money and domain rules
  | 'LEDGER_SHARES_MISMATCH'
  | 'LEDGER_PAYMENTS_MISMATCH'
  | 'LEDGER_IMBALANCE'
  | 'LEDGER_PARTICIPANT_HAS_HISTORY'
  | 'LEDGER_UNSETTLED_BALANCES'
  | 'DOMAIN_RULE_VIOLATION'
  | 'LIMIT_EXCEEDED'
  // 429
  | 'RATE_LIMITED'
  // 500 / 503
  | 'INTERNAL'
  | 'DEPENDENCY_UNAVAILABLE';

export interface ErrorPayload {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: unknown;
    readonly requestId?: string;
  };
}

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly status: number;

  /** Structured, client-safe context. Never include secrets or raw SQL. */
  readonly details: unknown;

  /** False for genuine bugs, so the handler knows whether to log at error level. */
  readonly isExpected: boolean = true;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }

  toPayload(requestId?: string): ErrorPayload {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

// ── 400 ─────────────────────────────────────────────────────────────

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_FAILED' as const;
  readonly status = 400;

  constructor(issues: readonly FieldIssue[], message = 'Request validation failed') {
    super(message, { issues });
  }
}

// ── 401 ─────────────────────────────────────────────────────────────

export class AuthRequiredError extends AppError {
  readonly code = 'AUTH_REQUIRED' as const;
  readonly status = 401;

  constructor(message = 'Authentication is required') {
    super(message);
  }
}

export class InvalidTokenError extends AppError {
  readonly code = 'AUTH_INVALID_TOKEN' as const;
  readonly status = 401;

  constructor(message = 'The access token is missing, malformed, or expired') {
    super(message);
  }
}

// ── 403 / 404 ───────────────────────────────────────────────────────

/**
 * Forbidden.
 *
 * The message is deliberately generic. Combined with `NotFoundError` being
 * returned for resources the caller cannot see, the API never confirms whether
 * a resource exists — see TECHNICAL_DESIGN §8.4.
 */
export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN' as const;
  readonly status = 403;

  constructor(action?: string) {
    super('You do not have permission to perform this action', action ? { action } : undefined);
  }
}

export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND' as const;
  readonly status = 404;

  constructor(resource = 'Resource') {
    super(`${resource} was not found`);
  }
}

// ── 409 ─────────────────────────────────────────────────────────────

export class StaleWriteError extends AppError {
  readonly code = 'CONFLICT_STALE' as const;
  readonly status = 409;

  constructor(current: unknown) {
    super(
      'This item was changed by someone else while you were editing. Review the latest version.',
      { current },
    );
  }
}

export class DateChangeStrategyRequiredError extends AppError {
  readonly code = 'CONFLICT_DATE_CHANGE' as const;
  readonly status = 409;

  constructor(details: { currentDayCount: number; requestedDayCount: number }) {
    super(
      'Changing these dates alters the number of days. Choose how existing days should be handled.',
      details,
    );
  }
}

export class DuplicateError extends AppError {
  readonly code = 'CONFLICT_DUPLICATE' as const;
  readonly status = 409;

  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}

export class IdempotencyMismatchError extends AppError {
  readonly code = 'CONFLICT_IDEMPOTENCY_MISMATCH' as const;
  readonly status = 409;

  constructor() {
    super('This idempotency key was already used with a different request body');
  }
}

// ── 422: domain and ledger ──────────────────────────────────────────

export class DomainRuleError extends AppError {
  readonly code = 'DOMAIN_RULE_VIOLATION' as const;
  readonly status = 422;

  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}

export class LimitExceededError extends AppError {
  readonly code = 'LIMIT_EXCEEDED' as const;
  readonly status = 422;

  constructor(what: string, limit: number) {
    super(`You've reached the maximum of ${limit} ${what}.`, { limit, what });
  }
}

/**
 * Money-specific failures get their own codes because the UI must render them
 * very precisely — "₹120 unaccounted for" beats "validation failed".
 */
export class SharesMismatchError extends AppError {
  readonly code = 'LEDGER_SHARES_MISMATCH' as const;
  readonly status = 422;

  constructor(differenceMinor: bigint, currency: string) {
    super(
      differenceMinor > 0n
        ? `The split is short by ${differenceMinor} (minor units, ${currency}).`
        : `The split exceeds the total by ${-differenceMinor} (minor units, ${currency}).`,
      { differenceMinor: differenceMinor.toString(), currency },
    );
  }
}

export class PaymentsMismatchError extends AppError {
  readonly code = 'LEDGER_PAYMENTS_MISMATCH' as const;
  readonly status = 422;

  constructor(differenceMinor: bigint, currency: string) {
    super(`Payments do not add up to the expense total (off by ${differenceMinor}, ${currency}).`, {
      differenceMinor: differenceMinor.toString(),
      currency,
    });
  }
}

export class LedgerImbalanceError extends AppError {
  readonly code = 'LEDGER_IMBALANCE' as const;
  readonly status = 422;
  override readonly isExpected = false; // a corrupt ledger is a bug, not user error

  constructor(residualMinor: bigint) {
    super(
      'This trip’s balances are inconsistent and settle-up has been paused. The issue has been reported.',
      { residualMinor: residualMinor.toString() },
    );
  }
}

export class ParticipantHasHistoryError extends AppError {
  readonly code = 'LEDGER_PARTICIPANT_HAS_HISTORY' as const;
  readonly status = 422;

  constructor(details: { participantId: string; netMinor: string }) {
    super(
      'This person has expenses on this trip. Settle or reassign their share before removing them.',
      details,
    );
  }
}

export class UnsettledBalancesError extends AppError {
  readonly code = 'LEDGER_UNSETTLED_BALANCES' as const;
  readonly status = 422;

  constructor(tripIds: readonly string[]) {
    super(
      'There are unsettled balances. Money owed to other people cannot be deleted without settling first.',
      { tripIds },
    );
  }
}

// ── 429 / 5xx ───────────────────────────────────────────────────────

export class RateLimitedError extends AppError {
  readonly code = 'RATE_LIMITED' as const;
  readonly status = 429;

  constructor(retryAfterSeconds?: number) {
    super(
      'Too many requests. Please slow down.',
      retryAfterSeconds ? { retryAfterSeconds } : undefined,
    );
  }
}

export class InternalError extends AppError {
  readonly code = 'INTERNAL' as const;
  readonly status = 500;
  override readonly isExpected = false;

  constructor(message = 'Something went wrong on our side') {
    super(message);
  }
}

export class DependencyUnavailableError extends AppError {
  readonly code = 'DEPENDENCY_UNAVAILABLE' as const;
  readonly status = 503;

  constructor(dependency: string) {
    super(`${dependency} is temporarily unavailable. Please try again shortly.`, { dependency });
  }
}
