/**
 * Request validation middleware.
 *
 * TECHNICAL_DESIGN §4.4: Express has no built-in schema layer, so this fills
 * that gap explicitly. Applied to EVERY route — `routes.contract.test.ts` walks
 * the router stack and fails if a mutating route is missing it.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';

import { ValidationError, type FieldIssue } from '../errors/AppError';

export interface ValidationSchemas {
  readonly params?: ZodTypeAny;
  readonly query?: ZodTypeAny;
  readonly body?: ZodTypeAny;
}

/** Marker so the contract test can detect the middleware on a route stack. */
const VALIDATED = Symbol.for('wandrly.validated');

function toFieldIssues(error: ZodError, source: string): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: [source, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }));
}

/**
 * Parse and replace `params`, `query`, and `body` onto `req.valid`.
 *
 * Deliberately does NOT mutate `req.body` — leaving the raw value in place makes
 * it obvious in review when a handler reads the unvalidated input by mistake.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  const handler = (req: Request, _res: Response, next: NextFunction): void => {
    const issues: FieldIssue[] = [];

    req.valid ??= { params: {}, query: {}, body: {} };

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (result.success) req.valid.params = result.data;
      else issues.push(...toFieldIssues(result.error, 'params'));
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (result.success) req.valid.query = result.data;
      else issues.push(...toFieldIssues(result.error, 'query'));
    }

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (result.success) req.valid.body = result.data;
      else issues.push(...toFieldIssues(result.error, 'body'));
    }

    if (issues.length > 0) {
      next(new ValidationError(issues));
      return;
    }

    next();
  };

  Object.defineProperty(handler, VALIDATED, { value: true });
  Object.defineProperty(handler, 'name', { value: 'validate' });

  return handler;
}

export const isValidationMiddleware = (fn: unknown): boolean =>
  typeof fn === 'function' && VALIDATED in (fn as object);

/**
 * Typed accessors.
 *
 * `body(req, Schema)` returns the already-validated value with the schema's
 * inferred type, so handlers get full type information without casting at every
 * call site.
 */
export const validated = {
  params: <T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> =>
    req.valid.params as z.infer<T>,
  query: <T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> =>
    req.valid.query as z.infer<T>,
  body: <T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> =>
    req.valid.body as z.infer<T>,
};

/**
 * Ensure `req.valid` exists even on routes with no schema, so handlers can
 * destructure without a guard.
 */
export const initValidated: RequestHandler = (req, _res, next) => {
  req.valid ??= { params: {}, query: {}, body: {} };
  next();
};
