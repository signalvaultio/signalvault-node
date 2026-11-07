# @signalvaultio/node

AI audit logs and guardrails for your OpenAI and Anthropic applications.

> **Server-side only.** This SDK uses Node APIs (`async_hooks`, `fetch`) and
> requires Node.js **18+**. Do **not** bundle it for the browser — your
> `apiKey`, `openaiApiKey`, and `anthropicApiKey` would be exposed to end
> users. Always call SignalVault from your backend.

## Installation

```bash
# OpenAI only
npm install @signalvaultio/node openai

# Anthropic only
npm install @signalvaultio/node @anthropic-ai/sdk

# Both
npm install @signalvaultio/node openai @anthropic-ai/sdk
```

Supported provider SDKs: `openai` 4.4 through 7.x (openai 7 needs Node.js 22+) and `@anthropic-ai/sdk` 0.20 or later. Install only the one you use; the other is optional. TypeScript projects without `openai` need `skipLibCheck: true` (the default in most setups), because the SDK's type declarations refer to openai's types.

The package works with both `import` and `require()`:

```typescript
import SignalVaultClient from '@signalvaultio/node';          // ESM, TypeScript
import { SignalVaultClient } from '@signalvaultio/node';      // also works
const { SignalVaultClient } = require('@signalvaultio/node'); // CommonJS
```

Server-side bundlers (webpack, esbuild) are supported. esbuild's ESM output needs its usual `createRequire` banner for CommonJS dependencies: `--banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"`.

## Quick Start — OpenAI

```typescript
import SignalVaultClient from '@signalvaultio/node';

const client = new SignalVaultClient({
  apiKey: 'sk_live_your_signalvault_key',
  openaiApiKey: process.env.OPENAI_API_KEY!,
});

// Use exactly like OpenAI SDK
const response = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0].message.content);
```

## Quick Start — Anthropic

```typescript
const client = new SignalVaultClient({
  apiKey: 'sk_live_your_signalvault_key',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
  baseUrl: 'https://api.signalvault.io',
});

// Use exactly like Anthropic SDK
const response = await client.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  messages: [{ role: 'user', content: 'Hello!' }],
  max_tokens: 1024,
});

console.log(response.content[0].text);
```

## Streaming

Streaming is fully supported for both providers. SignalVault logs the response when the stream ends — including a partial response if you stop iterating early or the stream fails. A stream you drop without finishing it or breaking out of it (never iterated, or abandoned part-way) is logged when it is garbage collected, with the output read so far and `stream_abandoned: true` in the response payload. That can come late, or not at all if the process exits first, and `flush()` does not wait for it.

```typescript
// OpenAI streaming
const stream = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Write a poem' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}

// Anthropic streaming
const stream = await client.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  messages: [{ role: 'user', content: 'Write a poem' }],
  max_tokens: 1024,
  stream: true,
});

for await (const event of stream) {
  if (event.type === 'content_block_delta') {
    process.stdout.write(event.delta.text || '');
  }
}
```

For OpenAI streams, the SDK sets `stream_options: { include_usage: true }` so the response is logged with its token counts. OpenAI then sends one extra final chunk that carries only the usage and no choices; the SDK consumes that chunk rather than passing it to you, so the stream you receive looks the same as without usage reporting. If you set `stream_options.include_usage` yourself, your setting is kept: with `true` you receive the usage chunk as usual, with `false` the response is logged without token counts. If your OpenAI-compatible server rejects `stream_options`, pass `stream_options: null` and the SDK sends none.

## Agent Tool-Use Capture

Log every tool invocation made by your agents — name, input, output, duration, and any error — as auditable events alongside your LLM calls.

### Wrapper API (recommended)

```typescript
const fetchWeather = client.tool('fetch_weather', async (city: string) => {
  const res = await fetch(`https://api.example.com/weather?city=${city}`);
  return res.json();
});

