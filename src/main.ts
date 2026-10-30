// Composition root: wires configuration, identity, answers store, scanner, masking core, review
// surface and notifications, then starts the HTTP boundary.
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

const config = loadConfig();
const key = loadIdentityKey(config.dataDir);
const store = new AnswerStore(join(config.dataDir, 'answers.sqlite'));
const clock = config.manualClock ? new ManualClock() : new SystemClock();
const now = () => new Date(clock.now()).toISOString();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const scanner = new ExternalScanner(providerScanner(config.scannerBinary));
const review = new ReviewSurface({ store, now, port: config.port });
const notifier = new ReviewNotifier({
  notifier: config.notifyRecordPath ? new RecordingNotifier(config.notifyRecordPath) : new NotifySendNotifier(),
  clock,
  reviewUrl: review.url,
  onAction: (id, action) => review.answer(id, action),
});
const masker = new Masker({
  key,
  store,
  scanner,
  now,
  onPending: (item) => notifier.enqueue(item),
  collectSlots,
});

const handler = createHandler({
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
