// Exemption lists: identifiers and keys whose values are routing data, not credentials. They live in
// exemptions.json in the data directory, so editing the file (or `bun run exempt`) applies to the next
// request without a restart. Entries are patterns and key names only, never secret values, so the
// file holds nothing the disk-non-disclosure rule protects. An exemption only lowers masking, so an
// entry that could cover a credential is refused.
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAME_KEYWORD } from './detect.ts';

// A pattern is a JavaScript regular expression (case-insensitive) that must match a whole identifier, so
// `mcp:launch:.*` exempts `mcp:launch:` followed by anything. See `patternProblem` for what is refused.
export type Exemption = { kind: 'pattern' | 'key'; value: string; note?: string };
// The compiled form: one anchored regex per pattern, and one regex per key that matches the text before a value.
export type Exemptions = { patterns: RegExp[]; keys: RegExp[] };

const MAX_PATTERN_LENGTH = 128;
// With no quantifier on a group, k quantifiers cost at most the identifier length to the k-th power.
const MAX_QUANTIFIERS = 3;
const KEY_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
// Credential-shaped identifiers, generated here so no credential-like text sits in the source. A pattern
// that matches one would unmask real secrets, so it is refused.
const HEX = '0123456789abcdef';
const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function draw(alphabet: string, length: number, seed: number): string {
  let state = seed;
  let text = '';
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    text += alphabet[(state >>> 16) % alphabet.length];
  }
  return text;
}
const uuidHex = draw(HEX, 32, 2);
const CANARIES: Record<string, string> = {
  'a hex digest': draw(HEX, 32, 1),
  'a UUID': [uuidHex.slice(0, 8), uuidHex.slice(8, 12), uuidHex.slice(12, 16), uuidHex.slice(16, 20), uuidHex.slice(20)].join('-'),
  'a mixed-case token': draw(ALNUM, 32, 3),
  'a lowercase token': draw(LOWER, 32, 4),
  'a prefixed key': `ghp_${draw(ALNUM, 36, 5)}`,
  'a base64 string': Buffer.from(draw(ALNUM, 24, 6)).toString('base64'),
  'a JWT': [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from('{"sub":"1234567890"}').toString('base64url'), draw(`${ALNUM}_-`, 43, 7)].join('.'),
  'a path-like value': `v2/${draw(ALNUM, 32, 8)}/${draw(LOWER, 32, 9)}`,
};

// T3 Code routing data: the IDs and links agents pass back to T3 tools.
export const SEED: Exemption[] = [
  ...['mcp(?::|%3A)launch(?::|%3A).*', 'scheduled-task:.*', 'run:thread:.*', 'message:(?:mcp|provider):.*', 'turn-item:.*',
    '(?:thread:delegated-task|delegated-task):.*', 't3-(?:thread|citation)://.*']
    .map((value): Exemption => ({ kind: 'pattern', value, note: 'T3 Code identifier' })),
  ...['threadId', 'projectId', 'runId', 'messageId', 'itemId', 'taskId', 'scheduledTaskId', 'environmentId',
    'latestRunId', 'activeRunId', 'boundThreadId', 'parentThreadId', 'sourceThreadId', 'senderThreadId']
    .map((value): Exemption => ({ kind: 'key', value, note: 'T3 Code identifier' })),
];

export function exemptionsPath(dataDir: string): string {
  return join(dataDir, 'exemptions.json');
}

// Why an entry is refused, or undefined when it is valid.
export function check(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return 'entry must be an object';
  const { kind, value, note } = entry as Record<string, unknown>;
  if (note !== undefined && typeof note !== 'string') return 'note must be a string';
  if (typeof value !== 'string') return 'value must be a string';
  if (kind === 'pattern') return patternProblem(value);
  if (kind === 'key') {
    if (!KEY_NAME.test(value)) return 'key must be a name of letters, digits, _ . -, starting with a letter';
    if (NAME_KEYWORD.test(value)) return 'key looks like a credential name (KEY, TOKEN, SECRET, PASSWORD, PASS, AUTH, CREDENTIAL, DATABASE_URL), so its value stays masked';
    return undefined;
  }
  return 'kind must be "pattern" or "key"';
}

