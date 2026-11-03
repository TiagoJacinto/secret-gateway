// Answers store: one row per secret identity. Holds status, source description, length and
// timestamps, and the rule and location of first sighting. It also holds, per conversation, the
// message count of its last request and the unmask points of "Not a secret" answers. It never holds
// a secret value: conversation keys are digests.
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync } from 'node:fs';

export type Status = 'pending' | 'secret' | 'not_secret';
export type Item = { id: string; status: Status; source: string; length: number; firstSeen: string; updatedAt: string };
// Where an identity was first seen: the scanner rule or in-process layer, and the slot location in the request.
export type Origin = { rule: string; location: string };

export class AnswerStore {
  readonly #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'secret', 'not_secret')),
        source TEXT NOT NULL,
        length INTEGER NOT NULL,
        first_seen TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS origins (
        id TEXT PRIMARY KEY,
        rule TEXT NOT NULL,
        location TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS unmask_points (
        identity TEXT NOT NULL,
        conversation TEXT NOT NULL,
        first_order INTEGER NOT NULL,
        PRIMARY KEY (identity, conversation)
      );
    `);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  }

  statusOf(id: string): Status | undefined {
    const row = this.#db.query<{ status: Status }, [string]>('SELECT status FROM items WHERE id = ?').get(id);
    return row?.status;
  }

  // Records a new identity as pending, with its origin. Returns true when the identity is new.
  // Identities stored before origins were recorded have no origin row.
  ensurePending(id: string, source: string, length: number, now: string, origin: Origin): boolean {
    return this.#db.transaction(() => {
      const result = this.#db
        .query('INSERT OR IGNORE INTO items (id, status, source, length, first_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, 'pending', source, length, now, now);
      if (result.changes !== 1) return false;
      this.#db.query('INSERT INTO origins (id, rule, location) VALUES (?, ?, ?)').run(id, origin.rule, origin.location);
      return true;
    })();
  }

  answer(id: string, status: Exclude<Status, 'pending'>, now: string): boolean {
    const result = this.#db
      .query('UPDATE items SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, id);
    return result.changes === 1;
  }

  // Message count of the last request of a conversation.
  recordConversation(key: string, count: number): void {
    this.#db
      .query('INSERT INTO conversations (key, count) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count')
      .run(key, count);
  }

  conversationCounts(): Map<string, number> {
    const rows = this.#db.query<{ key: string; count: number }, []>('SELECT key, count FROM conversations').all();
    return new Map(rows.map((row) => [row.key, row.count]));
  }

  // Replaces the unmask points of one identity: per conversation, the first slot order that is unmasked.
  setUnmaskPoints(id: string, points: Map<string, number>): void {
    this.#db.transaction(() => {
      this.#db.query('DELETE FROM unmask_points WHERE identity = ?').run(id);
      const insert = this.#db.query('INSERT INTO unmask_points (identity, conversation, first_order) VALUES (?, ?, ?)');
      for (const [conversation, order] of points) insert.run(id, conversation, order);
    })();
  }

  // Zero when the identity has no unmask point in that conversation, so every slot stays unmasked.
  unmaskPoint(id: string, conversation: string): number {
    const row = this.#db
      .query<{ first_order: number }, [string, string]>('SELECT first_order FROM unmask_points WHERE identity = ? AND conversation = ?')
      .get(id, conversation);
    return row?.first_order ?? 0;
  }

  list(): Item[] {
    return this.#db
      .query<
        { id: string; status: Status; source: string; length: number; first_seen: string; updated_at: string },
        []
      >('SELECT id, status, source, length, first_seen, updated_at FROM items ORDER BY first_seen, id')
      .all()
      .map((row) => ({
        id: row.id,
        status: row.status,
        source: row.source,
        length: row.length,
        firstSeen: row.first_seen,
        updatedAt: row.updated_at,
      }));
  }

  close(): void {
    this.#db.close();
  }
}
