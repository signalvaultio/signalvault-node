import { AsyncLocalStorage } from 'async_hooks';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard limit for serialized tool_input/tool_output JSON, in UTF-8 bytes. */
const MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KB
/** Hard limit for tool error string, in UTF-8 bytes. */
const MAX_ERROR_BYTES = 1900;
/** Hard limit for tool_name, in UTF-8 bytes. */
const MAX_TOOL_NAME_BYTES = 200;

// ---------------------------------------------------------------------------
// Context propagation
// ---------------------------------------------------------------------------

interface ToolContext {
  requestId?: string;
}

const toolContext = new AsyncLocalStorage<ToolContext>();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ToolRecordOptions {
  /** Logical name of the tool. Required. Truncated to 200 bytes. */
  toolName: string;
  /** Arguments passed to the tool. Any JSON-serializable value. */
  toolInput?: unknown;
  /** What the tool returned. Any JSON-serializable value. */
  toolOutput?: unknown;
  /** How long the tool took to run, in milliseconds. */
  durationMs: number;
  /** Error message if the tool threw. Truncated to 1900 bytes. */
  error?: string | null;
  /**
   * Optional ISO8601 timestamp of when the tool started.
   * Falls back to server-side `inserted_at` when omitted.
   */
  startedAt?: string;
  /**
   * Parent ai.request correlation. If omitted, the SDK uses the requestId from
   * the surrounding `withContext` block (if any), else null (orphan tool call).
   */
  requestId?: string | null;
  /** Per-call metadata, merged over client-level defaults. */
  metadata?: Record<string, unknown>;
}

export interface ToolsAPI {
  /**
   * Records a tool call manually. Use when the wrapper isn't a fit
   * (streaming tools, custom timing, post-hoc capture).
   */
  record(opts: ToolRecordOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal: context-aware request_id resolution
// ---------------------------------------------------------------------------

/** Returns the requestId from the surrounding withContext block, or undefined. */
export function getCurrentRequestId(): string | undefined {
  return toolContext.getStore()?.requestId;
}

/** Runs `fn` inside an async context with the given requestId attached. */
export function runWithContext<T>(ctx: ToolContext, fn: () => Promise<T>): Promise<T> {
  return toolContext.run(ctx, fn);
}

// ---------------------------------------------------------------------------
// Wrapper factory
// ---------------------------------------------------------------------------

export interface ToolWrapperConfig {
  recordFn: (opts: ToolRecordOptions) => Promise<void>;
  debug?: boolean;
}

/**
 * Wraps a function so every call records an `agent.tool_call` event with
 * timing, args, result, and any error.
 *
 * The wrapper auto-times, JSON-serializes args/result, and captures the
 * surrounding `withContext` requestId (if any). Errors propagate to the caller
 * after recording — wrapping is observation, not error swallowing.
 */
export function wrapTool<TArgs extends readonly unknown[], TReturn>(
  config: ToolWrapperConfig,
  toolName: string,
  fn: (...args: TArgs) => TReturn | Promise<TReturn>,
  options?: { metadata?: Record<string, unknown> }
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    const startedAt = new Date().toISOString();
    const start = Date.now();

    let result: TReturn;
    let error: string | null = null;

    try {
      result = await Promise.resolve(fn(...args));
      const durationMs = Date.now() - start;

      // Fire-and-forget recording so the wrapped function's latency
      // isn't affected by SignalVault's network call.
      void config
        .recordFn({
          toolName,
          toolInput: serializeArgs(args),
          toolOutput: result,
          durationMs,
          startedAt,
          requestId: getCurrentRequestId() ?? null,
          metadata: options?.metadata,
        })
        .catch((err) => {
          if (config.debug) console.error('[SignalVault] tool record failed:', err);
        });

      return result;
    } catch (e) {
      const durationMs = Date.now() - start;
      error = e instanceof Error ? e.message : String(e);

      void config
        .recordFn({
          toolName,
          toolInput: serializeArgs(args),
          toolOutput: null,
          durationMs,
          error,
          startedAt,
          requestId: getCurrentRequestId() ?? null,
          metadata: options?.metadata,
        })
        .catch((err) => {
          if (config.debug) console.error('[SignalVault] tool record failed:', err);
        });

      throw e;
    }
  };
}

// ---------------------------------------------------------------------------
// Sanitization helpers
// ---------------------------------------------------------------------------

/**
 * Returns the byte length of a string when encoded as UTF-8.
 * Used to enforce server-side byte limits accurately on the client.
 */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Truncates a string to `max` UTF-8 bytes, preserving multi-byte boundaries.
 * Appends a "(…N bytes truncated)" marker so the receiver knows truncation
 * happened rather than seeing a silently shortened string.
 */
function truncateString(s: string, max: number): string {
  if (byteLength(s) <= max) return s;
  const marker = (n: number) => ` …(truncated ${n} bytes)`;
  // Reserve room for the marker — sized to fit the worst-case marker.
  const reserve = byteLength(marker(99_999_999));
  const buf = Buffer.from(s, 'utf8');
  const truncatedBytes = buf.byteLength - (max - reserve);
  const sliced = buf.subarray(0, max - reserve).toString('utf8');
  // Cleanup: drop a trailing replacement char if we cut a multi-byte sequence.
  const cleaned = sliced.endsWith('�') ? sliced.slice(0, -1) : sliced;
  return cleaned + marker(truncatedBytes);
}

/** Validates and normalizes a tool name. Throws if missing or non-string. */
export function validateToolName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('[SignalVault] toolName must be a non-empty string');
  }
  return byteLength(name) > MAX_TOOL_NAME_BYTES
    ? truncateString(name, MAX_TOOL_NAME_BYTES)
    : name;
}

