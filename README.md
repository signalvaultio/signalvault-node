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

Streaming is fully supported for both providers. SignalVault logs the response when the stream ends — including a partial response if you stop iterating early or the stream fails. A stream you never iterate is not logged.

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

The pre-flight guardrail check is in your request's critical path. If it cannot return a decision — timeout, network error, invalid or revoked API key (401), inactive subscription (402), access denied (403), rate or trial limit (429), server error, or an invalid response — `failMode` decides what happens:

- `'open'` (default): the request goes to the provider **without** guardrails, and the SDK prints a warning (at most once a minute per cause, whether or not `debug` is on). If SignalVault was unreachable, timed out or errored, the request is still recorded in the background, marked `preflight_unavailable`, so it appears in your audit log.
- `'closed'`: the SDK throws `SignalVaultUnavailableError` and the provider is never called. Use this if every request must be checked.

`failMode` applies to the pre-flight check, so it has no effect in mirror mode.

**Rate limits.** Rule checks — the pre-flight `ai.request` — are limited to 120 requests per minute per app. Over that limit, SignalVault still records the request in your audit log, marked as unchecked, but runs no rules on it, so there is no decision and `failMode` applies:

- `'open'`: the request goes to the provider, the SDK warns that guardrails were not applied, and the response is recorded as usual, linked to the request. Tool calls are recorded as usual too.
- `'closed'`: the SDK throws `SignalVaultUnavailableError` with `status` 429, and the provider is never called.

The SDK sends its `failMode` with each pre-flight check (`payload.fail_mode`), so SignalVault records whether an unchecked request was sent to the provider. If every request must be checked, use `failMode: 'closed'`: requests over the limit are then refused instead of sent unchecked. Audit events — responses, tool calls, mirror-mode events — have a separate limit of 3,000 events per minute per app, and are retried when they reach it (see below). A pre-flight 429 for any other reason, such as the trial limit, is handled like the other refusals above, and no audit events are sent for that request.

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

- **Retries.** A send that fails with a connection error, a timeout, a 5xx or a 429 is retried, up to 6 attempts over about two minutes. The wait doubles each time: 4, 8, 16, 32 and 60 seconds, each shortened by up to a quarter at random so that clients do not retry in step. When SignalVault sends `Retry-After`, the SDK waits that long instead, up to 60 seconds. Other 4xx responses are not retried.
- **No double counting.** Each event carries an `event_id` that stays the same across retries, so SignalVault stores it once. The fallback request is de-duplicated by its `request_id`.
- **Order.** A response is sent after its request has been stored. If the request is dropped, its response is not sent.
- **Dropping is the last resort.** Up to 1,000 events can wait to be sent. Beyond that the oldest waiting event is dropped, and an event is also dropped after its last attempt. Either way the SDK prints a warning with the number of events lost (at most once a minute per cause, whether or not `debug` is on). A dropped event is not in your audit log.
- **`tools.record()`** resolves after the first attempt. If that attempt failed and can be retried, the event stays in the queue and is retried like the others.

The queue never keeps your process alive: a pending retry does not stop Node from exiting. Use `flush()` to wait for it.

## Shutting Down

Before a short-lived process exits, wait for the queue:

```typescript
await client.flush();       // waits up to 5 seconds
await client.flush(10_000); // or up to 10
```

`flush()` sends every queued event at once, including those waiting out a retry, and resolves when all of them are delivered or the deadline passes. At the deadline it prints a warning; the events still queued stay in the queue and keep being retried while the process runs.

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

`close()` flushes the same way, then drops whatever is still undelivered, with a warning, and stops retrying it. Use it when a long-running process shuts down. The client can still be used afterwards.

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

- **Automatic Logging** — Every request and response is recorded in your SignalVault dashboard
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
  metadata: {},                     // Default metadata for all events
});
```

`environment` does not choose which rules apply: SignalVault uses the environment of the API key you pass as `apiKey`. Use a key created for the environment you want.

## Error Handling

When a guardrail rule blocks a request, `create()` throws `SignalVaultBlockedError` and the provider is never called. It carries:

- `violations` — the rules that matched, each with `rule_id`, `type` (for example `contains_secret`), `severity`, `action` and `details`
- `requestId` — the ID the SDK sent to SignalVault as `request_id` for this request
- `dashboardUrl` — a link to the blocked request, when the API provides one

The message lists only the violation types, never the matched content.

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
