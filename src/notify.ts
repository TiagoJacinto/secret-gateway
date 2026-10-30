// Review notifications: batched, rate-limited, and actionable. Notifications carry the source and
// length of an item, never its value. The clock is injectable so tests control time.
import { appendFileSync } from 'node:fs';

export type ReviewAction = 'secret' | 'not_secret';
export type Notification = { title: string; body: string; actions: { id: ReviewAction; label: string }[] };
export interface Notifier {
  send(notification: Notification, onAction: (action: ReviewAction) => void): void;
}
export interface Clock {
  now(): number;
  setTimer(ms: number, run: () => void): void;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  setTimer(ms: number, run: () => void): void {
    setTimeout(run, ms);
  }
}

// Test clock: time moves only when advance() is called, and due timers run inside advance().
export class ManualClock implements Clock {
  #time = 0;
  #timers: { due: number; run: () => void }[] = [];

  now(): number {
    return this.#time;
  }
  setTimer(ms: number, run: () => void): void {
    this.#timers.push({ due: this.#time + ms, run });
  }
  advance(ms: number): void {
    const target = this.#time + ms;
    for (;;) {
      const due = this.#timers.filter((timer) => timer.due <= target).sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      this.#timers.splice(this.#timers.indexOf(due), 1);
      this.#time = due.due;
      due.run();
    }
    this.#time = target;
  }
}

// Desktop notifications through notify-send. Clicking a button prints its action id, which is then
// applied to the item. When the daemon rejects actions, the notification is sent again without buttons,
// and the review page stays the way to answer. Failures never block the request path.
export class NotifySendNotifier implements Notifier {
  send(notification: Notification, onAction: (action: ReviewAction) => void): void {
    void (async () => {
      if (notification.actions.length > 0) {
        const chosen = await this.#run(
          ['--wait', ...notification.actions.map((action) => `--action=${action.id}=${action.label}`)],
          notification,
          true,
        );
        if (chosen !== undefined) {
          if (chosen === 'secret' || chosen === 'not_secret') onAction(chosen);
          return;
        }
      }
      await this.#run([], notification, false);
    })();
  }

  // Returns the chosen action (possibly empty), or undefined when notify-send failed.
  async #run(options: string[], notification: Notification, capture: boolean): Promise<string | undefined> {
    const args = ['notify-send', '--app-name=secret-gateway', ...options, notification.title, notification.body];
    try {
      const process = Bun.spawn(args, { stdout: capture ? 'pipe' : 'ignore', stderr: 'ignore' });
      const output = capture ? (await new Response(process.stdout).text()).trim() : '';
      const exitCode = await process.exited;
      return exitCode === 0 ? output : undefined;
    } catch {
      return undefined;
    }
  }
}

// Writes each notification as one JSON line, so tests can inspect what would have been shown.
export class RecordingNotifier implements Notifier {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  send(notification: Notification): void {
    appendFileSync(this.#path, `${JSON.stringify(notification)}\n`);
  }
}

export type PendingReview = { id: string; source: string; length: number };
type Options = {
  notifier: Notifier;
  clock: Clock;
  reviewUrl: string;
  onAction: (id: string, action: ReviewAction) => void;
  batchMs?: number;
  maxPerMinute?: number;
};

export class ReviewNotifier {
  readonly #options: Options;
  readonly #batchMs: number;
  readonly #maxPerMinute: number;
  readonly #queue: PendingReview[] = [];
  readonly #sent: number[] = [];
  #scheduled = false;

  constructor(options: Options) {
    this.#options = options;
    this.#batchMs = options.batchMs ?? 10_000;
    this.#maxPerMinute = options.maxPerMinute ?? 3;
  }

  enqueue(item: PendingReview): void {
    this.#queue.push(item);
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#options.clock.setTimer(this.#batchMs, () => this.#flush());
  }

  // Degraded-screen alert: not per item, and not batched.
  alert(title: string, body: string): void {
    this.#options.notifier.send({ title, body, actions: [] }, () => undefined);
  }

  #flush(): void {
    this.#scheduled = false;
    const now = this.#options.clock.now();
    while (this.#sent.length > 0 && now - this.#sent[0] >= 60_000) this.#sent.shift();
    const budget = this.#maxPerMinute - this.#sent.length;
    const batch = this.#queue.splice(0);
    const individual = batch.slice(0, Math.max(0, budget));
    const overflow = batch.slice(individual.length);

    for (const item of individual) {
      this.#sent.push(now);
      this.#options.notifier.send(
        {
          title: 'Secret review: new detection',
          body: `Source: ${item.source}. Length: ${item.length} characters. Review at ${this.#options.reviewUrl}`,
          actions: [
            { id: 'secret', label: 'Secret' },
            { id: 'not_secret', label: 'Not a secret' },
          ],
        },
        (action) => this.#options.onAction(item.id, action),
      );
    }
    if (overflow.length > 0) {
      this.#options.notifier.send(
        {
          title: 'Secret review: items waiting',
          body: `${overflow.length} more items await review at ${this.#options.reviewUrl}`,
          actions: [],
        },
        () => undefined,
      );
    }
  }
}
