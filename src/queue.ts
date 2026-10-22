// ---------------------------------------------------------------------------
// Background event delivery
// ---------------------------------------------------------------------------

/** Events waiting to be sent, not counting those in flight. Beyond it the oldest is dropped. */
export const MAX_QUEUED_EVENTS = 1000;
/** Events sent at once. Bounds the sockets the queue opens to SignalVault. */
const MAX_IN_FLIGHT = 16;
/** Attempts per event, the first included. */
export const MAX_ATTEMPTS = 6;
/**
 * Backoff before the second attempt; it doubles each time, up to
 * MAX_RETRY_DELAY_MS: 4s, 8s, 16s, 32s, 60s, about two minutes in all.
 */
const BASE_BACKOFF_MS = 4000;
/** Longest wait between attempts, whether from the backoff or a Retry-After. */
export const MAX_RETRY_DELAY_MS = 60_000;

export interface PostResult {
  ok: boolean;
  status: number;
  response?: Response;
}

/**
 * - `delivered`: the server accepted the event (2xx).
 * - `rejected`: the server refused it (3xx, or 4xx other than 429); not retried.
 * - `retrying`: only from `firstAttempt`: it failed and is queued for a retry.
 * - `dropped`: lost: the queue overflowed, the attempts ran out, or the
 *   process was exiting and the exit flush reached its deadline.
 */
export type DeliveryState = 'delivered' | 'rejected' | 'retrying' | 'dropped';
export type DropReason = 'overflow' | 'attempts' | 'exit';

/** One dropped event, as handed to QueueHooks.dropped. */
export interface DroppedEntry {
  body: Record<string, unknown>;
  /** Events lost with it, itself included (see EventQueue.add()). */
  lost: number;
  lastStatus: number | null;
}

export interface Delivery {
  state: DeliveryState;
  /** Last HTTP status received; null if no response was received. */
  status: number | null;
  reason?: DropReason;
}

export interface QueuedDelivery {
  /** Settles after the first attempt (or the drop, if it never got one). */
  firstAttempt: Promise<Delivery>;
  /** Settles once the event is delivered, rejected or dropped. */
  done: Promise<Delivery>;
}

export interface QueueHooks {
  /** Sends one event. Rejects on network errors and timeouts. */
  send(body: Record<string, unknown>): Promise<PostResult>;
  /** Called whenever events are lost, with every one of them. */
  dropped(reason: DropReason, entries: DroppedEntry[]): void;
  /** Called when the queue goes from empty to not empty (true) and back (false). */
  busy(busy: boolean): void;
  /** Debug output; only printed with `debug: true`. */
  debug(message: string, detail: unknown): void;
}

interface Entry {
  /** Enqueue order: retries keep their place, so "oldest" means first queued. */
  seq: number;
  body: Record<string, unknown>;
  /** Events lost if this one is dropped: itself and those that wait for it. */
  lost: number;
  attempts: number;
  readyAt: number;
  lastStatus: number | null;
  /** Set by abandon() on events in flight: their attempt is the last. */
  noRetry: boolean;
  first?: (delivery: Delivery) => void;
  done: (delivery: Delivery) => void;
}

