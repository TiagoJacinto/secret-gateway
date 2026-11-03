// Masked values for the review page: each value, its appearances, and the last line it appeared in.
// They are stored by the value store (values.sqlite in the data directory). Last lines are held in memory and
// written by flush, every LAST_LINE_FLUSH_MS and at shutdown. Reads see a new last line at once.
import type { ValueStore } from './values.ts';

// One appearance of a value: where it is in the session, and its line with the nearest non-empty lines around it.
export type Context = { location: string; above: string[]; before: string; value: string; after: string; below: string[] };

export const MAX_CONTEXTS = 50;
export const LAST_LINE_FLUSH_MS = 5_000;

export class SecretVault {
  readonly #store: ValueStore;
  readonly #onError: (name: string) => void;
  readonly #pendingLines = new Map<string, string>();

  // onError receives the error name only, so the log never carries a value or a message.
  constructor(options: { store: ValueStore; onError: (name: string) => void }) {
    this.#store = options.store;
    this.#onError = options.onError;
  }

  // A failed write is reported and does not stop masking: the request still goes out masked.
  remember(identity: string, value: string, context: Context): void {
    this.#attempt(() => this.#store.record(identity, value, context, MAX_CONTEXTS));
  }

  valueOf(identity: string): string | undefined {
    return this.#store.valueOf(identity);
  }

  contextsOf(identity: string): Context[] {
    return this.#store.contextsOf(identity);
  }

  // Replaces the previous last line. It is written by the next flush.
  setLastLine(identity: string, line: string): void {
    this.#pendingLines.set(identity, line);
  }

  lastLineOf(identity: string): string | undefined {
    return this.#pendingLines.get(identity) ?? this.#store.lastLineOf(identity);
  }

  // Writes the pending last lines. After a failed write they stay pending for the next flush.
  flush(): void {
    if (this.#pendingLines.size === 0) return;
    const lines = [...this.#pendingLines];
    if (this.#attempt(() => this.#store.setLastLines(lines))) this.#pendingLines.clear();
  }

  // Deletes the stored value, its appearances and its last line. The status in the answers store stays.
  // A later request that carries the value stores it again.
  forget(identity: string): boolean {
    this.#pendingLines.delete(identity);
    return this.#store.forget(identity);
  }

  #attempt(write: () => void): boolean {
    try {
      write();
      return true;
    } catch (error) {
      this.#onError((error as Error).name);
      return false;
    }
  }
}
