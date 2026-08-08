/**
 * Shared repository behaviour.
 *
 * DRY without over-abstraction: this holds only the operations that are
 * genuinely identical across aggregates — id lookup, soft delete, optimistic
 * update. Anything aggregate-specific belongs in the concrete repository, where
 * it can be read alongside the query it affects.
 *
 * Every method takes an `Executor`, so the same repository works inside and
 * outside a transaction (see `withTransaction`).
 */

import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import { StaleWriteError } from '../errors/AppError';
import type { Executor } from './index';

/** Minimum column set a table must expose to use the shared helpers. */
export interface IdentifiedTable extends PgTable {
  id: never;
}

export abstract class BaseRepository<TRow extends { id: string }> {
  /**
   * @param table       Drizzle table this repository owns.
   * @param supportsSoftDelete Whether the table has a `deleted_at` column.
   */
  protected constructor(
    protected readonly table: PgTable,
    protected readonly supportsSoftDelete: boolean = false,
  ) {}

  /** Column accessors, resolved dynamically so subclasses stay declarative. */
  private column(name: string): SQL.Aliased | never {
    const columns = this.table as unknown as Record<string, SQL.Aliased>;
    const column = columns[name];
    if (!column) {
      throw new Error(`${this.constructor.name}: table has no "${name}" column`);
    }
    return column;
  }

  protected get idColumn() {
    return this.column('id') as never;
  }

  protected get deletedAtColumn() {
    return this.column('deletedAt') as never;
  }

  protected get versionColumn() {
    return this.column('version') as never;
  }

  /** Excludes soft-deleted rows when the table supports it. */
  protected livePredicate(extra?: SQL): SQL | undefined {
    if (!this.supportsSoftDelete) return extra;
    const alive = isNull(this.deletedAtColumn);
    return extra ? and(alive, extra) : alive;
  }

  async findById(exec: Executor, id: string): Promise<TRow | null> {
    const predicate = this.livePredicate(eq(this.idColumn, id));
    const rows = (await exec
      .select()
      .from(this.table)
      .where(predicate)
      .limit(1)) as unknown as TRow[];
    return rows[0] ?? null;
  }

  async exists(exec: Executor, id: string): Promise<boolean> {
    return (await this.findById(exec, id)) !== null;
  }

  /**
   * Find a row whether or not it is soft-deleted.
   *
   * `restore` is the one operation whose subject is *always* invisible to
   * `findById`, so a restore path that wants to authorize before acting has no
   * other way to see what it is about to act on. Without this, `restore` runs
   * on a bare id — which is how a caller ends up restoring a row belonging to
   * someone else's trip.
   */
  async findByIdIncludingDeleted(exec: Executor, id: string): Promise<TRow | null> {
    const rows = (await exec
      .select()
      .from(this.table)
      .where(eq(this.idColumn, id))
      .limit(1)) as unknown as TRow[];
    return rows[0] ?? null;
  }

  /**
   * Optimistic update (§5.9).
   *
   * Zero rows affected means the caller held a stale version, which surfaces as
   * `409 CONFLICT_STALE` carrying the current server state so the client can
   * reconcile rather than blindly retry.
   */
  protected async updateVersioned<TPatch extends Record<string, unknown>>(
    exec: Executor,
    id: string,
    expectedVersion: number,
    patch: TPatch,
  ): Promise<TRow> {
    const rows = (await exec
      .update(this.table)
      .set({
        ...patch,
        version: sql`${this.versionColumn} + 1`,
        updatedAt: new Date(),
      } as never)
      .where(
        this.livePredicate(
          and(eq(this.idColumn, id), eq(this.versionColumn, expectedVersion)),
        ),
      )
      .returning()) as unknown as TRow[];

    const updated = rows[0];
    if (!updated) {
      const current = await this.findById(exec, id);
      throw new StaleWriteError(current);
    }

    return updated;
  }

  /** Soft delete. Only valid on tables with `deleted_at`. */
  async softDelete(exec: Executor, id: string): Promise<boolean> {
    if (!this.supportsSoftDelete) {
      throw new Error(`${this.constructor.name}: table does not support soft delete`);
    }

    const rows = (await exec
      .update(this.table)
      .set({ deletedAt: new Date() } as never)
      .where(and(eq(this.idColumn, id), isNull(this.deletedAtColumn)))
      .returning()) as unknown as TRow[];

    return rows.length > 0;
  }

  /** Restore a soft-deleted row. Backs the undo toasts (FR-UNDO-01). */
  async restore(exec: Executor, id: string): Promise<boolean> {
    if (!this.supportsSoftDelete) {
      throw new Error(`${this.constructor.name}: table does not support soft delete`);
    }

    const rows = (await exec
      .update(this.table)
      .set({ deletedAt: null } as never)
      .where(eq(this.idColumn, id))
      .returning()) as unknown as TRow[];

    return rows.length > 0;
  }

  async hardDelete(exec: Executor, id: string): Promise<boolean> {
    const rows = (await exec
      .delete(this.table)
      .where(eq(this.idColumn, id))
      .returning()) as unknown as TRow[];
    return rows.length > 0;
  }

  protected async countWhere(exec: Executor, predicate?: SQL): Promise<number> {
    const rows = await exec
      .select({ count: sql<number>`count(*)::int` })
      .from(this.table)
      .where(this.livePredicate(predicate));
    return rows[0]?.count ?? 0;
  }
}
