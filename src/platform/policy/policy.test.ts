/**
 * The policy matrix is asserted against PRD §8 row for row.
 *
 * TECHNICAL_DESIGN §8.4: "A test asserts the matrix matches PRD §8 row for row.
 * If the PRD changes, the test fails." That is the point of this file — it is a
 * specification check, not a unit test of `Set.has`.
 */

import { describe, expect, it } from 'vitest';

import { ForbiddenError } from '../errors/AppError';
import {
  ACTIONS,
  MATRIX,
  ROLES,
  assert,
  assertMutable,
  assertPublic,
  can,
  canPublic,
  ledgerScope,
  type Action,
  type Role,
  type TripAccess,
} from './index';

const accessFor = (role: Role, overrides: Partial<TripAccess> = {}): TripAccess => ({
  tripId: 'trip-1',
  userId: 'user-1',
  role,
  participantId: 'participant-1',
  tripMode: 'FULL',
  baseCurrency: 'INR',
  isArchived: false,
  ...overrides,
});

/**
 * PRD §8, transcribed. `true` = allowed outright, `'own'` = allowed only for
 * resources the actor created, `false` = denied.
 *
 * Deliberately written out longhand rather than derived from MATRIX — a test
 * that imports the thing it validates proves nothing.
 */
type Expectation = true | false | 'own';

const PRD_TABLE: Record<string, Record<Role, Expectation>> = {
  // Row: "View trip and all blocks"
  'trip:view': { OWNER: true, EDITOR: true, CONTRIBUTOR: true, VIEWER: true },
  // Row: "Edit trip settings"
  'trip:edit': { OWNER: true, EDITOR: true, CONTRIBUTOR: false, VIEWER: false },
  // Row: "Archive"
  'trip:archive': { OWNER: true, EDITOR: true, CONTRIBUTOR: false, VIEWER: false },
  // Row: "Delete trip" — Owner only
  'trip:delete': { OWNER: true, EDITOR: false, CONTRIBUTOR: false, VIEWER: false },
  // Row: "Transfer ownership" — Owner only
  'trip:transfer-ownership': { OWNER: true, EDITOR: false, CONTRIBUTOR: false, VIEWER: false },
  // Row: "Duplicate trip (into own account)" — everyone who can see it
  'trip:duplicate': { OWNER: true, EDITOR: true, CONTRIBUTOR: true, VIEWER: true },

  // Row: "Add / delete / reorder days"
  'day:manage': { OWNER: true, EDITOR: true, CONTRIBUTOR: false, VIEWER: false },
  // Row: "Create / edit / delete blocks" — Contributor: own only
  'block:create': { OWNER: true, EDITOR: true, CONTRIBUTOR: true, VIEWER: false },
  'block:edit-any': { OWNER: true, EDITOR: true, CONTRIBUTOR: 'own', VIEWER: false },
  // Row: "Create / fork variants"
  'variant:create': { OWNER: true, EDITOR: true, CONTRIBUTOR: false, VIEWER: false },
  // Row: "Promote variant to main" — Owner only
  'variant:promote': { OWNER: true, EDITOR: false, CONTRIBUTOR: false, VIEWER: false },

  // Row: "Invite people"
  'member:invite': { OWNER: true, EDITOR: true, CONTRIBUTOR: false, VIEWER: false },
  // Row: "Change roles / remove members" — Owner only
  'member:manage': { OWNER: true, EDITOR: false, CONTRIBUTOR: false, VIEWER: false },
  // Row: "Comment"
  'comment:create': { OWNER: true, EDITOR: true, CONTRIBUTOR: true, VIEWER: true },
  // Row: "Resolve comments" — Contributor: own only
  'comment:resolve-any': { OWNER: true, EDITOR: true, CONTRIBUTOR: 'own', VIEWER: false },
  // Row: "Propose a block (suggestion)"
  'suggestion:create': { OWNER: true, EDITOR: true, CONTRIBUTOR: true, VIEWER: true },
  // Row: "Review suggestions"
  'suggestion:review': { OWNER: true, EDITOR: true, CONTRIBUTOR: false, VIEWER: false },

  // Row: "Edit packing list"
  'packing:edit': { OWNER: true, EDITOR: true, CONTRIBUTOR: true, VIEWER: false },
  // Row: "Edit trip notes"
  'notes:edit': { OWNER: true, EDITOR: true, CONTRIBUTOR: true, VIEWER: false },
  // Row: "Manage share link"
  'share:manage': { OWNER: true, EDITOR: true, CONTRIBUTOR: false, VIEWER: false },
  // Row: "Export"
  'export:run': { OWNER: true, EDITOR: true, CONTRIBUTOR: true, VIEWER: true },

  // Row: "View the expense ledger" — Viewer: own shares only
  'expense:view': { OWNER: true, EDITOR: true, CONTRIBUTOR: true, VIEWER: false },
  // Row: "Add an expense"
  'expense:create': { OWNER: true, EDITOR: true, CONTRIBUTOR: true, VIEWER: false },
  // Row: "Edit / delete an expense" — Contributor: own only
  'expense:edit-any': { OWNER: true, EDITOR: true, CONTRIBUTOR: 'own', VIEWER: false },
  // Row: "Add placeholder participants"
  'participant:manage': { OWNER: true, EDITOR: true, CONTRIBUTOR: false, VIEWER: false },
  // Row: "Record a settlement" — own transfers for everyone below Owner
  'settlement:record-own': { OWNER: true, EDITOR: true, CONTRIBUTOR: true, VIEWER: true },
  // Row: "Confirm receipt of a settlement" — as payee
  'settlement:confirm-own': { OWNER: true, EDITOR: true, CONTRIBUTOR: true, VIEWER: true },
  // Row: "Void a settlement"
  'settlement:void': { OWNER: true, EDITOR: true, CONTRIBUTOR: false, VIEWER: false },
  // Row: "Toggle debt simplification"
  'ledger:configure': { OWNER: true, EDITOR: true, CONTRIBUTOR: false, VIEWER: false },
};

