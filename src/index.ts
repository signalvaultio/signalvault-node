import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import {
  ToolRecordOptions,
  ToolsAPI,
  runWithContext,
  sanitizeError,
  sanitizePayload,
  validateToolName,
  wrapTool,
} from './tools';

export type { ToolRecordOptions, ToolsAPI } from './tools';

/** Kept in sync with package.json by a unit test. */
export const SDK_VERSION = '0.4.0';

const DEFAULT_BASE_URL = 'https://api.signalvault.io';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** Longest Retry-After the SDK will wait out before retrying a background event once. */
const MAX_RETRY_AFTER_MS = 5000;
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
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`[SignalVault] baseUrl is not a valid URL: ${raw}`);
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      '[SignalVault] baseUrl must use https:// (plain http:// is only allowed for localhost). ' +
        'Your API key and prompts would otherwise be sent unencrypted.'
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`[SignalVault] baseUrl must be an https:// URL, got ${url.protocol}`);
  }
  return raw.replace(/\/+$/, '');
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
   * Timeout (ms) for all background / post-flight event calls.
   * Default: 10000
   */
  timeout?: number;
  /**
   * Default metadata attached to every event. Can be overridden per-call.
   * Use for user_id, feature, workspace_id, etc.
   */
  metadata?: Record<string, unknown>;
}

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
 * unchecked call still appears in the audit log. 'skip': the server refused
 * it (401/402/403/429/3xx), so a response event would be refused too.
 */
const PREFLIGHT_FAILED = Symbol('preflightFailed');
/** Causes where re-sending the ai.request later can succeed. */
const RECORDABLE_CAUSES = new Set(['timeout', 'network', '5xx', 'invalid-response']);
const DECISIONS = new Set(['allow', 'warn', 'block', 'redact']);

interface PostResult {
  ok: boolean;
  status: number;
  response?: Response;
}

