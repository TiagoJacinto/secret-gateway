// Masking core: decides what each request reveals to the provider, and builds the per-request
// restore table. Nothing here is persisted except identities and answers in the store.
// Screenshots are not masked: they pass through unchanged by decision, since no local OCR is used.
import { findHits, type Hit, type Scanner } from './hits.ts';
import type { TextSlot } from './anthropic.ts';
import { identityOf, placeholderFor } from './identity.ts';
import type { AnswerStore, Status } from './store.ts';

export type PendingItem = { id: string; source: string; length: number };
export type Options = {
  key: Buffer;
  store: AnswerStore;
  scanner: Scanner;
  now: () => string;
  onPending: (item: PendingItem) => void;
  // Format adapter: turns a request body into text slots. The core never reads the body itself.
  collectSlots: (body: Record<string, any>) => TextSlot[];
};

const TEXT_WITHHELD = '[content withheld by secret-gateway: the secret scanner was unavailable, so it was not sent]';

export type Restore = { lookup(placeholder: string): Promise<string | undefined> };
export type MaskedRequest = { body: Record<string, any>; restore: Restore; degraded: boolean };

export class Masker {
  readonly #options: Options;

  constructor(options: Options) {
    this.#options = options;
  }

  async mask(body: Record<string, any>): Promise<MaskedRequest> {
    const { key, store, scanner, now, onPending, collectSlots } = this.#options;
    const textSlots = collectSlots(body);

    const statuses = new Map<string, Status>();
    const statusOf = (identity: string, source: string, length: number): Status => {
      const known = statuses.get(identity) ?? store.statusOf(identity);
      if (known) {
        statuses.set(identity, known);
        return known;
      }
      if (store.ensurePending(identity, source, length, now())) onPending({ id: identity, source, length });
      statuses.set(identity, 'pending');
      return 'pending';
    };

    let textHits: Hit[][] | undefined;
    try {
      textHits = await findHits(
        textSlots.map((slot) => ({ text: slot.text, gitContext: slot.gitContext })),
        scanner,
      );
    } catch {
      textHits = undefined;
    }
    const degraded = textHits === undefined;

    // Masked identities, with the canonical secret when the value came from text.
    const maskedSecrets = new Map<string, string>();
    const textPlans: { slot: TextSlot; hits: (Hit & { identity: string })[] }[] = [];

    if (!degraded) {
      textSlots.forEach((slot, index) => {
        const hits: (Hit & { identity: string })[] = [];
        for (const hit of textHits![index]) {
          const identity = identityOf(key, hit.secret);
          const status = statusOf(identity, slot.source, hit.secret.length);
          if (status === 'not_secret') continue;
          maskedSecrets.set(identity, hit.secret);
          hits.push({ ...hit, identity });
        }
        if (hits.length > 0) textPlans.push({ slot, hits });
      });
    }

    const placeholders = assignPlaceholders([...maskedSecrets.keys()]);

    // Text: replace masked spans, last span first so earlier offsets stay valid.
    if (degraded) {
      for (const slot of textSlots) slot.write(TEXT_WITHHELD);
    } else {
      for (const { slot, hits } of textPlans) {
        let text = slot.text;
        for (const hit of [...hits].sort((a, b) => b.start - a.start)) {
          text = text.slice(0, hit.start) + placeholders.get(hit.identity)! + text.slice(hit.end);
        }
        slot.write(text);
      }
    }

    const identityByPlaceholder = new Map([...placeholders].map(([identity, placeholder]) => [placeholder, identity]));
    const restore: Restore = {
      lookup: async (placeholder) => {
        const identity = identityByPlaceholder.get(placeholder);
        return identity === undefined ? undefined : maskedSecrets.get(identity);
      },
    };
    return { body, restore, degraded };
  }
}

// Uniform prefix length across the request: six hex characters unless two identities collide.
export function assignPlaceholders(identities: string[]): Map<string, string> {
  const unique = [...new Set(identities)];
  let length = 6;
  while (length < 64 && new Set(unique.map((identity) => identity.slice(0, length))).size !== unique.length) length += 2;
  return new Map(unique.map((identity) => [identity, placeholderFor(identity, length)]));
}
