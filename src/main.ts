// Composition root: wires configuration, identity, answers store, value store, scanner, masking core,
// review surface and notifications, then starts the HTTP boundary.
import { appendFileSync, chmodSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { loadIdentityKey, loadReviewToken } from './identity.ts';
import { AnswerStore } from './store.ts';
import { ExemptionFile, exemptionsPath } from './exemptions.ts';
import { ExternalScanner, providerScanner } from './scanner.ts';
import { Masker } from './masker.ts';
import { ReviewSurface } from './review.ts';
import { ManualClock, NotifySendNotifier, RecordingNotifier, ReviewNotifier, SystemClock } from './notify.ts';
import { createHandler } from './gateway.ts';
import { collectSlots } from './anthropic.ts';
import { collectResponseSlots } from './responses.ts';
import { LAST_LINE_FLUSH_MS, SecretVault } from './vault.ts';
import { ValueStore } from './values.ts';

const config = loadConfig();
const key = loadIdentityKey(config.dataDir);
const reviewToken = loadReviewToken(config.dataDir);
const store = new AnswerStore(join(config.dataDir, 'answers.sqlite'));
const values = new ValueStore(join(config.dataDir, 'values.sqlite'));
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
const exemptions = new ExemptionFile(exemptionsPath(config.dataDir), log);
const vault = new SecretVault({ store: values, onError: (name) => log(`value store not written: ${name}`) });
const review = new ReviewSurface({
  store,
  vault,
  now,
  port: config.port,
  token: reviewToken,
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
  exemptions: () => exemptions.current(),
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

// Last lines reach values.sqlite every few seconds, and again at shutdown.
const flushTimer = setInterval(() => vault.flush(), LAST_LINE_FLUSH_MS);
let stopping = false;
const shutdown = () => {
  // A repeated signal, such as one sent to the whole process group, is ignored while the flush runs.
  // The listener stays installed, so a second signal cannot end the process before the write commits.
  if (stopping) return;
  stopping = true;
  clearInterval(flushTimer);
  vault.flush();
  values.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