describe('policy matrix vs PRD §8', () => {
  for (const [action, byRole] of Object.entries(PRD_TABLE)) {
    describe(action, () => {
      for (const role of ROLES) {
        const expectation = byRole[role];

        it(`${role} → ${expectation === 'own' ? 'own resources only' : expectation}`, () => {
          const access = accessFor(role);
          const someoneElse = { createdBy: 'user-2' };
          const mine = { createdBy: 'user-1' };

          if (expectation === true) {
            expect(can(access, action as Action)).toBe(true);
          } else if (expectation === false) {
            expect(can(access, action as Action)).toBe(false);
            expect(can(access, action as Action, mine)).toBe(false);
          } else {
            // 'own': denied for another user's resource, allowed for their own.
            expect(can(access, action as Action, someoneElse)).toBe(false);
            expect(can(access, action as Action, mine)).toBe(true);
          }
        });
      }
    });
  }

  it('covers every action defined in the matrix', () => {
    // Guards against adding an action to the enum without a PRD row, which
    // would otherwise ship unauthorised-by-accident or unchecked.
    const documented = new Set(Object.keys(PRD_TABLE));
    const undocumented = ACTIONS.filter(
      (action) =>
        !documented.has(action) &&
        // `-own` variants are asserted through their `-any` counterpart.
        !action.endsWith('-own'),
    );
    expect(undocumented).toStrictEqual([]);
  });

  it('grants OWNER every action', () => {
    for (const action of ACTIONS) {
      expect(can(accessFor('OWNER'), action)).toBe(true);
    }
  });

  it('never grants a role more than OWNER', () => {
    for (const role of ROLES) {
      for (const action of MATRIX[role]) {
        expect(MATRIX.OWNER.has(action)).toBe(true);
      }
    }
  });
});

describe('assert', () => {
  it('throws ForbiddenError with the action for diagnostics', () => {
    expect(() => assert(accessFor('VIEWER'), 'trip:delete')).toThrow(ForbiddenError);
    try {
      assert(accessFor('VIEWER'), 'trip:delete');
    } catch (error) {
      // The message must not confirm the resource exists (§8.4).
      expect((error as ForbiddenError).message).not.toMatch(/trip-1/);
      expect((error as ForbiddenError).details).toStrictEqual({ action: 'trip:delete' });
    }
  });

  it('passes silently when permitted', () => {
    expect(() => assert(accessFor('OWNER'), 'trip:delete')).not.toThrow();
  });
});

describe('ledgerScope', () => {
  it('gives full ledger visibility to Owner, Editor and Contributor', () => {
    expect(ledgerScope(accessFor('OWNER'))).toBe('ALL');
    expect(ledgerScope(accessFor('EDITOR'))).toBe('ALL');
    expect(ledgerScope(accessFor('CONTRIBUTOR'))).toBe('ALL');
  });

  it('restricts a Viewer to their own shares', () => {
    expect(ledgerScope(accessFor('VIEWER'))).toBe('OWN');
  });

  it('gives a Viewer with no ledger identity nothing', () => {
    expect(ledgerScope(accessFor('VIEWER', { participantId: null }))).toBe('NONE');
  });
});

describe('assertMutable', () => {
  it('blocks mutation of an archived trip regardless of role', () => {
    expect(() => assertMutable(accessFor('OWNER', { isArchived: true }))).toThrow(ForbiddenError);
  });

  it('allows mutation of an active trip', () => {
    expect(() => assertMutable(accessFor('OWNER'))).not.toThrow();
  });
});

describe('public share link access', () => {
  const publicAccess = {
    tripId: 'trip-1',
    variantId: 'variant-1',
    allowComments: false,
    allowSuggestions: false,
  };

  it('permits viewing', () => {
    expect(canPublic(publicAccess, 'trip:view')).toBe(true);
  });

  it('never permits any mutation of the itinerary', () => {
    for (const action of ['trip:edit', 'block:create', 'day:manage', 'trip:delete'] as Action[]) {
      expect(canPublic(publicAccess, action)).toBe(false);
    }
  });

  it('never exposes the ledger, whatever the link settings', () => {
    // FR-SPLIT-40 — group finances are private to participants without exception.
    const permissive = { ...publicAccess, allowComments: true, allowSuggestions: true };
    for (const action of [
      'expense:view',
      'expense:view-own',
      'expense:create',
      'settlement:record-own',
    ] as Action[]) {
      expect(canPublic(permissive, action)).toBe(false);
    }
  });

  it('gates comments and suggestions on the link toggles', () => {
    expect(canPublic(publicAccess, 'comment:create')).toBe(false);
    expect(canPublic({ ...publicAccess, allowComments: true }, 'comment:create')).toBe(true);

    expect(canPublic(publicAccess, 'suggestion:create')).toBe(false);
    expect(canPublic({ ...publicAccess, allowSuggestions: true }, 'suggestion:create')).toBe(true);
  });

  it('assertPublic throws for denied actions', () => {
    expect(() => assertPublic(publicAccess, 'expense:view')).toThrow(ForbiddenError);
  });
});
