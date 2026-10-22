import { randomUUID } from 'crypto';
import type OpenAI from 'openai';
import {
  ToolRecordOptions,
  ToolsAPI,
  runWithContext,
  sanitizeError,
  sanitizePayload,
  validateToolName,
  wrapTool,
} from './tools';
import {
  DropReason,
  DroppedEntry,
  EventQueue,
  MAX_ATTEMPTS,
  MAX_QUEUED_EVENTS,
  PostResult,
  QueuedDelivery,
} from './queue';

export type { ToolRecordOptions, ToolsAPI } from './tools';

/** Kept in sync with package.json by a unit test. */
export const SDK_VERSION = '0.5.2';

const DEFAULT_BASE_URL = 'https://api.signalvault.io';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** A repeated warning is printed at most once per this window. */
const WARN_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Environment guard
// ---------------------------------------------------------------------------

/**
 * Hard-fails if the SDK is loaded in a browser context. The SDK relies on
 * `async_hooks` (Node-only) and is intended for server-side use; bundling it
 * for the browser would expose `apiKey`, `openaiApiKey`, and `anthropicApiKey`
 * to end users — which is exactly the kind of leak this product is meant to
 * prevent.
 */
function assertNodeEnvironment(): void {
  // `process` exists on Node and not in plain browsers. `window` is the
  // canonical browser global. We refuse to run if we look browser-like.
  const hasProcess = typeof process !== 'undefined' && process?.versions?.node;
  const hasWindow = typeof (globalThis as { window?: unknown }).window !== 'undefined';
  if (!hasProcess || hasWindow) {
    throw new Error(
      '[SignalVault] This SDK is server-side only. Do not bundle it for browser use — ' +
        'it will leak your API keys to end users. Call SignalVault from your backend instead.'
    );
  }
}

/**
 * Normalizes the base URL and refuses plaintext HTTP to anything but the local
 * machine. The API key and full prompts travel in every request, so an
 * `http://` URL would expose both before the server could redirect to HTTPS.
 */
