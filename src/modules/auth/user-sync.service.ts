/**
 * Mirrors the Supabase identity into our own `users` table.
 *
 * Decision T-2: Supabase Auth owns authentication, we own the user row. That
 * keeps joins local and preserves the exit path off Supabase — the whole point
 * of treating it as managed infrastructure rather than a framework.
 */

import { eq, sql } from 'drizzle-orm';

import { db } from '../../platform/db/index';
import { userPreferences, users } from '../../platform/db/schema/index';
import { loggerFor } from '../../platform/logging/logger';
import type { VerifiedToken } from '../../platform/auth/jwt';

const log = loggerFor('user-sync');

/** Deterministic avatar tone, so a user's colour is stable across devices. */
const TONES = ['gold', 'teal', 'sienna', 'forest'] as const;

function toneFor(userId: string): string {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return TONES[hash % TONES.length]!;
}

function displayNameFrom(email: string | null, userId: string): string {
  if (!email) return `Traveller ${userId.slice(0, 6)}`;
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export class UserSyncService {
  /** Cheap in-process cache: avoids a write on every request for a warm user. */
  private readonly recentlySeen = new Map<string, number>();
  private static readonly TOUCH_INTERVAL_MS = 5 * 60 * 1000;

  /**
   * Guarantee a local row exists for a verified token.
   *
   * Never throws: a failure to record `lastSeenAt` must not fail the request
   * the user actually made.
   */
  async ensureUser(token: VerifiedToken): Promise<void> {
    const lastTouched = this.recentlySeen.get(token.userId);
    if (lastTouched && Date.now() - lastTouched < UserSyncService.TOUCH_INTERVAL_MS) {
      return;
    }

    try {
      await db
        .insert(users)
        .values({
          id: token.userId,
          email: token.email ?? `${token.userId}@placeholder.invalid`,
          displayName: displayNameFrom(token.email, token.userId),
          avatarTone: toneFor(token.userId),
        })
        .onConflictDoUpdate({
          target: users.id,
          set: { lastSeenAt: new Date() },
        });

      // Preferences row is created lazily alongside the user (FR-SET-03).
      await db
        .insert(userPreferences)
        .values({ userId: token.userId })
        .onConflictDoNothing();

      this.recentlySeen.set(token.userId, Date.now());
    } catch (error) {
      log.warn({ err: error, userId: token.userId }, 'user sync failed; continuing');
    }
  }

  async findById(userId: string) {
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    return rows[0] ?? null;
  }

  async preferences(userId: string) {
    const rows = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  async updatePreferences(
    userId: string,
    patch: Partial<typeof userPreferences.$inferInsert>,
  ) {
    const [updated] = await db
      .insert(userPreferences)
      .values({ userId, ...patch })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { ...patch, updatedAt: new Date() },
      })
      .returning();
    return updated!;
  }

  async updateProfile(userId: string, patch: Partial<typeof users.$inferInsert>) {
    const [updated] = await db
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    return updated ?? null;
  }

  /**
   * FR-AUTH-07 — mark for deletion. Access is revoked immediately and a job
   * purges within 30 days. Owned trips are handled by the caller, which must
   * decide between TRANSFER and DELETE first.
   */
  async markPendingDeletion(userId: string): Promise<void> {
    await db
      .update(users)
      .set({ pendingDeletionAt: new Date() })
      .where(eq(users.id, userId));
    this.recentlySeen.delete(userId);
  }

  async isPendingDeletion(userId: string): Promise<boolean> {
    const rows = await db
      .select({ pending: sql<boolean>`${users.pendingDeletionAt} is not null` })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.pending ?? false;
  }
}

export const userSyncService = new UserSyncService();
