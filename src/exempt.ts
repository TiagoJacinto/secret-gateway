// CLI for the exemption lists. The running gateway reloads the file on its next request.
//   bun run exempt list
//   bun run exempt add prefix <text> [--note <text>]
//   bun run exempt add key <name> [--note <text>]
//   bun run exempt remove prefix|key <value>
import { loadConfig } from './config.ts';
import { check, ensureSeeded, exemptionsPath, readEntries, writeEntries, type Exemption } from './exemptions.ts';

const USAGE = `Usage:
  bun run exempt list
  bun run exempt add prefix <text> [--note <text>]
  bun run exempt add key <name> [--note <text>]
  bun run exempt remove prefix|key <value>
A prefix exempts identifiers that start with it. A key exempts the value after that key name.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [command, kind, value, ...rest] = process.argv.slice(2);
const path = exemptionsPath(loadConfig().dataDir);
ensureSeeded(path);
let entries: Exemption[];
try {
  entries = readEntries(path);
} catch (error) {
  fail((error as Error).message);
}

if (command === 'list') {
  for (const entry of entries) console.log(`${entry.kind}\t${entry.value}${entry.note ? `\t${entry.note}` : ''}`);
} else if (command === 'add' || command === 'remove') {
  if ((kind !== 'prefix' && kind !== 'key') || !value) fail(USAGE);
  const index = entries.findIndex((entry) => entry.kind === kind && entry.value === value);
  if (command === 'add') {
    const noteAt = rest.indexOf('--note');
    const note = noteAt === -1 ? undefined : rest[noteAt + 1];
    if (rest.length > 0 && (noteAt !== 0 || note === undefined || rest.length !== 2)) fail(USAGE);
    const entry: Exemption = note ? { kind, value, note } : { kind, value };
    const problem = check(entry);
    if (problem) fail(`refused: ${problem}`);
    if (index !== -1) {
      console.log(`already present: ${kind} ${value}`);
    } else {
      writeEntries(path, [...entries, entry]);
      console.log(`added ${kind} ${value}`);
    }
  } else if (index === -1) {
    fail(`not found: ${kind} ${value}`);
  } else {
    writeEntries(path, entries.filter((_, position) => position !== index));
    console.log(`removed ${kind} ${value}`);
  }
} else {
  fail(USAGE);
}
