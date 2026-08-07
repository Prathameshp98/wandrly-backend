/**
 * Typed request augmentation.
 *
 * TECHNICAL_DESIGN §4.4. Express's `Request` is untyped by default, which would
 * quietly undermine the type safety the rest of this design leans on.
 *
 * The rule that matters: handlers read `req.valid.body`, NEVER `req.body`. That
 * single convention is what keeps unvalidated input from reaching a service.
 */

import type { TripAccess } from '../policy/index';

export interface RequestContext {
  readonly userId: string;
  readonly requestId: string;
}

export interface ValidatedInput {
  params: unknown;
  query: unknown;
  body: unknown;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Present after `requireAuth`. */
      ctx: RequestContext;
      /** Present after `validate(...)`. */
      valid: ValidatedInput;
      /** Present after `withTripAccess(...)`. */
      access?: TripAccess;
      /** Set by pino-http. */
      id?: string;
    }
  }
}

export {};
