// Exemption lists: identifiers and keys whose values are routing data, not credentials. They live in
// exemptions.json in the data directory, so editing the file (or `bun run exempt`) applies to the next
// request without a restart. Entries are prefixes and key names only, never secret values, so the
// file holds nothing the disk-non-disclosure rule protects. An exemption only lowers masking, so an
// entry that could cover a credential is refused.
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ID_CHAR, NAME_KEYWORD } from './detect.ts';

export type Exemption = { kind: 'prefix' | 'key'; value: string; note?: string };
// The compiled form: lowercase prefixes, and one pattern per key that matches the text before a value.
export type Exemptions = { prefixes: string[]; keys: RegExp[] };

const MIN_PREFIX_LENGTH = 6;
const KEY_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;

// T3 Code routing data: the IDs and links agents pass back to T3 tools.
export const SEED: Exemption[] = [
  ...['mcp:launch:', 'mcp%3Alaunch%3A', 'scheduled-task:', 'run:thread:', 'message:mcp:', 'message:provider:',
    'turn-item:', 'delegated-task:', 'thread:delegated-task:', 't3-thread://', 't3-citation://']
    .map((value): Exemption => ({ kind: 'prefix', value, note: 'T3 Code identifier' })),
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
  if (kind === 'prefix') {
    if (value.length < MIN_PREFIX_LENGTH) return `prefix must have at least ${MIN_PREFIX_LENGTH} characters, so it names one kind of identifier`;
    if (![...value].every((character) => ID_CHAR.test(character))) return 'prefix may only hold letters, digits and : % / . _ ~ -';
    return undefined;
  }
  if (kind === 'key') {
    if (!KEY_NAME.test(value)) return 'key must be a name of letters, digits, _ . -, starting with a letter';
    if (NAME_KEYWORD.test(value)) return 'key looks like a credential name (KEY, TOKEN, SECRET, PASSWORD, PASS, AUTH, CREDENTIAL, DATABASE_URL), so its value stays masked';
    return undefined;
  }
  return 'kind must be "prefix" or "key"';
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compile(entries: Exemption[]): Exemptions {
  return {
    prefixes: entries.filter((entry) => entry.kind === 'prefix').map((entry) => entry.value.toLowerCase()),
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
      this.#log(`exemptions loaded: ${this.#current.prefixes.length} prefixes, ${this.#current.keys.length} keys`);
    } catch (error) {
      this.#log(`exemptions not loaded, keeping the previous lists: ${(error as Error).message}`);
    }
    return this.#current;
  }
}
