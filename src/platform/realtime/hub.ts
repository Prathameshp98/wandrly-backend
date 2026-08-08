/**
 * Realtime hub.
 *
 * TECHNICAL_DESIGN §9. In-memory `Map<tripId, Set<Socket>>` — correct for a
 * single instance, which is what ≤30 concurrent users needs.
 *
 * The `RealtimeHub` interface is the seam that makes scaling cheap: swapping in
 * a Redis pub/sub backend later changes this file and nothing else (§18).
 */

import type { WebSocket } from 'ws';

import { loggerFor } from '../logging/logger';

const log = loggerFor('realtime');

/** Semantic events, not row diffs — the wire format survives schema changes. */
export type RealtimeEventKind =
  | 'trip.updated'
  | 'day.created'
  | 'day.updated'
  | 'day.deleted'
  | 'block.created'
  | 'block.updated'
  | 'block.deleted'
  | 'block.restored'
  | 'block.moved'
  | 'variant.created'
  | 'variant.promoted'
  | 'comment.created'
  | 'suggestion.created'
  | 'suggestion.reviewed'
  | 'participant.created'
  | 'expense.created'
  | 'expense.updated'
  | 'expense.deleted'
  | 'settlement.created'
  | 'settlement.confirmed'
  | 'settlement.voided'
  | 'packing.updated'
  | 'notes.updated'
  | 'presence.changed';

export interface RealtimeEvent {
  readonly kind: RealtimeEventKind;
  readonly tripId: string;
  readonly entityId?: string;
  readonly version?: number;
  /** Client-safe payload. Must never contain booking details or payout data. */
  readonly payload?: unknown;
  /** So a client can ignore the echo of its own change. */
  readonly actorId?: string;
  readonly at: string;
}

export interface RealtimeHub {
  register(tripId: string, userId: string, socket: WebSocket): void;
  broadcast(event: Omit<RealtimeEvent, 'at'>): void;
  connectionCount(tripId?: string): number;
  closeAll(): void;
}

interface Connection {
  readonly userId: string;
  readonly socket: WebSocket;
}

class InMemoryRealtimeHub implements RealtimeHub {
  private readonly rooms = new Map<string, Set<Connection>>();

  register(tripId: string, userId: string, socket: WebSocket): void {
    const room = this.rooms.get(tripId) ?? new Set<Connection>();
    const connection: Connection = { userId, socket };

    room.add(connection);
    this.rooms.set(tripId, room);

    log.debug({ tripId, userId, size: room.size }, 'socket registered');

    const cleanup = (): void => {
      room.delete(connection);
      if (room.size === 0) this.rooms.delete(tripId);
      log.debug({ tripId, userId }, 'socket closed');
    };

    socket.on('close', cleanup);
    socket.on('error', (error) => {
      log.debug({ tripId, userId, err: error }, 'socket error');
      cleanup();
    });

    // Heartbeat: `ws` marks the socket alive on pong; a dead peer is dropped.
    socket.on('pong', () => {
      (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
    });

    this.send(socket, {
      kind: 'presence.changed',
      tripId,
      payload: { connected: room.size },
      at: new Date().toISOString(),
    });
  }

  /**
   * Fan out to every socket in a trip's room.
   *
   * MUST be called after the transaction commits (§7) — broadcasting a change
   * that then rolls back is a desync that is very hard to debug.
   */
  broadcast(event: Omit<RealtimeEvent, 'at'>): void {
    const room = this.rooms.get(event.tripId);
    if (!room || room.size === 0) return;

    const full: RealtimeEvent = { ...event, at: new Date().toISOString() };
    for (const { socket } of room) this.send(socket, full);
  }

  private send(socket: WebSocket, event: RealtimeEvent): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(event));
    } catch (error) {
      log.warn({ err: error, kind: event.kind }, 'failed to deliver realtime event');
    }
  }

  connectionCount(tripId?: string): number {
    if (tripId) return this.rooms.get(tripId)?.size ?? 0;
    let total = 0;
    for (const room of this.rooms.values()) total += room.size;
    return total;
  }

  closeAll(): void {
    for (const room of this.rooms.values()) {
      for (const { socket } of room) socket.close(1001, 'server shutting down');
    }
    this.rooms.clear();
  }
}

export const hub: RealtimeHub = new InMemoryRealtimeHub();

/**
 * Collects events during a transaction and flushes them only after it commits.
 *
 * Services take one of these rather than the hub directly, which makes the
 * "never broadcast inside a transaction" rule structural instead of a habit.
 */
export class DeferredBroadcast {
  private readonly pending: Omit<RealtimeEvent, 'at'>[] = [];

  constructor(private readonly target: RealtimeHub = hub) {}

  queue(event: Omit<RealtimeEvent, 'at'>): void {
    this.pending.push(event);
  }

  flush(): void {
    for (const event of this.pending) this.target.broadcast(event);
    this.pending.length = 0;
  }

  discard(): void {
    this.pending.length = 0;
  }
}