/** Truncates an error string to the server-accepted byte limit. */
export function sanitizeError(err: unknown): string | undefined {
  if (err === null || err === undefined) return undefined;
  const s = typeof err === 'string' ? err : String(err);
  return truncateString(s, MAX_ERROR_BYTES);
}

/**
 * Returns a JSON-safe version of `value`, capped at MAX_PAYLOAD_BYTES.
 *
 * - Circular references, BigInt, functions, Symbols → replaced with a marker
 *   object so the audit event is still useful instead of dropped silently.
 * - Oversized values → truncated; the marker `_signalvault_truncated` is set
 *   so the receiver can detect partial captures.
 *
 * Never throws — sanitization failures degrade gracefully.
 */
export function sanitizePayload(value: unknown): unknown {
  if (value === undefined) return null;

  let serialized: string;
  try {
    serialized = JSON.stringify(value, replacer());
  } catch (e) {
    return {
      _signalvault_serialization_error: e instanceof Error ? e.message : String(e),
    };
  }

  // JSON.stringify returns undefined for top-level functions/Symbols/undefined.
  if (serialized === undefined) {
    return { _signalvault_serialization_error: 'value is not JSON-serializable' };
  }

  if (byteLength(serialized) <= MAX_PAYLOAD_BYTES) {
    // Re-parse so the body is sent as a structured value, not a JSON string.
    try {
      return JSON.parse(serialized);
    } catch {
      return { _signalvault_serialization_error: 're-parse failed' };
    }
  }

  // Oversized: include the original byte size so debugging is possible.
  return {
    _signalvault_truncated: true,
    _signalvault_original_bytes: byteLength(serialized),
    _signalvault_max_bytes: MAX_PAYLOAD_BYTES,
    preview: truncateString(serialized, MAX_PAYLOAD_BYTES - 200),
  };
}

/**
 * JSON.stringify replacer that handles circular refs, BigInts, and other
 * non-serializable values by substituting markers instead of throwing.
 */
function replacer() {
  const seen = new WeakSet<object>();
  return function (this: unknown, _key: string, value: unknown): unknown {
    if (typeof value === 'bigint') return `${value.toString()}n`;
    if (typeof value === 'function') return '[Function]';
    if (typeof value === 'symbol') return value.toString();
    if (value !== null && typeof value === 'object') {
      if (seen.has(value as object)) return '[Circular]';
      seen.add(value as object);
    }
    return value;
  };
}

/**
 * If the wrapped function takes a single argument, store that value directly
 * (the common case). Otherwise store the whole args array. This avoids storing
 * `[{...}]` when callers pass a single object — better for dashboard rendering.
 */
function serializeArgs(args: readonly unknown[]): unknown {
  if (args.length === 0) return null;
  if (args.length === 1) return args[0];
  return args;
}