// Call it like the original — SignalVault auto-times and audits
const weather = await fetchWeather('London');
```

The wrapper records the call asynchronously (no impact on your tool's latency) and passes the result through unchanged. Errors are recorded and rethrown.

### Manual API

```typescript
await client.tools.record({
  toolName: 'fetch_weather',
  toolInput: { city: 'London' },
  toolOutput: { temp: 12.3 },
  durationMs: 142,
});
```

### What gets captured (and what to keep out)

When you wrap a tool or call `tools.record()`, SignalVault captures:

- `tool_name` (truncated to 200 bytes)
- `tool_input` — the function arguments, JSON-serialized (capped at 256 KB; oversize values are truncated with a marker)
- `tool_output` — the function return value, JSON-serialized (same 256 KB cap)
- `error.message` if the tool throws (truncated to 1900 bytes)
- `duration_ms`, `started_at`, and any `metadata` you attach

`tool_input` and `tool_output` are encrypted at rest server-side. `tool_name`,
`error`, `started_at` and `metadata` are stored as sent, **not encrypted**. All of
it goes on the wire to SignalVault's API: **if you pass user PII, secrets, or API
keys as tool arguments, those values will leave your process and be stored in
SignalVault.** Recommendations:

- Sanitize sensitive arguments before invoking the wrapped tool, or use the
  manual `tools.record()` API and pass a redacted copy.
- Don't put secrets in error messages — they end up in `error` verbatim and unencrypted.
- Use `metadata` for non-sensitive identifiers (`user_id`, `feature`,
  `workspace_id`); avoid putting raw user content in metadata.

### Linking tool calls to a parent LLM turn

Wrap your agent loop in `withContext` and tool calls inside auto-correlate to the given `requestId`:

```typescript
await client.withContext({ requestId: 'agent-turn-abc' }, async () => {
  const llmResponse = await client.chat.completions.create({...});
  await fetchWeather('London'); // auto-linked to 'agent-turn-abc'
});
```

Without `withContext`, tool calls are recorded as orphans (no parent request).

## Metadata

Attach contextual metadata to every event — perfect for audit trails, user attribution, and analytics:

```typescript
// Set defaults at client level
const client = new SignalVaultClient({
  apiKey: 'sk_live_...',
  openaiApiKey: process.env.OPENAI_API_KEY!,
  metadata: { workspace_id: 'ws_abc', environment: 'production' },
});

