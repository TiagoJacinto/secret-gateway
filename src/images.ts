// Screenshot masking: local OCR finds words, the detector runs on the OCR text, and each match maps
// back to word boxes. Results are cached by image hash as identities and boxes only, never as values.
import { createHash } from 'node:crypto';
import type { ImageSlot } from './anthropic.ts';
import { findHits, type Scanner } from './hits.ts';
import { identityOf } from './identity.ts';
import type { Box, Detection, ImageEngine, ImageInspection } from './masker.ts';

export type OcrWord = { text: string; x0: number; y0: number; x1: number; y1: number };
export interface OcrEngine {
  recognize(png: Uint8Array): Promise<OcrWord[]>;
}
export interface Raster {
  upscale(png: Uint8Array, factor: number): Promise<Uint8Array>;
  paint(png: Uint8Array, rects: { box: Box; label: string }[]): Promise<Uint8Array>;
}

export type ScreenshotOptions = {
  key: Buffer;
  scanner: Scanner;
  ocr: OcrEngine;
  raster: Raster;
  timeoutMs?: number;
  log?: (line: string) => void;
  onWindowDegraded: (window: string) => void;
};

const WITHHELD = Symbol('withheld');

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('OCR timed out')), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

// Words joined by spaces. offsets[i] is where word i starts in the joined text.
export function layoutText(words: OcrWord[]): { text: string; offsets: number[] } {
  let text = '';
  const offsets: number[] = [];
  for (const word of words) {
    if (text !== '') text += ' ';
    offsets.push(text.length);
    text += word.text;
  }
  return { text, offsets };
}

// Boxes for a character range: each word contributes the part of its box that covers the range.
export function boxesFor(start: number, end: number, words: OcrWord[], offsets: number[], scale: number): Box[] {
  const boxes: Box[] = [];
  words.forEach((word, index) => {
    const from = offsets[index];
    const to = from + word.text.length;
    if (to <= start || from >= end || word.text.length === 0) return;
    const a = Math.max(start, from) - from;
    const b = Math.min(end, to) - from;
    const x0 = word.x0 + ((word.x1 - word.x0) * a) / word.text.length;
    const x1 = word.x0 + ((word.x1 - word.x0) * b) / word.text.length;
    boxes.push({ x: x0 / scale, y: word.y0 / scale, width: (x1 - x0) / scale, height: (word.y1 - word.y0) / scale });
  });
  return boxes;
}

export class ScreenshotEngine implements ImageEngine {
  readonly #options: ScreenshotOptions & { timeoutMs: number };
  readonly #cache = new Map<string, ImageInspection | typeof WITHHELD>();
  readonly #failures = new Map<string, number>();

  constructor(options: ScreenshotOptions) {
    this.#options = { timeoutMs: 20_000, ...options };
  }

  async inspect(slot: ImageSlot): Promise<ImageInspection> {
    const bytes = Buffer.from(slot.data, 'base64');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const cached = this.#cache.get(hash);
    if (cached === WITHHELD) return { kind: 'withheld' };
    if (cached) return cached;

    const result = await this.#scan(bytes);
    if (result.kind === 'withheld') {
      const count = (this.#failures.get(slot.window) ?? 0) + 1;
      this.#failures.set(slot.window, count);
      if (count === 3) this.#options.onWindowDegraded(slot.window);
      this.#cache.set(hash, WITHHELD);
      return result;
    }
    this.#failures.set(slot.window, 0);
    this.#cache.set(hash, result);
    return result;
  }

  // Identities and canonical values for a screenshot. Runs OCR again; nothing is cached.
  async recoverValues(slot: ImageSlot): Promise<Map<string, string>> {
    const bytes = Buffer.from(slot.data, 'base64');
    const values = new Map<string, string>();
    const words = await this.#recognize(bytes).catch(() => []);
    if (words.length === 0) return values;
    const { text } = layoutText(words);
    const [hits] = await findHits([{ text, gitContext: false }], this.#options.scanner);
    for (const hit of hits) values.set(identityOf(this.#options.key, hit.secret), hit.secret);
    return values;
  }

  async paint(slot: ImageSlot, labelled: { boxes: Box[]; label: string }[]): Promise<{ mediaType: string; data: string }> {
    const rects = labelled.flatMap((item) => item.boxes.map((box) => ({ box, label: item.label })));
    const png = await this.#options.raster.paint(Buffer.from(slot.data, 'base64'), rects);
    return { mediaType: 'image/png', data: Buffer.from(png).toString('base64') };
  }

  // One internal retry at 2x scale. A failure after the retry withholds the image.
  async #scan(bytes: Buffer): Promise<ImageInspection> {
    this.#options.log?.('screenshot: OCR run (cache miss)');
    let words: OcrWord[];
    let scale = 1;
    try {
      words = await this.#recognize(bytes);
    } catch {
      try {
        scale = 2;
        words = await this.#recognize(await this.#options.raster.upscale(bytes, 2));
      } catch {
        return { kind: 'withheld' };
      }
    }
    const { text, offsets } = layoutText(words);
    let hits;
    try {
      [hits] = await findHits([{ text, gitContext: false }], this.#options.scanner);
    } catch {
      return { kind: 'withheld' };
    }
    const merged = new Map<string, Detection>();
    for (const hit of hits) {
      const identity = identityOf(this.#options.key, hit.secret);
      const boxes = boxesFor(hit.start, hit.end, words, offsets, scale);
      const existing = merged.get(identity);
      if (existing) existing.boxes.push(...boxes);
      else merged.set(identity, { identity, length: hit.secret.length, boxes });
    }
    return { kind: 'ok', detections: [...merged.values()] };
  }

  #recognize(bytes: Uint8Array): Promise<OcrWord[]> {
    return withTimeout(this.#options.ocr.recognize(bytes), this.#options.timeoutMs);
  }
}