export function normalizeBaseUrl(raw: string): string {
  // Errors never quote `raw`: it may contain credentials.
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('[SignalVault] baseUrl is not a valid URL.');
  }
  if (url.username || url.password) {
    throw new Error(
      '[SignalVault] baseUrl must not contain credentials (user:password@). Pass the key as apiKey.'
    );
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      '[SignalVault] baseUrl must use https:// (plain http:// is only allowed for localhost). ' +
        'Your API key and prompts would otherwise be sent unencrypted.'
    );
  }
  if (url.search || url.hash) {
    throw new Error('[SignalVault] baseUrl must not contain a query or fragment.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`[SignalVault] baseUrl must be an https:// URL, got ${url.protocol}`);
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Strips surrounding whitespace and refuses keys that can't go in a header.
 * A key read from a file or a secret often ends in a newline. Sent as is,
 * every request fails before it leaves the process, so with failMode 'open'
 * every call would go through unchecked. Errors never include the key.
 */
function normalizeApiKey(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new TypeError(`[SignalVault] apiKey must be a string, got ${raw === null ? 'null' : typeof raw}.`);
  }
  const key = raw.trim();
  if (!key) {
    throw new Error('[SignalVault] apiKey is empty.');
  }
  if (/[^\x21-\x7e]/.test(key)) {
    throw new Error(
      '[SignalVault] apiKey contains whitespace, control or non-ASCII characters. Check how the key is loaded.'
    );
  }
  return key;
}

/**
 * One line describing an error and its causes, for debug output. Never
 * includes `secret`, and never throws.
 */
function describeError(error: unknown, secret: string): string {
  const parts: string[] = [];
  let current: any = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    try {
      parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
      current = current instanceof Error ? (current as any).cause : undefined;
    } catch {
      parts.push('<unprintable error>');
      break;
    }
  }
  return parts.join(' <- ').split(secret).join('[redacted]');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What to do when SignalVault cannot return a guardrail decision (unreachable,
 * timed out, rate limited, invalid key, inactive subscription, ...).
 *
 * - `'open'` (default): allow the request and print a warning.
 * - `'closed'`: throw {@link SignalVaultUnavailableError} instead of calling
 *   the provider unchecked.
 */
export type FailMode = 'open' | 'closed';

export interface SignalVaultConfig {
  apiKey: string;
  /** Required for OpenAI (chat.completions). */
  openaiApiKey?: string;
  /** Required for Anthropic (messages). Install @anthropic-ai/sdk separately. */
  anthropicApiKey?: string;
  /** Default: https://api.signalvault.io. Plain http:// is only accepted for localhost. */
  baseUrl?: string;
  /**
   * Sent with every event for backwards compatibility. The server takes the
   * environment from the API key, so this value does not select rules.
   */
  environment?: 'development' | 'staging' | 'production';
  debug?: boolean;
  mirrorMode?: boolean;
  /** Behaviour when no guardrail decision can be obtained. Default: 'open'. */
  failMode?: FailMode;
  /**
   * Timeout (ms) for the pre-flight /v1/events call in normal mode.
   * This is in the critical path. Default: 2000
   */
  preflightTimeout?: number;
  /**
   * Timeout (ms) for each attempt to send a background / post-flight event.
   * Default: 10000
   */
  timeout?: number;
  /**
   * When the process is about to exit on its own (Node's `beforeExit`: the
   * event loop has run dry), wait up to this long (ms) for queued audit
   * events to be delivered. 0 disables it. `beforeExit` does not fire on
   * `process.exit()`, on signals or when a serverless platform freezes the
   * process: call flush() yourself there. Default: 10000
   */
  exitFlushTimeout?: number;
  /**
   * Default metadata attached to every event. Can be overridden per-call.
   * Use for user_id, feature, workspace_id, etc.
   */
  metadata?: Record<string, unknown>;
}

/** Audit events the SDK dropped, by cause, since the client was created. See `droppedEvents`. */
export interface DroppedEvents {
  /** Dropped because 1,000 events were already waiting to be sent (oldest first). */
  queueFull: number;
  /** Dropped after the last of 6 delivery attempts failed. */
  retriesExhausted: number;
  /** Still undelivered when the exit flush (`exitFlushTimeout`) reached its deadline. */
  exit: number;
}

const DROP_COUNTERS: Record<DropReason, keyof DroppedEvents> = {
  overflow: 'queueFull',
  attempts: 'retriesExhausted',
  exit: 'exit',
};

export interface SignalVaultViolation {
  rule_id?: string;
  type: string;
  severity: number;
  action: string;
  details: Record<string, unknown>;
}

export interface SignalVaultDecision {
  decision: 'allow' | 'warn' | 'block' | 'redact';
  violations: SignalVaultViolation[];
  /**
   * Rule types whose redact action matched, with match counts. Redaction
   * applies to what SignalVault stores; the request sent to the provider is
   * not modified. Check `.length`, never truthiness.
   */
  redactions: Array<{ type: string; count: number }>;
  /** Present on block decisions. */
  dashboard_url?: string;
}

export interface CreateOptions {
  /** Per-call metadata, merged over config-level metadata. */
  metadata?: Record<string, unknown>;
}

/** Thrown when a guardrail rule blocks the request. */
export class SignalVaultBlockedError extends Error {
  readonly requestId: string;
  readonly violations: SignalVaultViolation[];
  readonly dashboardUrl?: string;

  constructor(requestId: string, violations: SignalVaultViolation[], dashboardUrl?: string) {
    const types = [...new Set(violations.map((v) => String(v?.type ?? '')).filter(Boolean))].join(', ') || 'policy';
    super(`[SignalVault] Request blocked by guardrails (${types}).`);
    this.name = 'SignalVaultBlockedError';
    this.requestId = requestId;
    this.violations = violations;
    this.dashboardUrl = dashboardUrl;
  }
}

/** Thrown in `failMode: 'closed'` when no guardrail decision could be obtained. */
export class SignalVaultUnavailableError extends Error {
  readonly requestId: string;
  readonly status?: number;

  constructor(requestId: string, reason: string, status?: number) {
    super(`[SignalVault] Guardrail check unavailable: ${reason}. Request not sent (failMode: 'closed').`);
    this.name = 'SignalVaultUnavailableError';
    this.requestId = requestId;
    this.status = status;
  }
}

const ALLOW: SignalVaultDecision = { decision: 'allow', violations: [], redactions: [] };
/**
 * Set on the decision returned when no pre-flight decision was obtained.
 * 'record': the server may not have stored the request (network, timeout,
 * 5xx, invalid response), so it is recorded in the background and the
 * unchecked call still appears in the audit log. 'recorded': the server was
 * over the app's rule-check rate limit and stored the request unchecked
 * (429 with `recorded: true`), so the response is sent as usual. 'skip': the
 * server refused it (401/402/403/other 429/3xx), so a response event would be
 * refused too.
 */
const PREFLIGHT_FAILED = Symbol('preflightFailed');
/** Causes where re-sending the ai.request later can succeed. */
const RECORDABLE_CAUSES = new Set(['timeout', 'network', '5xx', 'invalid-response']);
const DECISIONS = new Set(['allow', 'warn', 'block', 'redact']);

/**
 * How a dropped or undelivered event is named in a warning. The fallback
 * ai.request has no event_id, so it is named by its request_id. `lost` above
 * 1: an ai.response was waiting for this request and is not sent.
 */
function describeEvent(body: Record<string, unknown>, lost: number): string {
  const name =
    typeof body.event_id === 'string'
      ? `event_id ${body.event_id}`
      : `request_id ${String(body.request_id)} (fallback ai.request, which has no event_id)`;
  return lost > 1 ? `${name} and its ai.response, not sent` : name;
}

/**
 * Checks the name rather than `instanceof Error`: fetch rejects with a
 * DOMException, which fails `instanceof` across realms (e.g. under Jest).
 */
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

/**
 * Anthropic takes the system prompt as a top-level `system` param. The
 * server scans `payload.messages`, so it is included there as a system
 * message — otherwise secrets or PII in the system prompt go unchecked.
 */
function anthropicMessagesForAudit(params: any): unknown[] {
  const messages = Array.isArray(params?.messages) ? params.messages : [];
  if (params?.system === undefined || params?.system === null || params?.system === '') {
    return messages;
  }
  return [{ role: 'system', content: params.system }, ...messages];
}

/** Concatenates every text block; `content[0]` alone misses text after a tool_use block. */
function anthropicOutputText(response: any): string {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  return blocks
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('');
}

const ANTHROPIC_USAGE_KEYS = [
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'output_tokens',
] as const;

/** `usage.cache_creation`: the cache writes by cache lifetime, priced differently. */
const CACHE_CREATION_KEYS = ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'] as const;

type UsageCounts = Record<string, number>;
type Usage = Record<string, number | UsageCounts>;

function copyCounts(target: UsageCounts, source: any, keys: readonly string[]): UsageCounts {
  for (const key of keys) {
    const n = source?.[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) target[key] = n;
  }
  return target;
}

/**
 * Anthropic usage under Anthropic's own names, as the proxy records it. The
 * server adds the cache counts to `input_tokens`; renamed to `prompt_tokens`,
 * which for OpenAI already includes cached tokens, they would be lost. Later
 * sources override earlier ones, but only with a count.
 */
function anthropicUsage(...sources: any[]): Usage {
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let cacheCreation: UsageCounts = {};
  for (const source of sources) {
    copyCounts(usage as UsageCounts, source, ANTHROPIC_USAGE_KEYS);
    cacheCreation = copyCounts(cacheCreation, source?.cache_creation, CACHE_CREATION_KEYS);
  }
  if (Object.keys(cacheCreation).length) usage.cache_creation = cacheCreation;
  return usage;
}

/**
 * The provider SDKs are optional peers, loaded only when their API key is
 * configured, so installing just the one you use is enough. The requires are
 * literal strings inside try blocks on purpose: bundlers can only follow a
 * literal require, and treat one inside a try as optional.
 */
function loadOpenAI(apiKey: string): any {
  let mod: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('openai');
  } catch (error) {
    throw notInstalled(error, 'openai');
  }
  return construct(mod, apiKey);
}

