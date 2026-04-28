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

Streaming is fully supported for both providers. SignalVault logs the complete response once the stream finishes:

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

These fields are stored encrypted at rest server-side, but they go on the wire
to SignalVault's API. **If you pass user PII, secrets, or API keys as tool
arguments, those values will leave your process and be stored in SignalVault.**
Recommendations:

- Sanitize sensitive arguments before invoking the wrapped tool, or use the
  manual `tools.record()` API and pass a redacted copy.
- Don't put secrets in error messages — they end up in `error` verbatim.
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

## Timeout Configuration

The pre-flight guardrail check is in your request's critical path. SignalVaultClient uses a short timeout and **fails open** — your request always goes through even if the SignalVault API is slow or unreachable:

```typescript
const client = new SignalVaultClient({
  apiKey: 'sk_live_...',
  openaiApiKey: process.env.OPENAI_API_KEY!,
  preflightTimeout: 2000,  // ms — pre-flight check timeout (fails open). Default: 2000
  timeout: 10000,          // ms — background/post-flight calls. Default: 10000
});
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
- **Pre-flight Guardrails** — Block or redact requests before they reach the AI provider
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
  baseUrl: 'https://api.signalvault.io',
  environment: 'production',        // 'development' | 'staging' | 'production'
  debug: false,
  mirrorMode: false,
  preflightTimeout: 2000,           // ms
  timeout: 10000,                   // ms
  metadata: {},                     // Default metadata for all events
});
```

## Error Handling

```typescript
try {
  const response = await client.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'my SSN is 123-45-6789' }],
  });
} catch (error) {
  if (error.message.includes('[SignalVault]')) {
    console.log('Request blocked by guardrail');
  }
}
```

## License

MIT
