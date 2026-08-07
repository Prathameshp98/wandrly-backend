/**
 * The authorization engine.
 *
 * TECHNICAL_DESIGN §8.4. Two rules that prevent whole bug classes:
 *
 *   1. The trip access object is loaded ONCE per request and passed down. No
 *      service method re-queries membership.
 *   2. `FORBIDDEN` and `NOT_FOUND` are indistinguishable for resources the
 *      caller cannot see, so the API is never an existence oracle.
 */

import { ForbiddenError } from '../errors/AppError';
import { MATRIX, PUBLIC_LINK_ACTIONS, type Action, type Role } from './actions';

/**
 * Everything authorization needs about one actor's relationship to one trip,
 * resolved in a single query.
 */
export interface TripAccess {
  readonly tripId: string;
  readonly userId: string;
  readonly role: Role;
  /** The actor's ledger identity on this trip, if they have one. */
  readonly participantId: string | null;
  readonly tripMode: 'FULL' | 'EXPENSES_ONLY';
  readonly baseCurrency: string;
  readonly isArchived: boolean;
}

/** Access granted by a public share link rather than membership. */
export interface PublicAccess {
  readonly tripId: string;
  readonly variantId: string | null;
  readonly allowComments: boolean;
  readonly allowSuggestions: boolean;
}

/** Minimal shape needed to evaluate `-own` permissions. */
export interface OwnedResource {
  readonly createdBy?: string | null;
}

export function can(access: TripAccess, action: Action, resource?: OwnedResource): boolean {
  const permitted = MATRIX[access.role];

  if (permitted.has(action)) return true;

  // Resolve an `-any` request down to its `-own` variant when the actor created
  // the resource. This keeps the matrix small and the call sites uniform.
  if (action.endsWith('-any') && resource?.createdBy) {
    const ownVariant = action.replace(/-any$/, '-own') as Action;
    if (resource.createdBy === access.userId && permitted.has(ownVariant)) return true;
  }

  return false;
}

/** Throws `ForbiddenError` unless the action is permitted. */
export function assert(access: TripAccess, action: Action, resource?: OwnedResource): void {
  if (!can(access, action, resource)) throw new ForbiddenError(action);
}

/**
 * Whether the actor may see the whole ledger, or only their own shares.
 *
 * FR-NFR-SEC-10: this must drive a `WHERE participant_id = ...` filter in the
 * query, not client-side hiding of rows already fetched.
 */
export function ledgerScope(access: TripAccess): 'ALL' | 'OWN' | 'NONE' {
  if (can(access, 'expense:view')) return 'ALL';
  if (can(access, 'expense:view-own') && access.participantId) return 'OWN';
  return 'NONE';
}

/** Public share links: view-only, with comments and suggestions gated per link. */
export function canPublic(access: PublicAccess, action: Action): boolean {
  if (!PUBLIC_LINK_ACTIONS.has(action)) return false;
  if (action === 'comment:create') return access.allowComments;
  if (action === 'suggestion:create') return access.allowSuggestions;
  return true;
}

export function assertPublic(access: PublicAccess, action: Action): void {
  if (!canPublic(access, action)) throw new ForbiddenError(action);
}

/**
 * Archived trips are read-only. Applied on top of the role check so a stale
 * client cannot mutate a shelved trip.
 */
export function assertMutable(access: TripAccess): void {
  if (access.isArchived) {
    throw new ForbiddenError('trip:archived-read-only');
  }
}

export { ACTIONS, MATRIX, ROLES, PUBLIC_LINK_ACTIONS } from './actions';
export type { Action, Role } from './actions';
