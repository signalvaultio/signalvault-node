import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignalVaultConfig {
  apiKey: string;
  /** Required for OpenAI (chat.completions). */
  openaiApiKey?: string;
  /** Required for Anthropic (messages). Install @anthropic-ai/sdk separately. */
  anthropicApiKey?: string;
  baseUrl?: string;
  environment?: 'development' | 'staging' | 'production';
  debug?: boolean;
  mirrorMode?: boolean;
  /**
   * Timeout (ms) for the pre-flight /v1/events call in normal mode.
   * This is in the critical path — on timeout/error the SDK fails open (allows).
   * Default: 2000
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

export interface SignalVaultDecision {
  decision: 'allow' | 'warn' | 'block' | 'redact';
  violations: Array<{
    rule_id?: string;
    type: string;
    severity: number;
    action: string;
    details: Record<string, unknown>;
  }>;
  redactions: Array<{
    start: number;
    end: number;
    replacement: string;
  }>;
}

export interface CreateOptions {
  /** Per-call metadata, merged over config-level metadata. */
  metadata?: Record<string, unknown>;
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
 *   baseUrl: 'https://api.signalvault.io',
 *   metadata: { user_id: '123' },
 * });
 * const res = await client.chat.completions.create({ model: 'gpt-4', messages: [...] });
 * ```
 *
 * @example Anthropic
 * ```typescript
 * const client = new SignalVaultClient({
 *   apiKey: 'sk_live_...',
 *   anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
 *   baseUrl: 'https://api.signalvault.io',
 * });
 * const res = await client.messages.create({ model: 'claude-3-5-sonnet-20241022', messages: [...], max_tokens: 1024 });
 * ```
 */
export class SignalVaultClient {
  private readonly svApiKey: string;
  private readonly svBaseUrl: string;
  private readonly svEnvironment: string;
  private readonly debugMode: boolean;
  private readonly mirrorMode: boolean;
  private readonly preflightTimeout: number;
  private readonly bgTimeout: number;
  private readonly defaultMetadata: Record<string, unknown>;
  private readonly openai: OpenAI | null;
  private readonly anthropic: any | null;

  constructor(config: SignalVaultConfig) {
    assertNodeEnvironment();

    if (!config.openaiApiKey && !config.anthropicApiKey) {
      throw new Error('[SignalVault] At least one of openaiApiKey or anthropicApiKey is required.');
    }

    this.svApiKey = config.apiKey;
    this.svBaseUrl = (config.baseUrl || 'http://localhost:4000').replace(/\/+$/, '');
    this.svEnvironment = config.environment || 'production';
    this.debugMode = config.debug || false;
    this.mirrorMode = config.mirrorMode || false;
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
        recordFn: (opts) => this.sendToolCallEvent(opts),
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
      record: (opts) => this.sendToolCallEvent(opts),
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

  private async sendToolCallEvent(opts: ToolRecordOptions): Promise<void> {
    const metadata = { ...this.defaultMetadata, ...(opts.metadata ?? {}) };

    // Validate + sanitize before constructing the body. validateToolName throws
    // on missing/empty name; surfacing that to the caller is intentional —
    // the manual API should refuse malformed input rather than silently fail.
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

    let serialized: string;
    try {
      serialized = JSON.stringify(body);
    } catch (error) {
      // sanitizePayload should make this impossible, but guard the outer
      // serialize too — we'd rather drop the audit than crash the app.
      console.warn('[SignalVault] tool_call serialization failed, event dropped:', error);
      return;
    }

    try {
      const response = await fetch(`${this.svBaseUrl}/v1/events`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(this.bgTimeout),
        body: serialized,
      });

      // Surface 4xx unconditionally — those are usually misconfigurations
      // (bad key, malformed payload) the user must know about. 5xx are noisy
      // and only logged in debug mode.
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          console.warn(
            `[SignalVault] tool_call rejected with ${response.status}. ` +
              `Check your apiKey and event payload.`
          );
        } else if (this.debugMode) {
          console.error('[SignalVault] tool_call event failed:', response.status);
        }
      }
    } catch (error) {
      if (this.debugMode) {
        console.error('[SignalVault] tool_call event error:', error);
      }
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
          const requestId = uuidv4();
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
        const requestId = uuidv4();
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
    try {
      const response = await this.openai!.chat.completions.create(params as any);

      if (params.stream) {
        return this.wrapStream(
          requestId,
          params.model as string,
          params.messages as any,
          response as any,
          async (output, promptTokens, completionTokens) => {
            await this.sendAuditEvents(
              requestId, params.model as string, params.messages as any,
              output, promptTokens, completionTokens, metadata, 'openai'
            );
          }
        );
      }

      const completion = response as OpenAI.Chat.ChatCompletion;
      this.sendAuditEvents(
        requestId, params.model as string, params.messages as any,
        completion.choices[0]?.message?.content || '',
        completion.usage?.prompt_tokens || 0,
        completion.usage?.completion_tokens || 0,
        metadata, 'openai'
      ).catch((err) => {
        if (this.debugMode) console.error('[SignalVault] Audit failed (non-blocking):', err);
      });

      return completion;
    } catch (error) {
      if (this.debugMode) console.error('[SignalVault] OpenAI error:', error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // OpenAI — normal mode
  // ---------------------------------------------------------------------------

  private async handleOpenAINormal(
    requestId: string,
    params: OpenAI.Chat.ChatCompletionCreateParams,
    metadata: Record<string, unknown>
  ) {
    try {
      const decision = await this.sendRequest(
        requestId, params.model as string, params.messages as any, metadata, 'openai'
      );

      if (decision.decision === 'block') {
        throw new Error(`[SignalVault] Request blocked: ${JSON.stringify(decision.violations)}`);
      }
      if (decision.decision === 'warn' && this.debugMode) {
        console.warn('[SignalVault] Warnings:', decision.violations);
      }

      const response = await this.openai!.chat.completions.create(params as any);

      if (params.stream) {
        return this.wrapStream(
          requestId,
          params.model as string,
          params.messages as any,
          response as any,
          async (output, promptTokens, completionTokens) => {
            await this.sendResponseEvent(
              requestId, params.model as string, output,
              promptTokens, completionTokens, metadata, 'openai'
            );
          }
        );
      }

      const completion = response as OpenAI.Chat.ChatCompletion;
      await this.sendResponseEvent(
        requestId, params.model as string,
        completion.choices[0]?.message?.content || '',
        completion.usage?.prompt_tokens || 0,
        completion.usage?.completion_tokens || 0,
        metadata, 'openai'
      );
      return completion;
    } catch (error) {
      if (this.debugMode) console.error('[SignalVault] Error:', error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Anthropic — mirror mode
  // ---------------------------------------------------------------------------

  private async handleAnthropicMirror(
    requestId: string,
    params: any,
    metadata: Record<string, unknown>
  ) {
    try {
      const response = await this.anthropic.messages.create(params);

      if (params.stream) {
        return this.wrapAnthropicStream(
          requestId, params.model, params.messages,
          response,
          async (output, inputTokens, outputTokens) => {
            await this.sendAuditEvents(
              requestId, params.model, params.messages,
              output, inputTokens, outputTokens, metadata, 'anthropic'
            );
          }
        );
      }

      const output = response.content?.[0]?.text || '';
      this.sendAuditEvents(
        requestId, params.model, params.messages, output,
        response.usage?.input_tokens || 0,
        response.usage?.output_tokens || 0,
        metadata, 'anthropic'
      ).catch((err) => {
        if (this.debugMode) console.error('[SignalVault] Anthropic audit failed (non-blocking):', err);
      });

      return response;
    } catch (error) {
      if (this.debugMode) console.error('[SignalVault] Anthropic error:', error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Anthropic — normal mode
  // ---------------------------------------------------------------------------

  private async handleAnthropicNormal(
    requestId: string,
    params: any,
    metadata: Record<string, unknown>
  ) {
    try {
      const decision = await this.sendRequest(
        requestId, params.model, params.messages, metadata, 'anthropic'
      );

      if (decision.decision === 'block') {
        throw new Error(`[SignalVault] Request blocked: ${JSON.stringify(decision.violations)}`);
      }
      if (decision.decision === 'warn' && this.debugMode) {
        console.warn('[SignalVault] Warnings:', decision.violations);
      }

      const response = await this.anthropic.messages.create(params);

      if (params.stream) {
        return this.wrapAnthropicStream(
          requestId, params.model, params.messages,
          response,
          async (output, inputTokens, outputTokens) => {
            await this.sendResponseEvent(
              requestId, params.model, output,
              inputTokens, outputTokens, metadata, 'anthropic'
            );
          }
        );
      }

      const output = response.content?.[0]?.text || '';
      await this.sendResponseEvent(
        requestId, params.model, output,
        response.usage?.input_tokens || 0,
        response.usage?.output_tokens || 0,
        metadata, 'anthropic'
      );
      return response;
    } catch (error) {
      if (this.debugMode) console.error('[SignalVault] Anthropic error:', error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Unified OpenAI stream wrapper
  // ---------------------------------------------------------------------------

  private async *wrapStream(
    requestId: string,
    model: string,
    messages: any,
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
    onComplete: (output: string, promptTokens: number, completionTokens: number) => Promise<void>
  ) {
    const chunks: string[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) chunks.push(content);
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens || 0;
        completionTokens = chunk.usage.completion_tokens || 0;
      }
      yield chunk;
    }

    onComplete(chunks.join(''), promptTokens, completionTokens).catch((err) => {
      if (this.debugMode) console.error('[SignalVault] Post-stream callback failed:', err);
    });
  }

  // ---------------------------------------------------------------------------
  // Anthropic stream wrapper
  // ---------------------------------------------------------------------------

  private async *wrapAnthropicStream(
    requestId: string,
    model: string,
    messages: any,
    stream: AsyncIterable<any>,
    onComplete: (output: string, inputTokens: number, outputTokens: number) => Promise<void>
  ) {
    const chunks: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

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

    onComplete(chunks.join(''), inputTokens, outputTokens).catch((err) => {
      if (this.debugMode) console.error('[SignalVault] Anthropic post-stream callback failed:', err);
    });
  }

  // ---------------------------------------------------------------------------
  // API communication
  // ---------------------------------------------------------------------------

  private authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.svApiKey}`,
    };
  }

  private async sendRequest(
    requestId: string,
    model: string,
    messages: any,
    metadata: Record<string, unknown>,
    provider: string
  ): Promise<SignalVaultDecision> {
    try {
      const response = await fetch(`${this.svBaseUrl}/v1/events`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(this.preflightTimeout),
        body: JSON.stringify({
          type: 'ai.request',
          request_id: requestId,
          environment: this.svEnvironment,
          provider,
          model,
          metadata,
          payload: { messages },
        }),
      });

      if (!response.ok) {
        if (this.debugMode) console.error('[SignalVault] API error:', response.status);
        return { decision: 'allow', violations: [], redactions: [] };
      }

      return (await response.json()) as SignalVaultDecision;
    } catch (error) {
      if (this.debugMode) console.error('[SignalVault] Pre-flight failed (fail-open):', error);
      return { decision: 'allow', violations: [], redactions: [] };
    }
  }

  private async sendResponseEvent(
    requestId: string,
    model: string,
    output: string,
    promptTokens: number,
    completionTokens: number,
    metadata: Record<string, unknown>,
    provider: string
  ): Promise<void> {
    try {
      await fetch(`${this.svBaseUrl}/v1/events`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(this.bgTimeout),
        body: JSON.stringify({
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
        }),
      });
    } catch (error) {
      if (this.debugMode) console.error('[SignalVault] Failed to send response event:', error);
    }
  }

  private async sendAuditEvents(
    requestId: string,
    model: string,
    messages: any,
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

    await Promise.all([
      fetch(`${this.svBaseUrl}/v1/events`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(this.bgTimeout),
        body: JSON.stringify({
          ...base,
          type: 'ai.request',
          payload: { messages, monitor_mode: true },
        }),
      }),
      fetch(`${this.svBaseUrl}/v1/events`, {
        method: 'POST',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(this.bgTimeout),
        body: JSON.stringify({
          ...base,
          type: 'ai.response',
          payload: {
            output,
            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
            monitor_mode: true,
          },
        }),
      }),
    ]);
  }
}

export default SignalVaultClient;