/** Seconds or an HTTP date; null if absent or unreadable. */
export function parseRetryAfterMs(response?: Response): number | null {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * Bounded in-memory queue for audit events. Each event is retried on network
 * errors, timeouts, 5xx and 429, with exponential backoff or the server's
 * Retry-After, for up to MAX_ATTEMPTS attempts. Retrying is safe because the
 * caller gives each event an idempotency key (`event_id`, or `request_id` for
 * the fallback ai.request). Its one timer is unref'd, so a waiting retry never
 * keeps the process alive; flush() is how a caller waits for it.
 */
export class EventQueue {
  /** Events not in flight, oldest first. */
  private readonly waiting: Entry[] = [];
  private readonly sending = new Set<Entry>();
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Infinity;
  /** Shared by every whenIdle() caller until the queue is next idle. */
  private idle: { promise: Promise<void>; resolve: () => void } | null = null;
  private busy = false;

  constructor(private readonly hooks: QueueHooks) {}

  /** Events waiting or in flight. */
  get size(): number {
    return this.waiting.length + this.sending.size;
  }

  /**
   * Queues an event. Its first attempt starts at once when fewer than
   * MAX_IN_FLIGHT are sending. `lost`: the events that are lost if this one is
   * dropped, counting itself, e.g. 2 for an ai.request whose ai.response waits
   * for it and is not sent without it.
   */
  add(body: Record<string, unknown>, lost = 1): QueuedDelivery {
    let first!: (delivery: Delivery) => void;
    let done!: (delivery: Delivery) => void;
    const firstAttempt = new Promise<Delivery>((resolve) => (first = resolve));
    const settled = new Promise<Delivery>((resolve) => (done = resolve));
    this.insert({ seq: this.seq++, body, lost, attempts: 0, readyAt: 0, lastStatus: null, noRetry: false, first, done });
    if (!this.busy) {
      this.busy = true;
      this.hooks.busy(true);
    }
    this.pump();
    return { firstAttempt, done: settled };
  }

  /** Makes every waiting event due now, so flush() does not wait out a backoff. */
  expedite(): void {
    for (const entry of this.waiting) entry.readyAt = 0;
    this.pump();
  }

  /** Bodies of the events waiting or in flight, oldest first. */
  pendingBodies(): Array<Record<string, unknown>> {
    return [...this.sending, ...this.waiting].sort((a, b) => a.seq - b.seq).map((e) => e.body);
  }

  /**
   * Drops every waiting event and stops retrying the ones in flight: their
   * current attempt is their last. Only for a process that is exiting.
   */
  abandon(reason: DropReason): void {
    const dropped = this.waiting.splice(0);
    this.clearTimer();
    for (const entry of this.sending) entry.noRetry = true;
    for (const entry of dropped) this.settle(entry, { state: 'dropped', status: entry.lastStatus, reason });
    if (dropped.length) this.hooks.dropped(reason, dropped.map(toDropped));
    this.notifyIfIdle();
  }

  /** Resolves when nothing is waiting or in flight. */
  whenIdle(): Promise<void> {
    if (this.size === 0) return Promise.resolve();
    if (!this.idle) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      this.idle = { promise, resolve };
    }
    return this.idle.promise;
  }

  /** Inserts in enqueue order, then drops the oldest while over the cap. */
  private insert(entry: Entry): void {
    let i = this.waiting.length;
    while (i > 0 && this.waiting[i - 1].seq > entry.seq) i--;
    this.waiting.splice(i, 0, entry);
    while (this.waiting.length > MAX_QUEUED_EVENTS) {
      const oldest = this.waiting.shift()!;
      this.settle(oldest, { state: 'dropped', status: oldest.lastStatus, reason: 'overflow' });
      this.hooks.dropped('overflow', [toDropped(oldest)]);
    }
  }

  /** Starts every due event there is room for, and sets the timer for the next one. */
  private pump(): void {
    const now = Date.now();
    let next = Infinity;
    for (let i = 0; i < this.waiting.length && this.sending.size < MAX_IN_FLIGHT; ) {
      const entry = this.waiting[i];
      if (entry.readyAt <= now) {
        this.waiting.splice(i, 1);
        void this.attempt(entry);
      } else {
        next = Math.min(next, entry.readyAt);
        i++;
      }
    }
    // Events left unscanned because MAX_IN_FLIGHT was reached are started
    // when a send finishes, which pumps again.
    if (this.waiting.length === 0) {
      this.clearTimer();
    } else if (next < this.timerAt) {
      this.clearTimer();
      this.timerAt = next;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.timerAt = Infinity;
        this.pump();
      }, Math.max(0, next - now));
      this.timer.unref?.();
    }
    this.notifyIfIdle();
  }

  private async attempt(entry: Entry): Promise<void> {
    this.sending.add(entry);
    entry.attempts++;
    let ok = false;
    let retryable = false;
    let retryAfterMs: number | null = null;
    try {
      const result = await this.hooks.send(entry.body);
      entry.lastStatus = result.status;
      ok = result.ok;
      if (!ok && (result.status === 429 || result.status >= 500)) {
        retryable = true;
        retryAfterMs = parseRetryAfterMs(result.response);
      }
    } catch (error) {
      // Network error or timeout. A timed-out event may have been stored;
      // its idempotency key makes the retry harmless.
      this.hooks.debug('Event send failed:', error);
      entry.lastStatus = null;
      retryable = true;
    } finally {
      this.sending.delete(entry);
    }

    const status = entry.lastStatus;
    if (ok) {
      this.settle(entry, { state: 'delivered', status });
    } else if (!retryable) {
      this.hooks.debug('Event not delivered:', status);
      this.settle(entry, { state: 'rejected', status });
    } else if (entry.noRetry || entry.attempts >= MAX_ATTEMPTS) {
      const reason: DropReason = entry.noRetry ? 'exit' : 'attempts';
      this.settle(entry, { state: 'dropped', status, reason });
      this.hooks.dropped(reason, [toDropped(entry)]);
    } else {
      entry.readyAt = Date.now() + retryDelayMs(entry.attempts, retryAfterMs);
      entry.first?.({ state: 'retrying', status });
      entry.first = undefined;
      this.insert(entry);
    }
    this.pump();
  }

  private settle(entry: Entry, delivery: Delivery): void {
    entry.first?.(delivery);
    entry.first = undefined;
    entry.done(delivery);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }

  private notifyIfIdle(): void {
    if (this.size > 0) return;
    if (this.busy) {
      this.busy = false;
      this.hooks.busy(false);
    }
    if (!this.idle) return;
    this.idle.resolve();
    this.idle = null;
  }
}

function toDropped(entry: Entry): DroppedEntry {
  return { body: entry.body, lost: entry.lost, lastStatus: entry.lastStatus };
}

/**
 * Wait before the attempt after `attempts`: the server's Retry-After if it
 * sent one, otherwise the backoff with up to 25% jitter taken off, so a burst
 * of failures does not retry in lockstep. Capped at MAX_RETRY_DELAY_MS.
 */
function retryDelayMs(attempts: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS);
  const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_RETRY_DELAY_MS);
  return backoff * (0.75 + Math.random() * 0.25);
}
