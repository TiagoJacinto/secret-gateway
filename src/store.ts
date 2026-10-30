// Answers store: one row per secret identity. Holds status, source description, length and
// timestamps. It never holds a secret value.
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync } from 'node:fs';

export type Status = 'pending' | 'secret' | 'not_secret';
export type Item = { id: string; status: Status; source: string; length: number; firstSeen: string; updatedAt: string };

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
    `);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  }

  statusOf(id: string): Status | undefined {
    const row = this.#db.query<{ status: Status }, [string]>('SELECT status FROM items WHERE id = ?').get(id);
    return row?.status;
  }

  // Records a new identity as pending. Returns true when the identity is new.
  ensurePending(id: string, source: string, length: number, now: string): boolean {
    const result = this.#db
      .query('INSERT OR IGNORE INTO items (id, status, source, length, first_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'pending', source, length, now, now);
    return result.changes === 1;
  }

  answer(id: string, status: Exclude<Status, 'pending'>, now: string): boolean {
    const result = this.#db
      .query('UPDATE items SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, id);
    return result.changes === 1;
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