// Why a pattern is refused, or undefined when it is safe to run on every identifier. Backtracking cost is
// bounded by syntax: no backreferences, lookarounds or named groups; quantifiers only on single characters
// or classes, never on a group; at most MAX_QUANTIFIERS of them.
function patternProblem(source: string): string | undefined {
  if (source === '') return 'pattern must not be empty';
  if (source.length > MAX_PATTERN_LENGTH) return `pattern may have at most ${MAX_PATTERN_LENGTH} characters`;
  let quantifiers = 0;
  let afterGroup = false;
  for (let index = 0; index < source.length;) {
    const character = source[index];
    let quantifier = 0;
    if (character === '\\') {
      if (/[1-9k]/.test(source[index + 1] ?? '')) return 'pattern may not use backreferences';
      afterGroup = false;
      index += 2;
      continue;
    }
    if (character === '[') {
      index++;
      if (source[index] === '^') index++;
      while (index < source.length && source[index] !== ']') index += source[index] === '\\' ? 2 : 1;
      afterGroup = false;
      index++;
      continue;
    }
    if (character === '(') {
      if (source[index + 1] === '?' && !source.startsWith('(?:', index)) return 'pattern may use only plain groups ( ) and (?: ), not lookarounds or named groups';
      index += source.startsWith('(?:', index) ? 3 : 1;
      afterGroup = false;
      continue;
    }
    if (character === ')') {
      afterGroup = true;
      index++;
      continue;
    }
    if (character === '*' || character === '+' || character === '?') {
      quantifier = 1;
    } else if (character === '{') {
      const braces = /^\{\d+(?:,\d*)?\}/.exec(source.slice(index));
      if (braces) quantifier = braces[0].length;
    }
    if (quantifier) {
      if (afterGroup) return 'pattern may not put a quantifier on a group; apply it to a single character or class, or list the alternatives';
      if (++quantifiers > MAX_QUANTIFIERS) return `pattern may have at most ${MAX_QUANTIFIERS} quantifiers (* + ? {n,m})`;
      index += quantifier;
      continue;
    }
    afterGroup = false;
    index++;
  }
  let regex: RegExp;
  try {
    regex = anchored(source);
  } catch (error) {
    return `not a valid regular expression: ${(error as Error).message}`;
  }
  for (const [label, canary] of Object.entries(CANARIES)) {
    if (regex.test(canary)) return `pattern is too broad: it matches ${label}, so it would unmask credentials`;
  }
  return undefined;
}

const anchored = (source: string) => new RegExp(`^(?:${source})$`, 'i');
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compile(entries: Exemption[]): Exemptions {
  return {
    patterns: entries.filter((entry) => entry.kind === 'pattern').map((entry) => anchored(entry.value)),
    // "key": value, key: value and key=value, also inside an escaped JSON string.
    keys: entries.filter((entry) => entry.kind === 'key').map((entry) =>
      new RegExp(`(?:^|[^A-Za-z0-9_.-])\\\\?["']?${escapeRegExp(entry.value)}\\\\?["']?[ \\t]*[:=][ \\t]*\\\\?["']?$`)),
  };
}

export function readEntries(path: string): Exemption[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
  const list = (parsed as { exemptions?: unknown } | null)?.exemptions;
  if (!Array.isArray(list)) throw new Error('"exemptions" must be an array');
  list.forEach((entry, index) => {
    const problem = check(entry);
    if (problem) throw new Error(`exemptions[${index}]: ${problem}`);
  });
  return list as Exemption[];
}

// Replaces the file in one rename, so the gateway never reads a half-written list.
export function writeEntries(path: string, entries: Exemption[]): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ exemptions: entries }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

// Creates the file with the seed entries on first use. From then on the file is the source of truth.
export function ensureSeeded(path: string): void {
  if (!existsSync(path)) writeEntries(path, SEED);
  else chmodSync(path, 0o600);
}

export class ExemptionFile {
  readonly #path: string;
  readonly #log: (line: string) => void;
  #stamp = '';
  #current: Exemptions = compile([]);

  constructor(path: string, log: (line: string) => void) {
    this.#path = path;
    this.#log = log;
    ensureSeeded(path);
    this.current();
  }

  // The lists for the next request. Reloads when the file changed. An invalid file keeps the last valid
  // lists (none at startup, which masks the most) and logs the reason.
  current(): Exemptions {
    const info = statSync(this.#path, { throwIfNoEntry: false });
    const stamp = info ? `${info.mtimeMs}:${info.size}:${info.ino}` : 'missing';
    if (stamp === this.#stamp) return this.#current;
    this.#stamp = stamp;
    try {
      this.#current = compile(readEntries(this.#path));
      this.#log(`exemptions loaded: ${this.#current.patterns.length} patterns, ${this.#current.keys.length} keys`);
    } catch (error) {
      this.#log(`exemptions not loaded, keeping the previous lists: ${(error as Error).message}`);
    }
    return this.#current;
  }
}
