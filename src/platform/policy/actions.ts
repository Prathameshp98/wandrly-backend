/**
 * Authorization actions and the role matrix.
 *
 * TECHNICAL_DESIGN §8.4, derived from PRD §8 row for row.
 *
 * This is table-driven on purpose. Scattered `if (role === 'OWNER')` checks are
 * how authorization bugs happen, and a shared money ledger is the last place to
 * risk one. `policy.matrix.test.ts` asserts this table against the PRD.
 */

export const ROLES = ['OWNER', 'EDITOR', 'CONTRIBUTOR', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  // Trip lifecycle
  'trip:view',
  'trip:edit',
  'trip:archive',
  'trip:delete',
  'trip:transfer-ownership',
  'trip:duplicate',

  // Canvas
  'day:manage',
  'block:create',
  'block:edit-any',
  'block:edit-own',
  'variant:create',
  'variant:promote',

  // Collaboration
  'member:invite',
  'member:manage',
  'comment:create',
  'comment:resolve-any',
  'comment:resolve-own',
  'suggestion:create',
  'suggestion:review',

  // Supporting surfaces
  'packing:edit',
  'notes:edit',
  'share:manage',
  'export:run',

  // Ledger
  'expense:view',
  'expense:view-own',
  'expense:create',
  'expense:edit-any',
  'expense:edit-own',
  'participant:manage',
  'settlement:record-own',
  'settlement:confirm-own',
  'settlement:void',
  'ledger:configure',
] as const;

export type Action = (typeof ACTIONS)[number];

const ALL_ACTIONS: readonly Action[] = ACTIONS;

/**
 * Role → permitted actions.
 *
 * `*-own` variants are granted where a role may act only on resources it
 * created; `assert()` resolves `-any` to `-own` when the actor is the owner of
 * the resource.
 */
export const MATRIX: Readonly<Record<Role, ReadonlySet<Action>>> = Object.freeze({
  OWNER: new Set<Action>(ALL_ACTIONS),

  EDITOR: new Set<Action>([
    'trip:view',
    'trip:edit',
    'trip:archive',
    'trip:duplicate',
    'day:manage',
    'block:create',
    'block:edit-any',
    'block:edit-own',
    'variant:create',
    'member:invite',
    'comment:create',
    'comment:resolve-any',
    'comment:resolve-own',
    'suggestion:create',
    'suggestion:review',
    'packing:edit',
    'notes:edit',
    'share:manage',
    'export:run',
    'expense:view',
    'expense:view-own',
    'expense:create',
    'expense:edit-any',
    'expense:edit-own',
    'participant:manage',
    'settlement:record-own',
    'settlement:confirm-own',
    'settlement:void',
    'ledger:configure',
  ]),

  CONTRIBUTOR: new Set<Action>([
    'trip:view',
    'trip:duplicate',
    'block:create',
    'block:edit-own',
    'comment:create',
    'comment:resolve-own',
    'suggestion:create',
    'packing:edit',
    'notes:edit',
    'export:run',
    'expense:view',
    'expense:view-own',
    'expense:create',
    'expense:edit-own',
    'settlement:record-own',
    'settlement:confirm-own',
  ]),

  VIEWER: new Set<Action>([
    'trip:view',
    'trip:duplicate',
    'comment:create',
    // Deliberately NOT 'comment:resolve-own'. PRD §8 "Resolve comments" denies
    // Viewers outright — resolving is an editorial act on someone else's trip,
    // even for a thread you started.
    'suggestion:create',
    'export:run',
    // A Viewer may be a ledger participant and therefore owe money: they can
    // see their OWN shares and settle up, but not the whole ledger.
    'expense:view-own',
    'settlement:record-own',
    'settlement:confirm-own',
  ]),
});

/** Actions a public (unauthenticated) share-link visitor may perform. */
export const PUBLIC_LINK_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'trip:view',
  // Both are additionally gated on the share link's own toggles.
  'comment:create',
  'suggestion:create',
]);
