# @signalvaultio/signalvault-node

AI audit logs and guardrails for your OpenAI applications.

## Installation

```bash
npm install @signalvaultio/signalvault-node openai
```

## Quick Start

```typescript
import SignalVaultClient from '@signalvaultio/signalvault-node';

const client = new SignalVaultClient({
  apiKey: 'sk_live_your_signalvault_key',    // Your SignalVault API key
  openaiApiKey: process.env.OPENAI_API_KEY!, // Your OpenAI API key
  baseUrl: 'https://api.signalvault.io',     // SignalVault API URL
  environment: 'production',
});

// Use exactly like OpenAI SDK — all calls are logged and guarded
const response = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0].message.content);
```

## Streaming

Streaming responses are fully supported. SignalVault logs the complete response once the stream finishes:

```typescript
const stream = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Write a poem' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

## Mirror Mode

In mirror mode, requests go directly to OpenAI first and SignalVault audits them asynchronously — no latency added, never blocks:

```typescript
const client = new SignalVaultClient({
  apiKey: 'sk_live_...',
  openaiApiKey: process.env.OPENAI_API_KEY!,
  mirrorMode: true,   // Monitor only, never block
});
```

## Features

- **Automatic Logging** — Every request and response is recorded in your SignalVault dashboard
- **Pre-flight Guardrails** — Block or redact requests before they reach OpenAI
- **PII Detection** — Automatically detect emails, phone numbers, SSNs in prompts
- **Secret Detection** — Block API keys and tokens in prompts
- **Token Limits** — Enforce cost controls per request
- **Model Allowlists** — Restrict which AI models can be used
- **Streaming Support** — Full support for streaming completions
- **Mirror Mode** — Observe without blocking (zero added latency)

## Configuration

```typescript
const client = new SignalVaultClient({
  apiKey: 'sk_live_...',          // Your SignalVault API key
  openaiApiKey: 'sk-...',         // Your OpenAI API key
  baseUrl: 'https://api.signalvault.io', // SignalVault API URL
  environment: 'production',      // 'development' | 'staging' | 'production'
  debug: false,                   // Enable debug logging
  mirrorMode: false,              // Monitor-only mode
});
```

## Error Handling

If a request is blocked by a guardrail, an error will be thrown:

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