// Override per-call
const response = await client.chat.completions.create(
  { model: 'gpt-4', messages: [...] },
  { metadata: { user_id: 'u_123', feature: 'support-chat' } }
);
```

## When SignalVault Is Unavailable

The pre-flight guardrail check is in your request's critical path. What the SDK does with its answer:

| Pre-flight answer | `failMode: 'open'` (default) | `failMode: 'closed'` |
|---|---|---|
| 2xx, `decision` `allow`, `warn` or `redact` | The provider is called. SignalVault stored the request with its decision; the response is recorded. | Same |
| 2xx, `decision: "block"` | The provider is **not** called. `SignalVaultBlockedError`. | Same |
| Any status whose body says `content_policy_violation` (as `error`, `error.code` or `error.type`), or any non-2xx body with `decision: "block"` | The provider is **not** called. `SignalVaultBlockedError`, with the violations and dashboard URL from the body when present. | Same |
| `429` with `recorded: true` (rule-check rate limit, `scan_timeout`, `unscanned_content`, any other reason) | The provider is called. SignalVault already stored the request unchecked; the SDK sends no second record; the response is recorded. The warning names the reason. | `SignalVaultUnavailableError`; the provider is not called. |
| Everything else: network error, timeout, 3xx, 400, 401, 402, 403, 404 and any other 4xx, 413, 422, `429` without `recorded: true` (trial limit, general rate limit), 5xx, a 2xx that is not valid JSON or has no valid `decision` | The provider is called, with a warning (at most once a minute per cause, whether or not `debug` is on). The SDK records the request itself: a fallback `ai.request` marked unchecked, with the status and reason. The response is recorded after it. | `SignalVaultUnavailableError`, with the HTTP `status` of an error answer; the provider is not called. |
| The request cannot be serialized to JSON for the check (a circular or `BigInt` value in the messages, metadata or model) | The provider is called. Fallback record as above, without the messages and metadata; reason `unserializable`, status `null`. | `SignalVaultUnavailableError`; the provider is not called. |

The fallback record has the request's `request_id`, and its payload carries `preflight_unavailable: true`, `fail_mode: 'open'`, `preflight_status` (the HTTP status, or `null` when there was none) and `preflight_reason`: `timeout`, `network`, `redirect`, `invalid_response` or `unserializable`, else SignalVault's error code, else `http_<status>`. It is queued before the provider call, so a provider call that throws or a stream you never read still leaves it, and it is retried on the background queue like other audit events (see [Delivery of Audit Events](#delivery-of-audit-events)). After a 400, 413, 422 or any other 4xx except 401, 402, 403 and 429, it leaves out the messages and metadata, which SignalVault refused. SignalVault refuses every event from a key it refuses: after a 401, 402 or 403 it refuses the record and the response too, which are not retried (see below); after the trial limit the record is retried, then dropped and logged (see [What is logged when events are dropped](#what-is-logged-when-events-are-dropped)).

**A refused key or account.** When SignalVault refuses a background event — the fallback record, a response, a tool call or a mirror-mode request — with 401, 402 or 403, it refuses every event sent with that key, and the SDK warns with `console.warn`, whether or not `debug` is on. Each of the three statuses warns once per process, whichever client sent the event. The warning names the status, SignalVault's error code, and what to check at signalvault.io: the API key (401), the account (402), or the key's environment and account (403):

```
[SignalVault] SignalVault refused an audit event (401): requests are not being recorded. Check the API key at signalvault.io.
```

The refused events are not retried. Other refusals of a background event (a 3xx, 400, 413, 422 or another 4xx) are logged only with `debug: true`, except a tool call's, which warns each time.

**No text from SignalVault's answer in messages.** A warning, an error message or a log line names SignalVault's error code (the answer's `error` when it is a string, else `error.code`, else `error.type`) only when it looks like a code: a lowercase letter, then up to 63 lowercase letters, digits or underscores. For example `SignalVault account is not active (402: subscription_inactive)` or `SignalVault denied access (403: environment_not_allowed)`; otherwise the bare status, such as `(402)`. The message of `SignalVaultBlockedError`, and the `debug` line for a `warn` decision, name only the violation types that look like codes, else `policy`; the error's `violations` keep what SignalVault sent. No other text from an answer appears in a message.

`failMode` applies to the pre-flight check, so it has no effect in mirror mode.

**Rate limits.** Rule checks — the pre-flight `ai.request` — are limited to 120 requests per minute per app. Over that limit, SignalVault stores the request unchecked, runs no rules on it and answers `429` with `recorded: true` (see the table). Tool calls are recorded as usual. The SDK sends its `failMode` with each pre-flight check (`payload.fail_mode`), so SignalVault records whether an unchecked request was sent to the provider. If every request must be checked, use `failMode: 'closed'`: requests over the limit are then refused instead of sent unchecked. Responses and tool calls do not use rule checks; mirror-mode requests do. Every event type shares one ceiling of 3,000 events per minute per app, and audit events are retried when it is reached (see below).

**Content the rules cannot read, and scans that do not finish.** When a rule that reads content is on (`contains_pii`, `contains_secret`, `keyword_blocklist`, `regex_match` or `prompt_injection`) and none of them has the action `block`, SignalVault records two more kinds of request unchecked and answers the same 429 with `recorded: true`, without `Retry-After`:

- a request carrying content the rules cannot read — an image, audio, a file, a PDF or a content type they do not know — with the reason `unscanned_content` (SignalVault 0.18.9 and later). The audit event names each content type;
- a request whose rule scan did not finish in time or stopped before the end of the text, with the reason `scan_timeout`.

`failMode` applies as above, and the warning, or the message of `SignalVaultUnavailableError`, gives the reason:

```
[SignalVault] The request carries content SignalVault's rules cannot read (an image, audio, a file, a PDF or a content type they do not know), so SignalVault recorded it unchecked (429: unscanned_content). Guardrails were NOT applied — it is being sent to the provider (failMode: 'open').
```

Under a `block` rule that reads content, such a request is blocked instead (see [Error Handling](#error-handling)).

```typescript
const client = new SignalVaultClient({
  apiKey: 'sk_live_...',
  openaiApiKey: process.env.OPENAI_API_KEY!,
  failMode: 'closed',      // 'open' | 'closed'. Default: 'open'
  preflightTimeout: 2000,  // ms — pre-flight check timeout. Default: 2000
  timeout: 10000,          // ms — each attempt to send an audit event. Default: 10000
});
```

## Delivery of Audit Events

Audit events (responses, tool calls, mirror-mode events, and the background record of a request whose check failed, described above) are sent in the background through an in-memory queue, so they never delay your call.

- **Retries.** A send that fails with a connection error, a timeout, a 5xx or a 429 is retried, up to 6 attempts over about two minutes. The wait doubles each time: 4, 8, 16, 32 and 60 seconds, each shortened by up to a quarter at random so that clients do not retry in step. When SignalVault sends `Retry-After`, the SDK waits that long instead, up to 60 seconds. Other 4xx responses are not retried, and neither is a 429 with `recorded: true`: SignalVault has stored the request, unchecked, and would answer a retry the same way, so it counts as delivered and its response is sent.
- **No double counting.** Each event carries an `event_id` that stays the same across retries, so SignalVault stores it once. The fallback request is de-duplicated by its `request_id`.
- **Order.** A response is sent after its request has been stored. If the request is dropped, its response is not sent.
- **Dropping is the last resort.** Up to 1,000 events can wait to be sent. Beyond that the oldest waiting event is dropped. An event is also dropped after its last attempt, and when the process exits before the exit flush (below) could deliver it. A dropped event is not in your audit log.
- **`tools.record()`** resolves after the first attempt. If that attempt failed and can be retried, the event stays in the queue and is retried like the others.

The retry timer never keeps your process alive on its own. When the process is about to exit, the exit flush below gives queued events a last chance.

### What is logged when events are dropped

Every drop prints one line with `console.warn`, whether or not `debug` is on, with the number of events, the cause and the id of each event, so you can find them in your own logs:

```
[SignalVault] Dropped 1 audit event(s) (retries exhausted: 6 attempts, last: 503): event_id 9dcf632e-271b-48b7-a772-b9afeee28fbb. Dropped events are not in your audit log. ...
```

These lines are never rate limited; only the explanation after the ids is printed at most once a minute per cause. An event is named by its `event_id`. The background record of a request whose check failed has no `event_id`, so it is named by its `request_id` and marked as such. When a request is dropped, the line also says that its response was not sent; the count includes it.

`client.droppedEvents` counts the events dropped since the client was created, by cause:

```typescript
client.droppedEvents; // { queueFull: 0, retriesExhausted: 0, exit: 0 }
```

- `queueFull`: dropped because 1,000 events were already waiting to be sent.
- `retriesExhausted`: dropped after the last of 6 attempts failed.
- `exit`: still undelivered when the exit flush reached `exitFlushTimeout`.

The object is a snapshot; read the property again for current counts.

## Shutting Down

**Call `flush()` before a short-lived process ends.** Scripts, CLIs, jobs and serverless handlers should not rely on the exit flush:

```typescript
await client.flush();       // waits up to 5 seconds
await client.flush(10_000); // or up to 10
```

`flush()` sends every queued event at once, including those waiting out a retry, and resolves when all of them are delivered or the deadline passes. At the deadline it prints a warning naming the events still queued; they stay in the queue and keep being retried while the process runs.

**Serverless functions** (AWS Lambda, Vercel, Google Cloud Functions and similar) are frozen or stopped as soon as the handler returns, so call `flush()` at the end of every invocation, not only at shutdown. Create the client outside the handler, so a warm instance reuses it:

```typescript
const client = new SignalVaultClient({
  apiKey: process.env.SIGNALVAULT_API_KEY!,
  openaiApiKey: process.env.OPENAI_API_KEY!,
});

