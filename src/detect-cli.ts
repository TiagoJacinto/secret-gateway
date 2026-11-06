// CLI for the detection patterns: secret formats the gateway always masks. The running gateway reloads the
// file on its next request. The inverse of the exempt CLI.
//   bun run detect list
//   bun run detect add pattern <regex> --case sensitive|insensitive [--note <text>]
//   bun run detect remove pattern <regex>
import { loadConfig } from './config.ts';
import { check, detectionsPath, ensureSeeded, readEntries, writeEntries, type Detection } from './detections.ts';

const USAGE = `Usage:
  bun run detect list
  bun run detect add pattern <regex> --case sensitive|insensitive [--note <text>]
  bun run detect remove pattern <regex>
A pattern is a regular expression that matches the secret itself, such as 'acme_[a-z0-9]{32}'. Quote it.
--case sensitive matches only the capitalization the pattern spells out. --case insensitive matches any capitalization.
Every match is masked wherever it appears. A pattern must not match ordinary text.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Reads "--name value" pairs. Only --case and --note are allowed, each at most once.
function parseOptions(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let at = 0; at < args.length; at += 2) {
    const flag = args[at];
    const flagValue = args[at + 1];
    if ((flag !== '--case' && flag !== '--note') || flagValue === undefined || options.has(flag)) fail(USAGE);
    options.set(flag, flagValue);
  }
  return options;
}

const [command, kind, value, ...rest] = process.argv.slice(2);
const path = detectionsPath(loadConfig().dataDir);
ensureSeeded(path);
let entries: Detection[];
try {
  entries = readEntries(path);
} catch (error) {
  fail((error as Error).message);
}

const caseLabel = (entry: Detection) => (entry.caseSensitive ? 'sensitive' : 'insensitive');

if (command === 'list') {
  for (const entry of entries) {
    console.log(`${entry.kind}\t${entry.value}\t${caseLabel(entry)}${entry.note ? `\t${entry.note}` : ''}`);
  }
} else if (command === 'add' || command === 'remove') {
  if (kind !== 'pattern' || !value) fail(USAGE);
  const options = parseOptions(rest);
  const index = entries.findIndex((entry) => entry.kind === kind && entry.value === value);
  if (command === 'add') {
    const caseArg = options.get('--case');
    if (caseArg !== 'sensitive' && caseArg !== 'insensitive') fail(USAGE);
    const note = options.get('--note');
    const entry: Detection = {
      kind,
      value,
      caseSensitive: caseArg === 'sensitive',
      ...(note ? { note } : {}),
    };
    const problem = check(entry);
    if (problem) fail(`refused: ${problem}`);
    if (index !== -1) {
      if (entries[index].caseSensitive !== entry.caseSensitive) {
        fail(`already present as ${caseLabel(entries[index])}: remove it before adding it as ${caseLabel(entry)}`);
      }
      console.log(`already present: ${kind} ${value}`);
    } else {
      writeEntries(path, [...entries, entry]);
      console.log(`added ${kind} ${value} (${caseLabel(entry)})`);
    }
  } else if (options.size > 0) {
    fail(USAGE);
  } else if (index === -1) {
    fail(`not found: ${kind} ${value}`);
  } else {
    writeEntries(path, entries.filter((_, position) => position !== index));
    console.log(`removed ${kind} ${value}`);
  }
} else {
  fail(USAGE);
}
