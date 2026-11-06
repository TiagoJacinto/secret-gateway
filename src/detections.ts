// Detection patterns: regular expressions for secret formats the scanner misses. A match is masked wherever
// it appears, as if the scanner had found it. This is the inverse of exemptions.ts. An entry here only
// masks more, so it needs no credential canaries, but it must compile, stay within the same syntax bounds
// as exemptions (so matching stays fast), and must not match ordinary text.
// The file is detections.json in the data directory. The gateway reloads it on the next request.
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { patternSyntaxProblem } from './exemptions.ts';

// caseSensitive is required: the caller states the case rule for every pattern, so no pattern gets one silently.
export type Detection = { kind: 'pattern'; value: string; caseSensitive: boolean; note?: string };

// Samples of ordinary text. A pattern that matches one of them would mask normal text, so it is refused.
const BROAD_SAMPLES = ['', ' ', 'a', 'A', '0'];

export function detectionsPath(dataDir: string): string {
  return join(dataDir, 'detections.json');
}

// Why an entry is refused, or undefined when it is valid.
export function check(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return 'entry must be an object';
  const { kind, value, caseSensitive, note } = entry as Record<string, unknown>;
  if (note !== undefined && typeof note !== 'string') return 'note must be a string';
  if (kind !== 'pattern') return 'kind must be "pattern"';
  if (typeof value !== 'string') return 'value must be a string';
  if (typeof caseSensitive !== 'boolean') return 'caseSensitive must be true or false';
  const syntax = patternSyntaxProblem(value);
  if (syntax) return syntax;
  let regex: RegExp;
  try {
    // No 'g' here: the sample test must not carry state between calls.
    regex = new RegExp(value, caseSensitive ? '' : 'i');
  } catch (error) {
    return `not a valid regular expression: ${(error as Error).message}`;
  }
  for (const sample of BROAD_SAMPLES) {
    if (regex.test(sample)) return `pattern is too broad: it matches ${JSON.stringify(sample)}, so it would mask ordinary text`;
  }
  return undefined;
}

// Global, so every match in a text is found. Case follows the entry: sensitive matches only the capitalization
// the pattern spells out, insensitive matches any capitalization.
export function compileDetections(entries: Detection[]): RegExp[] {
  return entries.map((entry) => new RegExp(entry.value, entry.caseSensitive ? 'g' : 'gi'));
}

export function readEntries(path: string): Detection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
  const list = (parsed as { detections?: unknown } | null)?.detections;
  if (!Array.isArray(list)) throw new Error('"detections" must be an array');
  list.forEach((entry, index) => {
    const problem = check(entry);
    if (problem) throw new Error(`detections[${index}]: ${problem}`);
  });
  return list as Detection[];
}

// Replaces the file in one rename, so the gateway never reads a half-written list.
export function writeEntries(path: string, entries: Detection[]): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ detections: entries }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

// Creates the file empty on first use. From then on the file is the source of truth.
export function ensureSeeded(path: string): void {
  if (!existsSync(path)) writeEntries(path, []);
  else chmodSync(path, 0o600);
}

function stampOf(path: string): string {
  const info = statSync(path, { throwIfNoEntry: false });
  return info ? `${info.mtimeMs}:${info.size}:${info.ino}` : 'missing';
}

export class DetectionFile {
  readonly #path: string;
  readonly #log: (line: string) => void;
  #stamp = '';
  #current: RegExp[] = [];

  constructor(path: string, log: (line: string) => void) {
    this.#path = path;
    this.#log = log;
    ensureSeeded(path);
    // Startup refuses an invalid file. Running without its patterns would send the secrets they name unmasked.
    try {
      this.#current = compileDetections(readEntries(path));
    } catch (error) {
      throw new Error(`refusing to start: ${(error as Error).message}`);
    }
    this.#stamp = stampOf(path);
    log(`detections loaded: ${this.#current.length} patterns`);
  }

  // The patterns for the next request. Reloads when the file changed. An invalid file keeps the last valid
  // list and logs the reason.
  current(): RegExp[] {
    const stamp = stampOf(this.#path);
    if (stamp === this.#stamp) return this.#current;
    this.#stamp = stamp;
    try {
      this.#current = compileDetections(readEntries(this.#path));
      this.#log(`detections loaded: ${this.#current.length} patterns`);
    } catch (error) {
      this.#log(`detections not loaded, keeping the previous list: ${(error as Error).message}`);
    }
    return this.#current;
  }
}