export async function handler(event: { prompt: string }) {
  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: event.prompt }],
    });
    return { statusCode: 200, body: response.choices[0].message.content };
  } finally {
    await client.flush();
  }
}
```

The time `flush()` takes counts towards your function's duration: when SignalVault is reachable, it is the time to send the events still in flight. Pass a shorter deadline to bound it.

**Exit flush.** When a Node process is about to exit on its own because it has nothing left to do (Node's `beforeExit` event), the SDK flushes every client that still has events queued, for up to `exitFlushTimeout` (default 10,000 ms; `0` turns it off). Events still undelivered then are dropped and logged with their ids, and counted under `droppedEvents.exit`. `beforeExit` does **not** fire when you call `process.exit()`, when the process is killed by a signal (for example `SIGTERM` or Ctrl+C), on an uncaught exception, or when a serverless platform freezes the process. In those cases only an explicit `flush()` delivers queued events: call it before `process.exit()` and in your signal handlers.

```typescript
process.on('SIGTERM', async () => {
  await client.close();
  process.exit(0);
});
```

`close()` flushes like `flush()`, with a default deadline of 10 seconds. It drops nothing: events still undelivered at the deadline stay queued and keep being retried while the process runs, and a warning names how many there are and their ids. The client can still be used afterwards.

## Mirror Mode

In mirror mode, requests go directly to the AI provider first and SignalVault audits them asynchronously — no latency added, never blocks:

```typescript
const client = new SignalVaultClient({
  apiKey: 'sk_live_...',
  openaiApiKey: process.env.OPENAI_API_KEY!,
  mirrorMode: true,
});
```

## Features

- **Automatic Logging** — Requests and responses are recorded in your SignalVault audit log, in the background
- **Pre-flight Guardrails** — Block requests that break your rules before they reach the AI provider
- **Redaction at rest** — Rules with the `redact` action remove matches from what SignalVault stores. The request sent to the AI provider is **not** modified.
- **PII Detection** — Automatically detect emails, phone numbers, SSNs in prompts
- **Secret Detection** — Block API keys and tokens in prompts
- **Token Limits** — Enforce cost controls per request
- **Model Allowlists** — Restrict which AI models can be used
- **Streaming Support** — Full support for streaming completions (OpenAI + Anthropic)
- **Mirror Mode** — Observe without blocking (zero added latency)
- **Metadata** — Tag every event with user_id, feature, workspace_id, etc.
- **Multi-provider** — OpenAI and Anthropic/Claude support

## Configuration

```typescript
const client = new SignalVaultClient({
  apiKey: 'sk_live_...',            // Your SignalVault API key (required)
  openaiApiKey: 'sk-...',           // OpenAI API key (required for chat.completions)
  anthropicApiKey: 'sk-ant-...',    // Anthropic API key (required for messages)
  baseUrl: 'https://api.signalvault.io', // default; plain http:// only allowed for localhost
  environment: 'production',        // sent with events; the server uses the API key's environment
  debug: false,
  mirrorMode: false,
  failMode: 'open',                 // 'open' | 'closed' — see "When SignalVault Is Unavailable"
  preflightTimeout: 2000,           // ms
  timeout: 10000,                   // ms, per attempt to send an audit event
  exitFlushTimeout: 10000,          // ms to deliver queued events when the process exits on its own; 0 = off
  metadata: {},                     // Default metadata for all events
});
```

`environment` does not choose which rules apply: SignalVault uses the environment of the API key you pass as `apiKey`. Use a key created for the environment you want.

## Error Handling

When a guardrail rule blocks a request, `create()` throws `SignalVaultBlockedError` and the provider is never called. It carries:

- `violations` — the rules that matched, each with `rule_id`, `type` (for example `contains_secret`), `severity`, `action` and `details`
- `requestId` — the ID the SDK sent to SignalVault as `request_id` for this request
- `dashboardUrl` — a link to the blocked request, when the API provides one

The message lists only the violation types, never the matched content or other text from SignalVault's answer.

A request carrying content the rules cannot read, under a `block` rule that reads content, is blocked with a violation of type `unscanned_content_guard`; its `details` hold a `description` and `content_types`, naming each type (SignalVault 0.18.9 and later). One whose rule scan did not finish is blocked with `scan_timeout_guard`.

`SignalVaultUnavailableError` (with `requestId` and the HTTP `status`, if any) is thrown only with `failMode: 'closed'`, when no decision could be obtained.

```typescript
import { SignalVaultBlockedError, SignalVaultUnavailableError } from '@signalvaultio/node';

try {
  const response = await client.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'my SSN is 123-45-6789' }],
  });
} catch (error) {
  if (error instanceof SignalVaultBlockedError) {
    console.log('Blocked by guardrails:', error.violations.map((v) => v.type));
    console.log('Details:', error.dashboardUrl);
  } else if (error instanceof SignalVaultUnavailableError) {
    // Only thrown with failMode: 'closed'
    console.log('Guardrail check unavailable:', error.status);
  } else {
    throw error;
  }
}
```

## License

MIT