function loadAnthropic(apiKey: string): any {
  let mod: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('@anthropic-ai/sdk');
  } catch (error) {
    throw notInstalled(error, '@anthropic-ai/sdk');
  }
  return construct(mod, apiKey);
}

function construct(mod: any, apiKey: string): any {
  const Client = mod.default ?? mod;
  return new Client({ apiKey });
}

/**
 * Only a missing package is reported as "not installed"; anything else (a
 * broken install, a missing transitive dependency) is returned unchanged.
 */
function notInstalled(error: unknown, pkg: string): unknown {
  // Read fields directly: `instanceof Error` fails across realms (e.g. under Jest).
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code === 'MODULE_NOT_FOUND' && String(message).includes(`'${pkg}'`)) {
    return new Error(`[SignalVault] ${pkg} is not installed. Run: npm install ${pkg}`);
  }
  return error;
}

/**
 * Asks OpenAI to report token usage on a stream, unless the caller already
 * decided either way. OpenAI then sends one extra final chunk with an empty
 * `choices` array; `injected` tells the stream wrapper to consume that chunk
 * instead of passing it to a caller who never asked for it.
 *
 * `stream_options: null` opts out entirely: the key is removed, for
 * OpenAI-compatible servers that reject `stream_options`. (The OpenAI API
 * treats null and absent the same.)
 */
function withStreamUsage(
  params: OpenAI.Chat.ChatCompletionCreateParams
): { params: OpenAI.Chat.ChatCompletionCreateParams; injected: boolean } {
  if (!params.stream) return { params, injected: false };
  const options = (params as { stream_options?: { include_usage?: boolean } | null }).stream_options;
  if (options === null) {
    const { stream_options: _omitted, ...rest } = params as typeof params & { stream_options?: unknown };
    return { params: rest as typeof params, injected: false };
  }
  if (options && options.include_usage !== undefined) {
    return { params, injected: false };
  }
  return {
    params: { ...params, stream_options: { ...(options ?? {}), include_usage: true } } as typeof params,
    injected: true,
  };
}

// ---------------------------------------------------------------------------
// SignalVaultClient
// ---------------------------------------------------------------------------

/**
 * SignalVault Client — wraps OpenAI and/or Anthropic with guardrails and audit logging.
 *
 * @example OpenAI
 * ```typescript
 * const client = new SignalVaultClient({
 *   apiKey: 'sk_live_...',
 *   openaiApiKey: process.env.OPENAI_API_KEY!,
 *   metadata: { user_id: '123' },
 * });
 * const res = await client.chat.completions.create({ model: 'gpt-4o', messages: [...] });
 * ```
 *
 * @example Anthropic
 * ```typescript
 * const client = new SignalVaultClient({
 *   apiKey: 'sk_live_...',
 *   anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
 * });
 * const res = await client.messages.create({ model: 'claude-sonnet-4-5', messages: [...], max_tokens: 1024 });
 * ```
 */
export class SignalVaultClient {
  private readonly svApiKey: string;
  private readonly svBaseUrl: string;
  private readonly svEnvironment: string;
  private readonly debugMode: boolean;
  private readonly mirrorMode: boolean;
  private readonly failMode: FailMode;
  private readonly preflightTimeout: number;
  private readonly bgTimeout: number;
  private readonly defaultMetadata: Record<string, unknown>;
  private readonly openai: OpenAI | null;
  private readonly anthropic: any | null;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly lastWarned = new Map<string, number>();
  private readonly exitFlushTimeout: number;
  private readonly queue: EventQueue;
  private readonly dropped: DroppedEvents = { queueFull: 0, retriesExhausted: 0, exit: 0 };
  private exitFlushing = false;

  /**
   * Clients with audit events queued, flushed on `beforeExit`. A client is
   * held only while its queue is not empty, so this never keeps an unused
   * client alive.
   */
  private static readonly exitClients = new Set<SignalVaultClient>();
  private static exitHookInstalled = false;

