// Masking core: decides what each request reveals to the provider, and builds the per-request
// restore table. Only identities and answers are persisted in the store. Masked values are kept
// in the in-memory vault, for the review reveal page only.
// Screenshots are not masked: they pass through unchanged by decision, since no local OCR is used.
import { findHits, type Hit, type Scanner } from './hits.ts';
import type { TextSlot } from './anthropic.ts';
import { identityOf, placeholderFor } from './identity.ts';
import type { AnswerStore, Status } from './store.ts';
import type { Context, SecretVault } from './vault.ts';

export type PendingItem = { id: string; source: string; length: number };
export type Options = {
  key: Buffer;
  store: AnswerStore;
  vault: SecretVault;
  scanner: Scanner;
  // Review page link for a masked identity. Responses link to it instead of showing the value.
  revealUrl: (identity: string) => string;
  now: () => string;
  onPending: (item: PendingItem) => void;
  // Format adapter: turns a request body into text slots. The core never reads the body itself.
  collectSlots: (body: Record<string, any>) => TextSlot[];
};

const TEXT_WITHHELD = '[content withheld by secret-gateway: the secret scanner was unavailable, so it was not sent]';
// A reply link the gateway added to an earlier response. Sent back as history, it becomes its placeholder
// alone, so the review token never reaches the provider and the link is not scanned as a new value.
const REVIEW_LINK = /\[(⟦SECRET_[0-9a-f]{6,64}⟧)\]\(http:\/\/127\.0\.0\.1:\d+\/review\/reveal\/[0-9a-f]{64}\?token=[0-9a-f]{32}\)/g;

// lookup gives the real value for tool inputs. link gives the review page URL for text.
export type Restore = {
  lookup(placeholder: string): Promise<string | undefined>;
  link(placeholder: string): Promise<string | undefined>;
};
export type MaskedRequest = { body: Record<string, any>; restore: Restore; degraded: boolean; masked: number };
// Set by the format adapter: which conversation the request belongs to, and its message count.
export type Conversation = { key: string; count: number };

export class Masker {
  readonly #options: Options;

  constructor(options: Options) {
    this.#options = options;
  }

  // Called when an answer is saved. "Not a secret" unmasks only what each conversation sends after this point:
  // the slots that were already sent masked keep their placeholders, so the cached prefix does not change.
  recordAnswer(identity: string, status: Exclude<Status, 'pending'>): void {
    const points = new Map<string, number>();
    if (status === 'not_secret') {
      for (const [conversation, count] of this.#options.store.conversationCounts()) points.set(conversation, count + 1);
    }
    this.#options.store.setUnmaskPoints(identity, points);
  }

  async mask(body: Record<string, any>, conversation: Conversation): Promise<MaskedRequest> {
    const { key, store, vault, scanner, revealUrl, now, onPending, collectSlots } = this.#options;
    const textSlots = collectSlots(body);
    store.recordConversation(conversation.key, conversation.count);
    for (const slot of textSlots) {
      const unlinked = slot.text.replace(REVIEW_LINK, '$1');
      if (unlinked !== slot.text) {
        slot.write(unlinked);
        slot.text = unlinked;
      }
    }

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
          if (status === 'not_secret' && slot.order >= store.unmaskPoint(identity, conversation.key)) continue;
          maskedSecrets.set(identity, hit.secret);
          hits.push({ ...hit, identity });
        }
        if (hits.length > 0) textPlans.push({ slot, hits });
      });
    }

    const placeholders = assignPlaceholders([...maskedSecrets.keys()]);
    for (const { slot, hits } of textPlans) {
      for (const hit of hits) {
        vault.remember(hit.identity, hit.secret, contextOf(slot, hits, hit, placeholders));
      }
    }

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
      link: async (placeholder) => {
        const identity = identityByPlaceholder.get(placeholder);
        return identity === undefined ? undefined : revealUrl(identity);
      },
    };
    return { body, restore, degraded, masked: maskedSecrets.size };
  }
}

const LINE_CHARS = 300;

// The line of a masked value, with the nearest non-empty line above and below it. Empty lines between
// them are kept. Every masked value in that window appears as its placeholder, so the context reveals
// no other masked value.
function contextOf(
  slot: TextSlot,
  hits: (Hit & { identity: string })[],
  target: Hit & { identity: string },
  placeholders: Map<string, string>,
): Context {
  const text = slot.text;
  const windowStart = windowStartAbove(text, target.start);
  const windowEnd = windowEndBelow(text, target.end);
  const preLines = maskedSpan(text, windowStart, target.start, hits, placeholders).split('\n');
  const postLines = maskedSpan(text, target.end, windowEnd, hits, placeholders).split('\n');
  const before = preLines.pop()!;
  const after = postLines.shift()!;
  return {
    location: slot.location,
    above: preLines.map((line) => line.slice(0, LINE_CHARS)),
    before: before.slice(-LINE_CHARS),
    value: target.secret,
    after: after.slice(0, LINE_CHARS),
    below: postLines.map((line) => line.slice(0, LINE_CHARS)),
  };
}

// Start of the nearest non-empty line above the line that holds `index`. Empty lines above it are kept.
function windowStartAbove(text: string, index: number): number {
  let start = lineStartOf(text, index);
  while (start > 0) {
    const previous = lineStartOf(text, start - 1);
    const blank = text.slice(previous, start - 1).trim() === '';
    start = previous;
    if (!blank) break;
  }
  return start;
}

// End of the nearest non-empty line below the line that holds `index`. Empty lines below it are kept.
function windowEndBelow(text: string, index: number): number {
  let end = lineEndOf(text, index);
  while (end < text.length) {
    const next = end + 1;
    const nextEnd = lineEndOf(text, next);
    const blank = text.slice(next, nextEnd).trim() === '';
    end = nextEnd;
    if (!blank) break;
  }
  return end;
}

function lineStartOf(text: string, index: number): number {
  return index === 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1;
}

function lineEndOf(text: string, index: number): number {
  const end = text.indexOf('\n', index);
  return end === -1 ? text.length : end;
}

// Text from `from` to `to`, with each masked value inside that range replaced by its placeholder.
function maskedSpan(
  text: string,
  from: number,
  to: number,
  hits: (Hit & { identity: string })[],
  placeholders: Map<string, string>,
): string {
  let out = '';
  let cursor = from;
  for (const hit of hits.filter((item) => item.start >= from && item.end <= to).sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, hit.start) + placeholders.get(hit.identity)!;
    cursor = hit.end;
  }
  return out + text.slice(cursor, to);
}

// Uniform prefix length across the request: six hex characters unless two identities collide.
export function assignPlaceholders(identities: string[]): Map<string, string> {
  const unique = [...new Set(identities)];
  let length = 6;
  while (length < 64 && new Set(unique.map((identity) => identity.slice(0, length))).size !== unique.length) length += 2;
  return new Map(unique.map((identity) => [identity, placeholderFor(identity, length)]));
}
