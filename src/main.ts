// Composition root: wires configuration, identity, answers store, scanner, masking core, review
// surface and notifications, then starts the HTTP boundary.
import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { loadIdentityKey } from './identity.ts';
import { AnswerStore } from './store.ts';
import { ExternalScanner, providerScanner } from './scanner.ts';
import { Masker } from './masker.ts';
import { ReviewSurface } from './review.ts';
import { ManualClock, NotifySendNotifier, RecordingNotifier, ReviewNotifier, SystemClock } from './notify.ts';
import { createHandler } from './gateway.ts';
import { collectSlots } from './anthropic.ts';
import { collectResponseSlots } from './responses.ts';
import { SecretVault } from './vault.ts';

const config = loadConfig();
const key = loadIdentityKey(config.dataDir);
const store = new AnswerStore(join(config.dataDir, 'answers.sqlite'));
const clock = config.manualClock ? new ManualClock() : new SystemClock();
const now = () => new Date(clock.now()).toISOString();
// Each line goes to stdout and is appended to gateway.log in the data directory. Lines carry counts and
// identity prefixes, never values or message text.
const logPath = join(config.dataDir, 'gateway.log');
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
if (existsSync(logPath)) chmodSync(logPath, 0o600);
const log = (line: string) => {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  try {
    // A file over 10 MB becomes gateway.log.1, replacing the previous one, before this line is written.
    if (existsSync(logPath) && statSync(logPath).size > LOG_ROTATE_BYTES) renameSync(logPath, `${logPath}.1`);
    appendFileSync(logPath, `${text}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`gateway.log not written: ${(error as Error).name}`);
  }
};

const scanner = new ExternalScanner(providerScanner(config.scannerBinary));
const vault = new SecretVault();
const review = new ReviewSurface({
  store,
  vault,
  now,
  port: config.port,
  onAnswer: (id, status) => {
    log(`review answer ${id.slice(0, 8)} ${status}`);
    masker.recordAnswer(id, status);
  },
});
const notifier = new ReviewNotifier({
  notifier: config.notifyRecordPath ? new RecordingNotifier(config.notifyRecordPath) : new NotifySendNotifier(),
  clock,
  reviewUrl: review.url,
  onAction: (id, action) => review.answer(id, action),
});
const masker = new Masker({
  key,
  store,
  vault,
  scanner,
  revealUrl: (identity) => review.revealUrl(identity),
  now,
  onPending: (item) => {
    log(`pending ${item.id.slice(0, 8)} from ${item.source} (length ${item.length})`);
    notifier.enqueue(item);
  },
  collectSlots: config.protocol === 'responses' ? collectResponseSlots : collectSlots,
});

const handler = createHandler({
  protocol: config.protocol,
  masker,
  review,
  upstreamBaseUrl: config.upstreamBaseUrl,
  log,
  testControl: config.testControl && clock instanceof ManualClock ? (ms) => clock.advance(ms) : undefined,
});

const server = Bun.serve({ hostname: config.host, port: config.port, fetch: handler, idleTimeout: 255 });
log(`secret-gateway listening on http://${config.host}:${server.port}`);
log(`review page: ${review.url}`);
log(`upstream: ${config.upstreamBaseUrl}`);
