// OCR benchmark: exact fixture-key reads, latency per screenshot, and masking coverage of the real
// screenshot engine. Run from the repository root: bun run bench/ocr.ts
// Acceptance from the issue: every fixture key read exactly, with latency reported. Coverage is the
// security outcome: a painted box must overlap each secret key's ground-truth box.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ScreenshotEngine } from '../src/images.ts';
import { ExternalScanner, providerScanner } from '../src/scanner.ts';
import { TesseractOcr, SharpRaster } from '../src/screenshot-backends.ts';
import type { ImageSlot } from '../src/anthropic.ts';

type Case = { id: string; file: string; keys: string[]; keyBoxes: number[][] };
const PROVIDER_KEY = /^(npg_|cfut_|GOCSPX-|ya29\.|ghp_|github_pat_|sk-ant-|AKIA|sk_live_)/;
const fixtureDir = resolve('.agents/verification/fixtures');
const cases: Case[] = await Bun.file(join(fixtureDir, 'ocr-cases.json')).json();
const trials = 3;

const median = (values: number[]) => Math.round([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]);

// Tesseract: the engine the gateway uses.
const tesseract = new TesseractOcr();
const tesseractRows = [];
for (const item of cases) {
  const png = new Uint8Array(await Bun.file(join(fixtureDir, item.file)).arrayBuffer());
  await tesseract.recognize(png); // warm-up
  const times: number[] = [];
  let words: { text: string }[] = [];
  for (let trial = 0; trial < trials; trial++) {
    const started = performance.now();
    words = await tesseract.recognize(png);
    times.push(performance.now() - started);
  }
  const texts = words.map((word) => word.text);
  const exact = item.keys.map((key) => texts.some((text) => text.includes(key)));
  tesseractRows.push({ id: item.id, exact: exact.filter(Boolean).length, keys: exact.length, msMedian: median(times) });
}

// Screenshot engine end to end (OCR, detection, boxes) and masking coverage per secret key box.
const key = randomBytes(32);
const scanner = new ExternalScanner(providerScanner('.tools/bin/betterleaks'));
const coverageRows = [];
for (const item of cases) {
  const data = (await Bun.file(join(fixtureDir, item.file)).arrayBuffer());
  const base64 = Buffer.from(data).toString('base64');
  const engine = new ScreenshotEngine({ key, scanner, ocr: new TesseractOcr(), raster: new SharpRaster(), onWindowDegraded: () => undefined });
  const slot = { kind: 'image', mediaType: 'image/png', data: base64, source: 'bench', window: `bench-${item.id}`, replace() {}, withhold() {} } as ImageSlot;
  const started = performance.now();
  const inspection = await engine.inspect(slot);
  const inspectMs = Math.round(performance.now() - started);
  const boxes = inspection.kind === 'ok' ? inspection.detections.flatMap((d) => d.boxes) : [];
  const secretBoxes = item.keys.map((value, index) => ({ value, box: item.keyBoxes[index] })).filter((entry) => PROVIDER_KEY.test(entry.value));
  const covered = secretBoxes.map(({ box: [x0, y0, x1, y1] }) => {
    const area = (x1 - x0) * (y1 - y0);
    return boxes.some((b) => {
      const ix = Math.max(0, Math.min(x1, b.x + b.width) - Math.max(x0, b.x));
      const iy = Math.max(0, Math.min(y1, b.y + b.height) - Math.max(y0, b.y));
      return (ix * iy) / area >= 0.5;
    });
  });
  coverageRows.push({ id: item.id, secretKeys: secretBoxes.length, covered: covered.filter(Boolean).length, inspectMs, withheld: inspection.kind !== 'ok' });
}

// RapidOCR: candidate engine, Python in the project-local venv. Line texts only, so exact reads only.
const rapidProcess = Bun.spawn(['.tools/rapidocr-venv/bin/python', 'bench/rapidocr_exact.py', join(fixtureDir, 'ocr-cases.json')], { stdout: 'pipe', stderr: 'ignore' });
const rapidLines = (await new Response(rapidProcess.stdout).text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
await rapidProcess.exited;
const rapidRows = cases.map((item) => {
  const row = rapidLines.find((entry) => entry.id === item.id);
  const texts: string[] = row?.lines ?? [];
  const exact = item.keys.map((k) => texts.some((text) => text.includes(k)));
  return { id: item.id, exact: exact.filter(Boolean).length, keys: exact.length, msMedian: row?.msMedian ?? null };
});

const totals = (rows: { exact: number; keys: number }[]) => ({ exact: rows.reduce((n, r) => n + r.exact, 0), keys: rows.reduce((n, r) => n + r.keys, 0) });
const report = {
  checkedAt: new Date().toISOString(),
  fixtures: 'ocr-cases.json (synthetic dashboard screenshots, DejaVu fonts)',
  acceptance: 'every fixture key read exactly (issue #1); latency reported',
  engines: {
    'tesseract.js 7.0.0 (LSTM, 4.0.0_best_int)': {
      exactKeyReads: totals(tesseractRows),
      msPerScreenshotMedian: median(tesseractRows.map((r) => r.msMedian)),
      perImage: tesseractRows,
    },
    'rapidocr 3.10.0 (PP-OCR, line boxes only)': {
      exactKeyReads: totals(rapidRows),
      msPerScreenshotMedian: median(rapidRows.map((r) => r.msMedian ?? 0)),
      perImage: rapidRows,
    },
  },
  maskingCoverage: {
    engine: 'gateway ScreenshotEngine with Tesseract and provider-rule Betterleaks',
    secretKeys: coverageRows.reduce((n, r) => n + r.secretKeys, 0),
    covered: coverageRows.reduce((n, r) => n + r.covered, 0),
    perImage: coverageRows,
  },
  acceptanceMet: totals(tesseractRows).exact === totals(tesseractRows).keys,
};
const evidenceDir = join(homedir(), '.agents/projects/secret-gateway/goals/issue-1/evidence');
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, 'ocr-benchmark.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ acceptanceMet: report.acceptanceMet, engines: Object.fromEntries(Object.entries(report.engines).map(([name, e]) => [name, { exactKeyReads: e.exactKeyReads, msPerScreenshotMedian: e.msPerScreenshotMedian }])), maskingCoverage: { secretKeys: report.maskingCoverage.secretKeys, covered: report.maskingCoverage.covered } }, null, 2));
