// Concrete screenshot backends: Tesseract (tesseract.js, project-local data) for OCR with word boxes,
// and sharp for upscaling and painting labelled boxes. Both run locally; no network calls.
import { resolve } from 'node:path';
import { createWorker, OEM, type Worker } from 'tesseract.js';
import sharp from 'sharp';
import type { OcrEngine, OcrWord, Raster } from './images.ts';
import type { Box } from './masker.ts';

const ROOT = resolve(import.meta.dir, '..');
const LANG_PATH = resolve(ROOT, 'node_modules/@tesseract.js-data/eng/4.0.0_best_int');
// Bun resolves the default worker from its install cache, which lacks regenerator-runtime.
// The Node worker source inside node_modules resolves its dependencies from the project instead.
const WORKER_PATH = resolve(ROOT, 'node_modules/tesseract.js/src/worker-script/node/index.js');
const LABEL_FONT = 'DejaVu Sans, sans-serif';

type TesseractWord = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } };

export class TesseractOcr implements OcrEngine {
  #worker: Promise<Worker> | undefined;

  #ready(): Promise<Worker> {
    this.#worker ??= createWorker('eng', OEM.LSTM_ONLY, {
      langPath: LANG_PATH,
      gzip: true,
      cacheMethod: 'none',
      workerPath: WORKER_PATH,
      logger: () => undefined,
      // Without a handler, tesseract.js throws from its message listener on an unreadable image and the
      // whole gateway exits. The failed recognize promise still rejects, so the image is withheld.
      errorHandler: () => undefined,
    });
    return this.#worker;
  }

  async recognize(png: Uint8Array): Promise<OcrWord[]> {
    const worker = await this.#ready();
    const { data } = await worker.recognize(Buffer.from(png), {}, { blocks: true });
    const words: TesseractWord[] = (data.blocks ?? []).flatMap((block) =>
      block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words)),
    );
    return words
      .filter((word) => word.text.trim() !== '')
      .map((word) => ({ text: word.text.trim(), x0: word.bbox.x0, y0: word.bbox.y0, x1: word.bbox.x1, y1: word.bbox.y1 }));
  }
}

export class SharpRaster implements Raster {
  async upscale(png: Uint8Array, factor: number): Promise<Uint8Array> {
    const { width } = await sharp(Buffer.from(png)).metadata();
    if (!width) throw new Error('image has no width');
    return sharp(Buffer.from(png)).resize({ width: width * factor }).png().toBuffer();
  }

  async paint(png: Uint8Array, rects: { box: Box; label: string }[]): Promise<Uint8Array> {
    const image = sharp(Buffer.from(png));
    const { width, height } = await image.metadata();
    if (!width || !height) throw new Error('image has no size');
    const shapes = rects.map(({ box, label }) => {
      const pad = 2;
      const x = Math.max(0, box.x - pad);
      const y = Math.max(0, box.y - pad);
      const w = box.width + pad * 2;
      const h = box.height + pad * 2;
      const fontSize = Math.max(8, Math.round(h * 0.6));
      return [
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000000"/>`,
        `<text x="${x + 2}" y="${y + h * 0.72}" font-family="${LABEL_FONT}" font-size="${fontSize}" fill="#ffffff" textLength="${w - 4}" lengthAdjust="spacingAndGlyphs">${escapeXml(label)}</text>`,
      ].join('');
    });
    const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes.join('')}</svg>`;
    return image.composite([{ input: Buffer.from(overlay), top: 0, left: 0 }]).png().toBuffer();
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

export function createOcrEngine(): OcrEngine {
  return new TesseractOcr();
}

export function createRaster(): Raster {
  return new SharpRaster();
}
