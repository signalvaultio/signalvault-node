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

## Quick Start — OpenAI

```typescript
import SignalVaultClient from '@signalvaultio/node';

const client = new SignalVaultClient({
  apiKey: 'sk_live_your_signalvault_key',
  openaiApiKey: process.env.OPENAI_API_KEY!,
  baseUrl: 'https://api.signalvault.io',
  environment: 'production',
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

Streaming is fully supported for both providers. SignalVault logs the response when the stream ends — including a partial response if you stop iterating early:

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

For token counts on OpenAI streams, pass `stream_options: { include_usage: true }`. The SDK does not add it for you, because OpenAI then sends a final chunk with an empty `choices` array.

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

- `'open'` (default): the request goes to the provider **without** guardrails, and the SDK prints a warning (at most once a minute per cause, whether or not `debug` is on).
- `'closed'`: the SDK throws `SignalVaultUnavailableError` and the provider is never called.

```typescript
const client = new SignalVaultClient({
  apiKey: 'sk_live_...',
  openaiApiKey: process.env.OPENAI_API_KEY!,
  failMode: 'closed',      // 'open' | 'closed'. Default: 'open'
  preflightTimeout: 2000,  // ms — pre-flight check timeout. Default: 2000
  timeout: 10000,          // ms — background/post-flight calls. Default: 10000
});
```

Audit events (responses, mirror-mode events, tool calls) are sent in the background. Each carries an `event_id`, so a retry is never double-counted; the SDK retries once on network errors and 5xx, and on 429 when `Retry-After` is 5 seconds or less. The ingest API allows 120 events per minute per app.

## Shutting Down

Background events are queued in memory. Before a short-lived process exits (a script, a serverless handler), wait for them:

```typescript
await client.flush();   // or client.close(); both wait up to 5s by default
```

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
  timeout: 10000,                   // ms
  metadata: {},                     // Default metadata for all events
});
```

## Error Handling

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
