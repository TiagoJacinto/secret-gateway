// In-memory copy of masked secret values and the lines they came from, keyed by identity. Only the
// review reveal page reads it. Values are never written to disk and are lost when the gateway stops.
// One appearance of a value: where it is in the session, and its line with the nearest non-empty lines around it.
export type Context = { location: string; above: string[]; before: string; value: string; after: string; below: string[] };

const MAX_CONTEXTS = 50;

type Entry = { value: string; contexts: Context[] };

export class SecretVault {
  readonly #entries = new Map<string, Entry>();

  remember(identity: string, value: string, context: Context): void {
    const entry = this.#entries.get(identity) ?? { value, contexts: [] };
    const seen = entry.contexts.some((known) => JSON.stringify(known) === JSON.stringify(context));
    if (!seen && entry.contexts.length < MAX_CONTEXTS) entry.contexts.push(context);
    this.#entries.set(identity, entry);
  }

  valueOf(identity: string): string | undefined {
    return this.#entries.get(identity)?.value;
  }

  contextsOf(identity: string): Context[] {
    return this.#entries.get(identity)?.contexts ?? [];
  }
}
