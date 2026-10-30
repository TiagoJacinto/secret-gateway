// Masking core: decides what each request reveals to the provider, and builds the per-request
// restore table. Nothing here is persisted except identities and answers in the store.
import { findHits, type Hit, type Scanner } from './hits.ts';
import type { ImageSlot, TextSlot } from './anthropic.ts';
import { identityOf, placeholderFor } from './identity.ts';
import type { AnswerStore, Status } from './store.ts';

export type Box = { x: number; y: number; width: number; height: number };
export type Detection = { identity: string; length: number; boxes: Box[] };
export type ImageInspection = { kind: 'withheld' } | { kind: 'ok'; detections: Detection[] };

// Image engine: OCR-backed inspection (cached by image hash, values never cached), value recovery for
// restores, and painting. The masker never sees OCR text, only identities and boxes.
export interface ImageEngine {
  inspect(slot: ImageSlot): Promise<ImageInspection>;
  recoverValues(slot: ImageSlot): Promise<Map<string, string>>;
  paint(slot: ImageSlot, labelled: { boxes: Box[]; label: string }[]): Promise<{ mediaType: string; data: string }>;
}

export type PendingItem = { id: string; source: string; length: number };
export type Options = {
  key: Buffer;
  store: AnswerStore;
  scanner: Scanner;
  images: ImageEngine;
  now: () => string;
  onPending: (item: PendingItem) => void;
  // Format adapter: turns a request body into text and image slots. The core never reads the body itself.
  collectSlots: (body: Record<string, any>) => (TextSlot | ImageSlot)[];
};

const TEXT_WITHHELD = '[content withheld by secret-gateway: the secret scanner was unavailable, so it was not sent]';

export type Restore = { lookup(placeholder: string): Promise<string | undefined> };
export type MaskedRequest = { body: Record<string, any>; restore: Restore; degraded: boolean };

export const IMAGE_WITHHELD = '[screenshot withheld by secret-gateway: it could not be scanned. Take a smaller screenshot or read the accessibility tree instead.]';

export class Masker {
  readonly #options: Options;

  constructor(options: Options) {
    this.#options = options;
  }

  async mask(body: Record<string, any>): Promise<MaskedRequest> {
    const { key, store, scanner, images, now, onPending, collectSlots } = this.#options;
    const slots = collectSlots(body);
    const textSlots = slots.filter((slot): slot is TextSlot => slot.kind === 'text');
    const imageSlots = slots.filter((slot): slot is ImageSlot => slot.kind === 'image');

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

    const inspections = new Map<ImageSlot, ImageInspection>();
    for (const slot of imageSlots) inspections.set(slot, await images.inspect(slot));

    // Masked identities, with the canonical secret when the value came from text.
    const maskedSecrets = new Map<string, string>();
    const maskedImageIdentities = new Map<ImageSlot, string[]>();
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

    for (const slot of imageSlots) {
      const inspection = inspections.get(slot)!;
      if (inspection.kind !== 'ok') continue;
      const masked: string[] = [];
      for (const detection of inspection.detections) {
        if (statusOf(detection.identity, slot.source, detection.length) !== 'not_secret') masked.push(detection.identity);
      }
      if (masked.length > 0) maskedImageIdentities.set(slot, masked);
    }

    const allIdentities = [
      ...maskedSecrets.keys(),
      ...[...maskedImageIdentities.values()].flat(),
    ];
    const placeholders = assignPlaceholders(allIdentities);

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

    // Images: withheld when inspection failed; painted when any masked box is present; otherwise untouched.
    for (const slot of imageSlots) {
      const inspection = inspections.get(slot)!;
      if (inspection.kind !== 'ok') {
        slot.withhold(IMAGE_WITHHELD);
        continue;
      }
      const identities = maskedImageIdentities.get(slot);
      if (!identities) continue;
      const labelled = inspection.detections
        .filter((detection) => identities.includes(detection.identity))
        .map((detection) => ({ boxes: detection.boxes, label: placeholders.get(detection.identity)! }));
      const painted = await images.paint(slot, labelled);
      slot.replace(painted.mediaType, painted.data);
    }

    // A placeholder from a screenshot has no value in memory. Its value is recovered by re-reading that
    // screenshot, and only when the model actually uses the placeholder.
    const identityByPlaceholder = new Map([...placeholders].map(([identity, placeholder]) => [placeholder, identity]));
    const recovered = new Map<ImageSlot, Map<string, string>>();
    const restore: Restore = {
      lookup: async (placeholder) => {
        const identity = identityByPlaceholder.get(placeholder);
        if (identity === undefined) return undefined;
        const direct = maskedSecrets.get(identity);
        if (direct !== undefined) return direct;
        for (const [slot, identities] of maskedImageIdentities) {
          if (!identities.includes(identity)) continue;
          if (!recovered.has(slot)) recovered.set(slot, await images.recoverValues(slot));
          const value = recovered.get(slot)!.get(identity);
          if (value !== undefined) return value;
        }
        return undefined;
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
