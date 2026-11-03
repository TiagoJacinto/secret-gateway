// Value store: the masked values the review page shows, kept in values.sqlite (owner-only, mode 0600).
// Per identity it holds the value, one row per appearance (a Context, stored once by digest) and the last
// line. Answers and conversation records stay in answers.sqlite. Appearance rows are keyed by digest, so a
// restart or a second process on the same data directory cannot store one appearance twice.
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import type { Context } from './vault.ts';

export class ValueStore {
  readonly #db: Database;

  constructor(path: string) {
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
    this.#db = new Database(path, { create: true });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS entries (
        identity TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        last_line TEXT
      );
      CREATE TABLE IF NOT EXISTS appearances (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        identity TEXT NOT NULL,
        digest TEXT NOT NULL,
        context TEXT NOT NULL,
        UNIQUE (identity, digest)
      );
    `);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  }

  valueOf(identity: string): string | undefined {
    return this.#db.query<{ value: string }, [string]>('SELECT value FROM entries WHERE identity = ?').get(identity)?.value;
  }

  lastLineOf(identity: string): string | undefined {
    const row = this.#db
      .query<{ last_line: string | null }, [string]>('SELECT last_line FROM entries WHERE identity = ?')
      .get(identity);
    return row?.last_line ?? undefined;
  }

  contextsOf(identity: string): Context[] {
    return this.#db
      .query<{ context: string }, [string]>('SELECT context FROM appearances WHERE identity = ? ORDER BY seq')
      .all(identity)
      .map((row) => JSON.parse(row.context) as Context);
  }

  // Stores the appearance unless it is already stored or the identity already has `limit` of them.
  // The first appearance also creates the entry with the value. Nothing is written when the appearance is known.
  record(identity: string, value: string, context: Context, limit: number): void {
    const json = JSON.stringify(context);
    const digest = createHash('sha256').update(json).digest('hex');
    if (this.#db.query('SELECT 1 FROM appearances WHERE identity = ? AND digest = ?').get(identity, digest)) return;
    this.#db.transaction(() => {
      const { count } = this.#db
        .query<{ count: number }, [string]>('SELECT COUNT(*) AS count FROM appearances WHERE identity = ?')
        .get(identity)!;
      if (count >= limit) return;
      this.#db.query('INSERT OR IGNORE INTO entries (identity, value) VALUES (?, ?)').run(identity, value);
      this.#db.query('INSERT OR IGNORE INTO appearances (identity, digest, context) VALUES (?, ?, ?)').run(identity, digest, json);
    }).immediate();
  }

  // Sets the last line of each identity that has an entry. Identities without one are ignored.
  setLastLines(lines: [string, string][]): void {
    this.#db.transaction(() => {
      const update = this.#db.query('UPDATE entries SET last_line = ? WHERE identity = ?');
      for (const [identity, line] of lines) update.run(line, identity);
    })();
  }

  // Deletes the value, its appearances and its last line. Returns false when no value was stored.
  forget(identity: string): boolean {
    return this.#db.transaction(() => {
      this.#db.query('DELETE FROM appearances WHERE identity = ?').run(identity);
      return this.#db.query('DELETE FROM entries WHERE identity = ?').run(identity).changes === 1;
    })();
  }

  close(): void {
    this.#db.close();
  }
}