  constructor(config: SignalVaultConfig) {
    assertNodeEnvironment();

    if (!config.openaiApiKey && !config.anthropicApiKey) {
      throw new Error('[SignalVault] At least one of openaiApiKey or anthropicApiKey is required.');
    }
    if (config.failMode !== undefined && config.failMode !== 'open' && config.failMode !== 'closed') {
      throw new Error("[SignalVault] failMode must be 'open' or 'closed'.");
    }

    this.svApiKey = normalizeApiKey(config.apiKey);
    this.svBaseUrl = normalizeBaseUrl(config.baseUrl || DEFAULT_BASE_URL);
    this.svEnvironment = config.environment || 'production';
    this.debugMode = config.debug || false;
    this.mirrorMode = config.mirrorMode || false;
    this.failMode = config.failMode ?? 'open';
    this.preflightTimeout = config.preflightTimeout ?? 2000;
    this.bgTimeout = config.timeout ?? 10000;
    this.defaultMetadata = config.metadata ?? {};
    this.exitFlushTimeout = config.exitFlushTimeout ?? 10_000;
    this.queue = new EventQueue({
      send: (body) => this.post(body, this.bgTimeout),
      dropped: (reason, entries) => this.reportDropped(reason, entries),
      busy: (busy) => this.onQueueBusy(busy),
      debug: (message, detail) => {
        if (this.debugMode) console.error(`[SignalVault] ${message}`, describeError(detail, this.svApiKey));
      },
    });

    this.openai = config.openaiApiKey ? loadOpenAI(config.openaiApiKey) : null;
    this.anthropic = config.anthropicApiKey ? loadAnthropic(config.anthropicApiKey) : null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Sends the queued audit events and waits until they are delivered, up to
   * `timeoutMs`. Events waiting out a retry backoff are tried again at once.
   * Call before a short-lived process exits or freezes (scripts, the end of
   * every serverless invocation), otherwise queued events are lost. Events
   * still undelivered at the deadline stay queued and keep being retried
   * while the process runs.
   */
  async flush(timeoutMs = 5000): Promise<void> {
    if (!(await this.drain(timeoutMs))) {
      this.warn('flush-timeout', `[SignalVault] flush() timed out with ${this.stillQueued()}`);
    }
  }

  /**
   * Flushes like flush(), with a longer default deadline. Nothing is dropped:
   * events still undelivered at the deadline stay queued and keep being
   * retried while the process runs, and a warning names them. The client can
   * still be used afterwards.
   */
  async close(timeoutMs = 10_000): Promise<void> {
    if (!(await this.drain(timeoutMs))) {
      console.warn(`[SignalVault] close() timed out with ${this.stillQueued()}`);
    }
  }

  /**
   * Audit events dropped so far, by cause. Every drop is also logged with
   * console.warn, with the ids of the events dropped.
   */
  get droppedEvents(): Readonly<DroppedEvents> {
    return { ...this.dropped };
  }

  /** "N audit event(s) still queued: <ids>. ..." for the flush() and close() warnings. */
  private stillQueued(): string {
    const ids = this.queue.pendingBodies().map((body) => describeEvent(body, 1));
    return (
      `${ids.length} audit event(s) still queued: ${ids.join(', ')}. ` +
      'They stay queued and are retried while the process runs; they are lost if it exits first.'
    );
  }

  /** Waits for the queue and every tracked chain to finish. False at the deadline. */
  private async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    if (timeoutMs > 0) this.queue.expedite();
    while (this.pending.size > 0 || this.queue.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.pending, this.queue.whenIdle()]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, remaining);
        }),
      ]);
      clearTimeout(timer);
    }
    return true;
  }

  /**
   * Queues a background event. `eventId: false` only for the fallback
   * ai.request (see sendResponseEvent). `lost`: see EventQueue.add().
   */
  private enqueue(body: Record<string, unknown>, { eventId = true, lost = 1 } = {}): QueuedDelivery {
    return this.queue.add(eventId ? { event_id: randomUUID(), ...body } : body, lost);
  }

  /**
   * Counts and logs every drop, with the ids of the events dropped: one
   * console.warn line per drop, never rate limited. The explanation after
   * the ids is added at most once a minute per cause.
   */
  private reportDropped(reason: DropReason, entries: DroppedEntry[]): void {
    const count = entries.reduce((sum, entry) => sum + entry.lost, 0);
    this.dropped[DROP_COUNTERS[reason]] += count;
    const cause =
      reason === 'overflow'
        ? `queue full: ${MAX_QUEUED_EVENTS} events were waiting to be sent`
        : reason === 'attempts'
          ? `retries exhausted: ${MAX_ATTEMPTS} attempts, last: ${entries[0].lastStatus ?? 'no response'}`
          : `process exiting: not delivered within exitFlushTimeout (${this.exitFlushTimeout} ms)`;
    const ids = entries.map((entry) => describeEvent(entry.body, entry.lost)).join(', ');
    const hint = this.shouldWarn(`dropped:${reason}`)
      ? ' Dropped events are not in your audit log. ' +
        (reason === 'exit'
          ? 'Call flush() before the process ends to deliver them.'
          : 'Events queue up while SignalVault is unreachable or rate limiting this app.') +
        ' Counts by cause: client.droppedEvents.'
      : '';
    console.warn(`[SignalVault] Dropped ${count} audit event(s) (${cause}): ${ids}.${hint}`);
  }

  /** Keeps this client in the beforeExit set while it has events queued. */
  private onQueueBusy(busy: boolean): void {
    if (!busy) {
      SignalVaultClient.exitClients.delete(this);
    } else if (this.exitFlushTimeout > 0) {
      SignalVaultClient.exitClients.add(this);
      SignalVaultClient.installExitHook();
    }
  }

  /**
   * One `beforeExit` listener per process, for every client. `beforeExit`
   * fires when the event loop is empty; the flush gives it work again, so it
   * fires once more afterwards, by then with nothing left to do.
   */
  private static installExitHook(): void {
    if (SignalVaultClient.exitHookInstalled) return;
    SignalVaultClient.exitHookInstalled = true;
    process.on('beforeExit', () => {
      for (const client of [...SignalVaultClient.exitClients]) void client.exitFlush();
    });
  }

  /** Flushes for up to exitFlushTimeout; what is left then is dropped, logged and counted. */
  private async exitFlush(): Promise<void> {
    if (this.exitFlushing) return;
    this.exitFlushing = true;
    try {
      if (!(await this.drain(this.exitFlushTimeout))) this.queue.abandon('exit');
    } finally {
      this.exitFlushing = false;
    }
  }

  /** Tracks a background promise so flush() can wait for it. Never rejects. */
  private track(promise: Promise<unknown>): void {
    const tracked = promise
      .catch((err) => {
        if (this.debugMode) {
          console.error('[SignalVault] Background event failed:', describeError(err, this.svApiKey));
        }
      })
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Prints a warning, at most once per minute per key. Not gated on debug. */
  private warn(key: string, message: string): void {
    if (this.shouldWarn(key)) console.warn(message);
  }

  /** True at most once per minute per key, and records that it was. */
  private shouldWarn(key: string): boolean {
    const now = Date.now();
    const last = this.lastWarned.get(key);
    if (last !== undefined && now - last < WARN_INTERVAL_MS) return false;
    this.lastWarned.set(key, now);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Agent tool-use capture
  // ---------------------------------------------------------------------------

  /**
   * Wraps a function so every call records an `agent.tool_call` event with
   * timing, input, output, and any error. The wrapper auto-times, runs the
   * inner function, fires the audit event in the background, and returns the
   * inner result (or rethrows the inner error).
   *
   * Tool calls invoked inside a `withContext({ requestId })` block auto-pick
   * up the requestId for correlation with the parent ai.request.
   *
   * @example
   * ```typescript
   * const fetchWeather = signalvault.tool('fetch_weather', async (city: string) => {
   *   const res = await fetch(`https://api.example.com/weather?city=${city}`);
   *   return res.json();
   * });
   *
   * const weather = await fetchWeather('London');
   * ```
   */
  tool<TArgs extends readonly unknown[], TReturn>(
    name: string,
    fn: (...args: TArgs) => TReturn | Promise<TReturn>,
    options?: { metadata?: Record<string, unknown> }
  ): (...args: TArgs) => Promise<TReturn> {
    return wrapTool(
      {
        recordFn: (opts) => {
          const promise = this.sendToolCallEvent(opts);
          this.track(promise);
          return promise;
        },
        debug: this.debugMode,
      },
      name,
      fn,
      options
    );
  }

  /**
   * Manual tool recording API. Use when the wrapper isn't a fit (streaming
   * tools, custom timing, post-hoc capture from logs). Resolves after the
   * first delivery attempt; if that one failed and can be retried, the event
   * stays queued and is retried in the background like any other.
   *
   * @example
   * ```typescript
   * await signalvault.tools.record({
   *   toolName: 'fetch_weather',
   *   toolInput: { city: 'London' },
   *   toolOutput: { temp: 12.3 },
   *   durationMs: 142,
   * });
   * ```
   */
  get tools(): ToolsAPI {
    return {
      record: (opts) => this.sendToolCallEvent(opts, false),
    };
  }

  /**
   * Runs the given async function inside a context where tool calls are
   * automatically correlated to the provided `requestId`. Useful for grouping
   * a multi-step agent loop under one logical turn.
   *
   * @example
   * ```typescript
   * await signalvault.withContext({ requestId: 'agent-turn-abc' }, async () => {
   *   const llm = await signalvault.chat.completions.create({...});
   *   await fetchWeather('London'); // tool call auto-linked to 'agent-turn-abc'
   * });
   * ```
   */
  withContext<T>(ctx: { requestId?: string }, fn: () => Promise<T>): Promise<T> {
    return runWithContext(ctx, fn);
  }

  /** `waitForDelivery: false` resolves after the first attempt (tools.record()). */
  private async sendToolCallEvent(opts: ToolRecordOptions, waitForDelivery = true): Promise<void> {
    const metadata = { ...this.defaultMetadata, ...(opts.metadata ?? {}) };

    // Validate + sanitize before the first await, so the payload reflects the
    // arguments at call time even if the caller mutates them afterwards.
    // validateToolName throws on missing/empty name; surfacing that to the
    // caller is intentional — the manual API should refuse malformed input.
    const safeName = validateToolName(opts.toolName);

    const payload: Record<string, unknown> = {
      tool_name: safeName,
      tool_input: sanitizePayload(opts.toolInput),
      tool_output: sanitizePayload(opts.toolOutput),
      duration_ms: opts.durationMs,
    };
    const safeError = sanitizeError(opts.error);
    if (safeError !== undefined) payload.error = safeError;
    if (opts.startedAt) payload.started_at = opts.startedAt;

    const body: Record<string, unknown> = {
      type: 'agent.tool_call',
      environment: this.svEnvironment,
      metadata,
      payload,
    };
    if (opts.requestId) body.request_id = opts.requestId;

    try {
      JSON.stringify(body);
    } catch (error) {
      // sanitizePayload should make this impossible, but guard the outer
      // serialize too — we'd rather drop the audit than crash the app.
      console.warn('[SignalVault] tool_call serialization failed, event dropped:', error);
      return;
    }

    const delivery = this.enqueue(body);
    const result = await (waitForDelivery ? delivery.done : delivery.firstAttempt);
    if (result.state === 'rejected' && result.status !== null && result.status >= 400 && result.status < 500) {
      // Surface 4xx unconditionally — those are usually misconfigurations
      // (bad key, malformed payload) the user must know about. 429 is retried,
      // so it is never 'rejected'.
      console.warn(
        `[SignalVault] tool_call rejected with ${result.status}. ` +
          `Check your apiKey and event payload.`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // OpenAI: chat.completions
  // ---------------------------------------------------------------------------

  get chat(): {
    completions: {
      create(
        params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        options?: CreateOptions
      ): Promise<OpenAI.Chat.ChatCompletion>;
      create(
        params: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        options?: CreateOptions
      ): Promise<AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk>>;
    };
  } {
    if (!this.openai) {
      throw new Error('[SignalVault] openaiApiKey was not provided.');
    }
    const self = this;
    return {
      completions: {
        async create(
          params: OpenAI.Chat.ChatCompletionCreateParams,
          options?: CreateOptions
        ): Promise<any> {
          const requestId = randomUUID();
          const metadata = { ...self.defaultMetadata, ...(options?.metadata ?? {}) };

          if (self.debugMode) {
            console.log(
              '[SignalVault] Processing request:',
              requestId,
              self.mirrorMode ? '(MIRROR MODE)' : '',
              params.stream ? '(STREAMING)' : ''
            );
          }

          if (self.mirrorMode) {
            return self.handleOpenAIMirror(requestId, params, metadata);
          }
          return self.handleOpenAINormal(requestId, params, metadata);
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Anthropic: messages
  // ---------------------------------------------------------------------------

  get messages(): {
    create(params: any, options?: CreateOptions): Promise<any>;
  } {
    if (!this.anthropic) {
      throw new Error(
        '[SignalVault] anthropicApiKey not provided or @anthropic-ai/sdk not installed.'
      );
    }
    const self = this;
    return {
      async create(params: any, options?: CreateOptions): Promise<any> {
        const requestId = randomUUID();
        const metadata = { ...self.defaultMetadata, ...(options?.metadata ?? {}) };

        if (self.debugMode) {
          console.log(
            '[SignalVault] Anthropic request:',
            requestId,
            self.mirrorMode ? '(MIRROR MODE)' : '',
            params.stream ? '(STREAMING)' : ''
          );
        }

        if (self.mirrorMode) {
          return self.handleAnthropicMirror(requestId, params, metadata);
        }
        return self.handleAnthropicNormal(requestId, params, metadata);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // OpenAI — mirror mode
  // ---------------------------------------------------------------------------

  private async handleOpenAIMirror(
    requestId: string,
    params: OpenAI.Chat.ChatCompletionCreateParams,
    metadata: Record<string, unknown>
  ) {
    const usage = withStreamUsage(params);
    const response = await this.openai!.chat.completions.create(usage.params as any);
    const model = params.model as string;
    const messages = params.messages as unknown[];

    if (params.stream) {
      return this.wrapStream(response as any, usage.injected, (output, promptTokens, completionTokens) =>
        this.sendAuditEvents(
          requestId, model, messages, output,
          { prompt_tokens: promptTokens, completion_tokens: completionTokens }, metadata, 'openai'
        )
      );
    }

    const completion = response as OpenAI.Chat.ChatCompletion;
    this.track(
      this.sendAuditEvents(
        requestId, model, messages,
        completion.choices[0]?.message?.content || '',
        {
          prompt_tokens: completion.usage?.prompt_tokens || 0,
          completion_tokens: completion.usage?.completion_tokens || 0,
        },
        metadata, 'openai'
      )
    );
    return completion;
  }

  // ---------------------------------------------------------------------------
  // OpenAI — normal mode
  // ---------------------------------------------------------------------------

  private async handleOpenAINormal(
    requestId: string,
    params: OpenAI.Chat.ChatCompletionCreateParams,
    metadata: Record<string, unknown>
  ) {
    const model = params.model as string;
    const messages = params.messages as unknown[];
    const decision = await this.enforce(requestId, model, messages, metadata, 'openai');
    const fallback = this.fallbackRequest(decision, requestId, model, messages, metadata, 'openai');

    const usage = withStreamUsage(params);
    const response = await this.openai!.chat.completions.create(usage.params as any);

    if (params.stream) {
      return this.wrapStream(response as any, usage.injected, (output, promptTokens, completionTokens) =>
        this.sendResponseEvent(
          requestId, model, output,
          { prompt_tokens: promptTokens, completion_tokens: completionTokens }, metadata, 'openai', fallback
        )
      );
    }

    const completion = response as OpenAI.Chat.ChatCompletion;
    // Background: the audit of the response must not delay returning it.
    this.track(
      this.sendResponseEvent(
        requestId, model,
        completion.choices[0]?.message?.content || '',
        {
          prompt_tokens: completion.usage?.prompt_tokens || 0,
          completion_tokens: completion.usage?.completion_tokens || 0,
        },
        metadata, 'openai', fallback
      )
    );
    return completion;
  }

  // ---------------------------------------------------------------------------
  // Anthropic — mirror mode
  // ---------------------------------------------------------------------------

  private async handleAnthropicMirror(
    requestId: string,
    params: any,
    metadata: Record<string, unknown>
  ) {
    const response = await this.anthropic.messages.create(params);
    const messages = anthropicMessagesForAudit(params);

    if (params.stream) {
      return this.wrapAnthropicStream(response, (output, usage) =>
        this.sendAuditEvents(requestId, params.model, messages, output, usage, metadata, 'anthropic')
      );
    }

    this.track(
      this.sendAuditEvents(
        requestId, params.model, messages, anthropicOutputText(response),
        anthropicUsage(response.usage),
        metadata, 'anthropic'
      )
    );
    return response;
  }

  // ---------------------------------------------------------------------------
  // Anthropic — normal mode
  // ---------------------------------------------------------------------------

  private async handleAnthropicNormal(
    requestId: string,
    params: any,
    metadata: Record<string, unknown>
  ) {
    const messages = anthropicMessagesForAudit(params);
    const decision = await this.enforce(requestId, params.model, messages, metadata, 'anthropic');
    const fallback = this.fallbackRequest(decision, requestId, params.model, messages, metadata, 'anthropic');

    const response = await this.anthropic.messages.create(params);

    if (params.stream) {
      return this.wrapAnthropicStream(response, (output, usage) =>
        this.sendResponseEvent(requestId, params.model, output, usage, metadata, 'anthropic', fallback)
      );
    }

    this.track(
      this.sendResponseEvent(
        requestId, params.model, anthropicOutputText(response),
        anthropicUsage(response.usage),
        metadata, 'anthropic', fallback
      )
    );
    return response;
  }

  // ---------------------------------------------------------------------------
  // Stream wrappers
  // ---------------------------------------------------------------------------

  /**
   * Yields chunks through unchanged and records the response when the stream
   * ends — including when the consumer breaks out early or the stream throws,
   * in which case the partial output is recorded. When the SDK added
   * `include_usage` itself (`hideUsageChunk`), the usage-only final chunk is
   * consumed here rather than passed on.
   */
  private async *wrapStream(
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
    hideUsageChunk: boolean,
    onComplete: (output: string, promptTokens: number, completionTokens: number) => Promise<void>
  ) {
    const chunks: string[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      for await (const chunk of stream) {
        const content = chunk.choices?.[0]?.delta?.content || '';
        if (content) chunks.push(content);
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens || 0;
          completionTokens = chunk.usage.completion_tokens || 0;
          // Missing or empty `choices`: the usage-only chunk the caller didn't ask for.
          if (hideUsageChunk && !chunk.choices?.length) continue;
        }
        yield chunk;
      }
    } finally {
      this.track(onComplete(chunks.join(''), promptTokens, completionTokens));
    }
  }

  private async *wrapAnthropicStream(
    stream: AsyncIterable<any>,
    onComplete: (output: string, usage: Usage) => Promise<void>
  ) {
    const chunks: string[] = [];
    let usage = anthropicUsage();

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          chunks.push(event.delta.text || '');
        }
        // message_delta may repeat the input and cache counts; its values win.
        if (event.type === 'message_start' && event.message?.usage) {
          usage = anthropicUsage(usage, event.message.usage);
        }
        if (event.type === 'message_delta' && event.usage) {
          usage = anthropicUsage(usage, event.usage);
        }
        yield event;
      }
    } finally {
      this.track(onComplete(chunks.join(''), usage));
    }
  }

  // ---------------------------------------------------------------------------
  // Guardrail enforcement
  // ---------------------------------------------------------------------------

  /** Runs the pre-flight check and throws if the request must not proceed. */
  private async enforce(
    requestId: string,
    model: string,
    messages: unknown[],
    metadata: Record<string, unknown>,
    provider: string
  ): Promise<SignalVaultDecision> {
    const decision = await this.sendRequest(requestId, model, messages, metadata, provider);

    if (decision.decision === 'block') {
      throw new SignalVaultBlockedError(requestId, decision.violations, decision.dashboard_url);
    }
    if (decision.decision === 'warn' && this.debugMode) {
      console.warn('[SignalVault] Warnings:', decision.violations);
    }
    return decision;
  }

  /**
   * Called when no decision could be obtained. Throws in failMode 'closed';
   * otherwise warns (never silently) and allows. `recorded`: the server
   * stored the request without checking it.
   */
  private unavailable(
    requestId: string,
    key: string,
    reason: string,
    status?: number,
    recorded = false
  ): SignalVaultDecision {
    if (this.failMode === 'closed') {
      throw new SignalVaultUnavailableError(requestId, reason, status);
    }
    this.warn(
      `preflight:${key}`,
      `[SignalVault] ${reason}. Guardrails were NOT applied — requests are being sent ` +
        `to the provider unchecked (failMode: 'open').` +
        (recorded ? ' They are still recorded in the audit log, marked as unchecked.' : '')
    );
    const decision: SignalVaultDecision = { ...ALLOW, violations: [], redactions: [] };
    (decision as unknown as Record<symbol, string>)[PREFLIGHT_FAILED] = recorded
      ? 'recorded'
      : RECORDABLE_CAUSES.has(key)
        ? 'record'
        : 'skip';
    return decision;
  }

  /**
   * The ai.request body to record in the background when the pre-flight got
   * no decision, so an unchecked call is still in the audit log. Undefined
   * when the server stored the pre-flight (with a decision, or unchecked over
   * the rule-check rate limit); null when the server refused it and no audit
   * event should be sent.
   */
  private fallbackRequest(
    decision: SignalVaultDecision,
    requestId: string,
    model: string,
    messages: unknown[],
    metadata: Record<string, unknown>,
    provider: string
  ): Record<string, unknown> | null | undefined {
    const failed = (decision as unknown as Record<symbol, string>)[PREFLIGHT_FAILED];
    if (failed === undefined || failed === 'recorded') return undefined;
    if (failed === 'skip') return null;
    return {
      ...this.requestBody(requestId, model, messages, metadata, provider),
      // A fallback is only sent once the call has gone to the provider, so a
      // request recorded unchecked from it was forwarded.
      payload: { messages, preflight_unavailable: true, fail_mode: 'open' },
    };
  }

  private requestBody(
    requestId: string,
    model: string,
    messages: unknown[],
    metadata: Record<string, unknown>,
    provider: string
  ): Record<string, unknown> {
    return {
      type: 'ai.request',
      request_id: requestId,
      environment: this.svEnvironment,
      provider,
      model,
      metadata,
      payload: { messages },
    };
  }

  private describeFailure(status: number, body: any): [string, string] {
    const errorType = typeof body?.error === 'object' ? body.error?.type : body?.error;

    switch (status) {
      case 401:
        return ['401', 'SignalVault rejected the API key (401: invalid or revoked)'];
      case 402:
        return ['402', `SignalVault account is not active (402: ${errorType || 'payment required'})`];
      case 403:
        return ['403', `SignalVault denied access (403: ${errorType || 'forbidden'})`];
      case 429:
        return errorType === 'trial_limit_exceeded'
          ? ['429-trial', 'SignalVault trial limit reached (429)']
          : ['429', 'SignalVault rate limit reached (429)'];
      default:
        if (status >= 300 && status < 400) {
          return ['3xx', `SignalVault API redirected (${status}); check that baseUrl is the https:// API URL`];
        }
        return status >= 500
          ? ['5xx', `SignalVault API error (${status})`]
          : [`${status}`, `SignalVault rejected the pre-flight check (${status})`];
    }
  }

  // ---------------------------------------------------------------------------
  // API communication
  // ---------------------------------------------------------------------------

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${this.svApiKey}`,
      'User-Agent': `signalvault-node/${SDK_VERSION} node/${process.versions.node}`,
    };
  }

  /** Single POST. Never follows redirects, so the API key is never re-sent elsewhere. */
  private async post(body: Record<string, unknown>, timeoutMs: number): Promise<PostResult> {
    const response = await fetch(`${this.svBaseUrl}/v1/events`, {
      method: 'POST',
      headers: this.headers(),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, response };
  }

  /**
   * The pre-flight check. Not queued: it is in the caller's critical path,
   * and failMode decides what happens when it fails. `fail_mode` tells the
   * server whether a request it cannot check is forwarded anyway.
   */
  private async sendRequest(
    requestId: string,
    model: string,
    messages: unknown[],
    metadata: Record<string, unknown>,
    provider: string
  ): Promise<SignalVaultDecision> {
    let result: PostResult;
    try {
      result = await this.post(
        {
          ...this.requestBody(requestId, model, messages, metadata, provider),
          payload: { messages, fail_mode: this.failMode },
        },
        this.preflightTimeout
      );
    } catch (error) {
      const timedOut = isTimeout(error);
      if (this.debugMode) {
        console.error('[SignalVault] Pre-flight failed:', describeError(error, this.svApiKey));
      }
      return this.unavailable(
        requestId,
        timedOut ? 'timeout' : 'network',
        timedOut
          ? `SignalVault pre-flight check timed out after ${this.preflightTimeout}ms`
          : 'SignalVault API is unreachable'
      );
    }

    if (!result.ok) {
      let body: any;
      try {
        body = await result.response?.json();
      } catch {
        body = undefined;
      }
      if (result.status === 429 && body?.recorded === true) {
        // Over the app's rule-check rate limit: the server stored the
        // request, with no rules run, but there is still no decision.
        return this.unavailable(
          requestId, '429-recorded', 'SignalVault rule-check rate limit reached (429)', 429, true
        );
      }
      const [key, reason] = this.describeFailure(result.status, body);
      return this.unavailable(requestId, key, reason, result.status);
    }

    let data: any;
    try {
      data = await result.response!.json();
    } catch (error) {
      if (isTimeout(error)) {
        return this.unavailable(
          requestId, 'timeout', `SignalVault pre-flight check timed out after ${this.preflightTimeout}ms`
        );
      }
      return this.unavailable(requestId, 'invalid-response', 'SignalVault returned an invalid response');
    }
    if (!data || typeof data !== 'object' || !DECISIONS.has(data.decision)) {
      return this.unavailable(requestId, 'invalid-response', 'SignalVault returned an invalid decision');
    }

    return {
      decision: data.decision,
      violations: Array.isArray(data.violations)
        ? data.violations.filter((v: unknown) => v !== null && typeof v === 'object')
        : [],
      redactions: Array.isArray(data.redactions) ? data.redactions : [],
      dashboard_url: typeof data.dashboard_url === 'string' ? data.dashboard_url : undefined,
    };
  }

  private async sendResponseEvent(
    requestId: string,
    model: string,
    output: string,
    usage: Usage,
    metadata: Record<string, unknown>,
    provider: string,
    fallbackRequest?: Record<string, unknown> | null
  ): Promise<void> {
    if (fallbackRequest === null) return;
    if (fallbackRequest) {
      // Must land before the response: the server rejects an ai.response whose
      // ai.request it has not stored. No event_id: the server de-duplicates it
      // by request_id, which also covers a pre-flight it stored before the
      // client gave up on it, and every retry.
      const request = await this.enqueue(fallbackRequest, { eventId: false, lost: 2 }).done;
      // The response is not sent without its request: the server would refuse it.
      if (request.state === 'dropped') return;
    }
    await this.enqueue({
      type: 'ai.response',
      request_id: requestId,
      environment: this.svEnvironment,
      provider,
      model,
      metadata,
      payload: {
        output,
        usage,
      },
    }).done;
  }


  /**
   * Mirror mode: records the request, then the response. Sequential on
   * purpose — the server rejects an ai.response whose ai.request it has not
   * stored yet, so sending both at once can lose the response.
   */
  private async sendAuditEvents(
    requestId: string,
    model: string,
    messages: unknown[],
    output: string,
    usage: Usage,
    metadata: Record<string, unknown>,
    provider: string
  ): Promise<void> {
    const base = {
      request_id: requestId,
      environment: this.svEnvironment,
      provider,
      model,
      metadata,
    };

    const request = await this.enqueue(
      { ...base, type: 'ai.request', payload: { messages, monitor_mode: true } },
      { lost: 2 }
    ).done;
    // The response is not sent without its request: the server would refuse it.
    if (request.state === 'dropped') return;
    await this.enqueue({
      ...base,
      type: 'ai.response',
      payload: {
        output,
        usage,
        monitor_mode: true,
      },
    }).done;
  }
}

export default SignalVaultClient;
