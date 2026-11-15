import type { RoomState } from './game/types';

/** 管理页看到的一行房间摘要。 */
export interface RoomRow {
  code: string;
  object_id: string;
  status: string;
  players: string;
  player_count: number;
  online: number;
  spectators: number;
  created_at: number;
  last_active: number;
  updated_at: number;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, object_id TEXT NOT NULL, status TEXT NOT NULL, players TEXT NOT NULL, player_count INTEGER NOT NULL, online INTEGER NOT NULL, spectators INTEGER NOT NULL, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL, updated_at INTEGER NOT NULL)`;

const ready = new WeakMap<D1Database, Promise<void>>();

/** 第一次用到时建表。同一个实例里只建一次。 */
export function ensureTable(db: D1Database): Promise<void> {
  let job = ready.get(db);
  if (!job) {
    job = db
      .prepare(SCHEMA)
      .run()
      .then(() => undefined);
    job.catch(() => ready.delete(db));
    ready.set(db, job);
  }
  return job;
}

export function summarize(state: RoomState) {
  return {
    status: state.status,
    players: state.players.map((p) => ({ n: p.nickname, c: p.color, on: p.connected, h: p.isHost, b: p.bankrupt })),
    online: state.players.filter((p) => p.connected).length + state.spectators.filter((s) => s.connected).length,
    spectators: state.spectators.length,
  };
}

export async function upsertRoom(db: D1Database, objectId: string, state: RoomState, now: number): Promise<void> {
  await ensureTable(db);
  const sum = summarize(state);
  await db
    .prepare(
      `INSERT INTO rooms (code, object_id, status, players, player_count, online, spectators, created_at, last_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET object_id = excluded.object_id, status = excluded.status, players = excluded.players,
         player_count = excluded.player_count, online = excluded.online, spectators = excluded.spectators,
         last_active = excluded.last_active, updated_at = excluded.updated_at`,
    )
    .bind(
      state.roomCode,
      objectId,
      sum.status,
      JSON.stringify(sum.players),
      state.players.length,
      sum.online,
      sum.spectators,
      state.createdAt,
      state.lastActiveAt ?? state.createdAt,
      now,
    )
    .run();
}

export async function deleteRoom(db: D1Database, code: string): Promise<void> {
  await ensureTable(db);
  await db.prepare('DELETE FROM rooms WHERE code = ?').bind(code).run();
}

export async function listRooms(db: D1Database): Promise<RoomRow[]> {
  await ensureTable(db);
  const { results } = await db.prepare('SELECT * FROM rooms ORDER BY last_active DESC LIMIT 500').all<RoomRow>();
  return results ?? [];
}