interface BackgroundOptions {
  /**
   * Add an event_id idempotency key. Off only for the fallback ai.request,
   * which relies on the server's request_id de-duplication instead: the
   * original pre-flight may have been stored before the client gave up.
   */
  eventId?: boolean;
  /** Retry once on transient failures. Off for the manual tools.record() API. */
  retry?: boolean;
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

function parseRetryAfterMs(response?: Response): number | null {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  constructor(config: SignalVaultConfig) {
    assertNodeEnvironment();

    if (!config.openaiApiKey && !config.anthropicApiKey) {
      throw new Error('[SignalVault] At least one of openaiApiKey or anthropicApiKey is required.');
    }
    if (config.failMode !== undefined && config.failMode !== 'open' && config.failMode !== 'closed') {
      throw new Error("[SignalVault] failMode must be 'open' or 'closed'.");
    }

    this.svApiKey = config.apiKey;
    this.svBaseUrl = normalizeBaseUrl(config.baseUrl || DEFAULT_BASE_URL);
    this.svEnvironment = config.environment || 'production';
    this.debugMode = config.debug || false;
    this.mirrorMode = config.mirrorMode || false;
    this.failMode = config.failMode ?? 'open';
    this.preflightTimeout = config.preflightTimeout ?? 2000;
    this.bgTimeout = config.timeout ?? 10000;
    this.defaultMetadata = config.metadata ?? {};

    this.openai = config.openaiApiKey
      ? new OpenAI({ apiKey: config.openaiApiKey })
      : null;

    if (config.anthropicApiKey) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('@anthropic-ai/sdk');
        const Anthropic = mod.default ?? mod;
        this.anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
      } catch {
        throw new Error(
          '[SignalVault] @anthropic-ai/sdk is not installed. Run: npm install @anthropic-ai/sdk'
        );
      }
    } else {
      this.anthropic = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Waits for in-flight audit events to finish sending, up to `timeoutMs`.
   * Call before a short-lived process exits (scripts, serverless handlers),
   * otherwise queued events are lost.
   */
  async flush(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.warn('flush-timeout', `[SignalVault] flush() timed out with ${this.pending.size} event(s) still sending.`);
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.pending]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, remaining);
        }),
      ]);
      clearTimeout(timer);
    }
  }

  /** Flushes pending events. The client can still be used afterwards. */
  async close(timeoutMs = 5000): Promise<void> {
    await this.flush(timeoutMs);
  }

  /** Tracks a background promise so flush() can wait for it. Never rejects. */
  private track(promise: Promise<unknown>): void {
    const tracked = promise
      .catch((err) => {
        if (this.debugMode) console.error('[SignalVault] Background event failed:', err);
      })
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Prints a warning, at most once per minute per key. Not gated on debug. */
  private warn(key: string, message: string): void {
    const now = Date.now();
    const last = this.lastWarned.get(key);
    if (last !== undefined && now - last < WARN_INTERVAL_MS) return;
    this.lastWarned.set(key, now);
    console.warn(message);
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
   * tools, custom timing, post-hoc capture from logs).
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

  private async sendToolCallEvent(opts: ToolRecordOptions, retry = true): Promise<void> {
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

    const result = await this.postBackground(body, { retry });
    if (result && !result.ok && result.status >= 400 && result.status < 500 && result.status !== 429) {
      // Surface 4xx unconditionally — those are usually misconfigurations
      // (bad key, malformed payload) the user must know about.
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
    const response = await this.openai!.chat.completions.create(params as any);
    const model = params.model as string;
    const messages = params.messages as unknown[];

    if (params.stream) {
      return this.wrapStream(response as any, (output, promptTokens, completionTokens) =>
        this.sendAuditEvents(
          requestId, model, messages, output, promptTokens, completionTokens, metadata, 'openai'
        )
      );
    }

    const completion = response as OpenAI.Chat.ChatCompletion;
    this.track(
      this.sendAuditEvents(
        requestId, model, messages,
        completion.choices[0]?.message?.content || '',
        completion.usage?.prompt_tokens || 0,
        completion.usage?.completion_tokens || 0,
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

    const response = await this.openai!.chat.completions.create(params as any);

    if (params.stream) {
      return this.wrapStream(response as any, (output, promptTokens, completionTokens) =>
        this.sendResponseEvent(
          requestId, model, output, promptTokens, completionTokens, metadata, 'openai', fallback
        )
      );
    }

    const completion = response as OpenAI.Chat.ChatCompletion;
    // Background: the audit of the response must not delay returning it.
    this.track(
      this.sendResponseEvent(
        requestId, model,
        completion.choices[0]?.message?.content || '',
        completion.usage?.prompt_tokens || 0,
        completion.usage?.completion_tokens || 0,
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
      return this.wrapAnthropicStream(response, (output, inputTokens, outputTokens) =>
        this.sendAuditEvents(
          requestId, params.model, messages, output, inputTokens, outputTokens, metadata, 'anthropic'
        )
      );
    }

    this.track(
      this.sendAuditEvents(
        requestId, params.model, messages, anthropicOutputText(response),
        response.usage?.input_tokens || 0,
        response.usage?.output_tokens || 0,
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
      return this.wrapAnthropicStream(response, (output, inputTokens, outputTokens) =>
        this.sendResponseEvent(
          requestId, params.model, output, inputTokens, outputTokens, metadata, 'anthropic', fallback
        )
      );
    }

    this.track(
      this.sendResponseEvent(
        requestId, params.model, anthropicOutputText(response),
        response.usage?.input_tokens || 0,
        response.usage?.output_tokens || 0,
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
   * in which case the partial output is recorded.
   */
  private async *wrapStream(
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
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
        }
        yield chunk;
      }
    } finally {
      this.track(onComplete(chunks.join(''), promptTokens, completionTokens));
    }
  }

  private async *wrapAnthropicStream(
    stream: AsyncIterable<any>,
    onComplete: (output: string, inputTokens: number, outputTokens: number) => Promise<void>
  ) {
    const chunks: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          chunks.push(event.delta.text || '');
        }
        if (event.type === 'message_start' && event.message?.usage) {
          inputTokens = event.message.usage.input_tokens || 0;
        }
        if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens || 0;
        }
        yield event;
      }
    } finally {
      this.track(onComplete(chunks.join(''), inputTokens, outputTokens));
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
   * otherwise warns (never silently) and allows.
   */
  private unavailable(requestId: string, key: string, reason: string, status?: number): SignalVaultDecision {
    if (this.failMode === 'closed') {
      throw new SignalVaultUnavailableError(requestId, reason, status);
    }
    this.warn(
      `preflight:${key}`,
      `[SignalVault] ${reason}. Guardrails were NOT applied — requests are being sent ` +
        `to the provider unchecked (failMode: 'open').`
    );
    const decision: SignalVaultDecision = { ...ALLOW, violations: [], redactions: [] };
    (decision as unknown as Record<symbol, string>)[PREFLIGHT_FAILED] =
      RECORDABLE_CAUSES.has(key) ? 'record' : 'skip';
    return decision;
  }

  /**
   * The ai.request body to record in the background when the pre-flight got
   * no decision, so an unchecked call is still in the audit log. Undefined
   * when the pre-flight was recorded normally; null when the server refused
   * it and no audit event should be sent.
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
    if (failed === undefined) return undefined;
    if (failed === 'skip') return null;
    return {
      ...this.requestBody(requestId, model, messages, metadata, provider),
      payload: { messages, preflight_unavailable: true },
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

  private async describeFailure(status: number, response?: Response): Promise<[string, string]> {
    let body: any;
    try {
      body = await response?.json();
    } catch {
      body = undefined;
    }
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
   * POST for background events. Adds an `event_id` so a retry is never
   * double-counted, and retries once on connection errors, 5xx, and 429 with a
   * short Retry-After. Timeouts are not retried: the server may be slow rather
   * than down, and a retry would double the time the event is held. Returns
   * the last response, or null if nothing was received.
   */
  private async postBackground(
    body: Record<string, unknown>,
    { eventId = true, retry = true }: BackgroundOptions = {}
  ): Promise<PostResult | null> {
    const event = eventId ? { event_id: randomUUID(), ...body } : body;
    let result: PostResult | null = null;
    let retryDelayMs: number | null = null;

    try {
      result = await this.post(event, this.bgTimeout);
      if (result.ok) return result;
      if (result.status === 429) {
        const retryAfter = parseRetryAfterMs(result.response);
        retryDelayMs = retryAfter !== null && retryAfter <= MAX_RETRY_AFTER_MS ? retryAfter : null;
      } else if (result.status >= 500) {
        retryDelayMs = 250 + Math.random() * 500;
      }
    } catch (error) {
      if (this.debugMode) console.error('[SignalVault] Event send failed:', error);
      if (!isTimeout(error)) retryDelayMs = 250 + Math.random() * 500;
    }

    if (retry && retryDelayMs !== null) {
      await sleep(retryDelayMs);
      try {
        result = await this.post(event, this.bgTimeout);
        if (result.ok) return result;
      } catch (error) {
        if (this.debugMode) console.error('[SignalVault] Event retry failed:', error);
      }
    }

    this.logUndelivered(result);
    return result;
  }

  private logUndelivered(result: PostResult | null): void {
    if (result?.status === 429) {
      this.warn('bg-429', '[SignalVault] Rate limited (429): audit events are being dropped.');
    } else if (this.debugMode) {
      console.error('[SignalVault] Event not delivered:', result ? result.status : 'no response');
    }
  }

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
        this.requestBody(requestId, model, messages, metadata, provider),
        this.preflightTimeout
      );
    } catch (error) {
      const timedOut = isTimeout(error);
      if (this.debugMode) console.error('[SignalVault] Pre-flight failed:', error);
      return this.unavailable(
        requestId,
        timedOut ? 'timeout' : 'network',
        timedOut
          ? `SignalVault pre-flight check timed out after ${this.preflightTimeout}ms`
          : 'SignalVault API is unreachable'
      );
    }

    if (!result.ok) {
      const [key, reason] = await this.describeFailure(result.status, result.response);
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
    promptTokens: number,
    completionTokens: number,
    metadata: Record<string, unknown>,
    provider: string,
    fallbackRequest?: Record<string, unknown> | null
  ): Promise<void> {
    if (fallbackRequest === null) return;
    if (fallbackRequest) {
      // Must land before the response: the server rejects an ai.response whose
      // ai.request it has not stored.
      await this.postBackground(fallbackRequest, { eventId: false });
    }
    await this.postBackground({
      type: 'ai.response',
      request_id: requestId,
      environment: this.svEnvironment,
      provider,
      model,
      metadata,
      payload: {
        output,
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
      },
    });
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
    promptTokens: number,
    completionTokens: number,
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

    await this.postBackground({
      ...base,
      type: 'ai.request',
      payload: { messages, monitor_mode: true },
    });
    await this.postBackground({
      ...base,
      type: 'ai.response',
      payload: {
        output,
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
        monitor_mode: true,
      },
    });
  }
}

export default SignalVaultClient;
