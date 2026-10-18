# Changelog

## 0.5.2 — 2026-10-18

Token counts for Anthropic prompt caching.

### Fixes

- **Cached tokens are counted for Anthropic.** Anthropic's `input_tokens` leaves out tokens written to or read from the prompt cache; those come in `cache_creation_input_tokens` and `cache_read_input_tokens`, which the SDK dropped. With prompt caching on, a request reading 90,000 tokens from the cache was recorded with a few dozen input tokens, so token budgets were barely enforced for it. Anthropic usage is now sent as Anthropic returns it (`input_tokens`, `output_tokens` and, when present, the two cache counts and the `cache_creation` breakdown of cache writes into 5-minute and 1-hour writes, which are priced differently), the same as SignalVault's Anthropic proxy records it, and SignalVault counts the cached tokens as input. For streams, counts in `message_delta` take precedence over `message_start`. If you read `ai.response` events from an export, Anthropic events now carry these names instead of `prompt_tokens` / `completion_tokens`. If you use prompt caching, expect higher input token counts for Anthropic. OpenAI events are unchanged. (#17)

## 0.5.1 — 2026-10-14

Security fix for invalid API keys and base URLs.

### Security

- **Invalid `apiKey` or `baseUrl` no longer turns guardrails off.** Each of these made every request to SignalVault fail before it was sent: an `apiKey` containing a line break, a control character or a character above U+00FF; a `baseUrl` with `user:password@`. With the default `failMode: 'open'`, every call then went to the provider without a guardrail check or an audit event, and the warning said the API was unreachable. A missing `apiKey` was sent as `Bearer undefined`. The constructor now strips surrounding whitespace from `apiKey`. It throws if the key is not a string, is empty, or contains whitespace, control or non-ASCII characters, and if `baseUrl` contains credentials. (GHSA-h7g7-7984-xjhm)
- **Debug output no longer shows the API key.** With `debug: true`, the raw fetch error was logged, and for an invalid key it quoted the `Authorization` header. Errors are now logged as one line with their causes and without the key. `baseUrl` errors no longer quote the URL you passed, which could contain credentials. (GHSA-h7g7-7984-xjhm)

## 0.5.0 — 2026-09-29

Packaging and compatibility release.

### Breaking changes

- **Package entry points are now defined by an `exports` map.** Only `@signalvaultio/node` and `@signalvaultio/node/package.json` can be imported. Deep imports such as `@signalvaultio/node/dist/index.js` or `@signalvaultio/node/dist/tools` no longer resolve; import from the package root instead. This is why this release is a minor version bump.
- **Under native ESM, the default import is now the client class.** In 0.4.0 it was the whole CommonJS `module.exports` object, so these workarounds stop working: `const { SignalVaultClient } = pkg`, `new pkg.default(...)`, and `pkg.SignalVaultBlockedError` / `pkg.SignalVaultUnavailableError` (an `instanceof` check against `undefined` throws a `TypeError`, and only when a request is actually blocked). Use `import SignalVaultClient from '@signalvaultio/node'`, or named imports: `import { SignalVaultClient, SignalVaultBlockedError } from '@signalvaultio/node'`. The same applies to `(await import('@signalvaultio/node')).default` from CommonJS. `require()` is unchanged.

### Fixes

- **Default import under native ESM.** `import SignalVaultClient from '@signalvaultio/node'` failed with "SignalVaultClient is not a constructor", because ESM received the whole CommonJS `module.exports` object. The package now has an ESM entry point, so the default import and named imports both work under native ESM, CommonJS `require()`, TypeScript (`node16` and `bundler` resolution) and bundlers. ESM and CommonJS share one copy of the SDK, so `withContext` works across both.
- **`openai` is no longer required at runtime for Anthropic-only use.** It was loaded at startup, so an install without `openai` failed with "Cannot find module 'openai'". Both provider SDKs are now loaded only when their API key is configured. Errors other than a missing package are no longer reported as "not installed". TypeScript projects without `openai` still need `skipLibCheck: true` (the default in most setups), because the type declarations refer to openai's types.
- **Token usage for OpenAI streams.** Streamed OpenAI requests were logged with zero tokens and zero cost. The SDK now sets `stream_options: { include_usage: true }` when you have not set `include_usage` yourself, records the usage, and consumes the extra usage-only chunk (empty `choices`) instead of passing it to your code. If you set `include_usage` yourself, your setting is kept and the chunk is passed through as before. If you point the openai SDK at an OpenAI-compatible server that rejects `stream_options`, pass `stream_options: null`: the SDK then sends no `stream_options` at all.

### Compatibility

- **`openai` peer range widened to `^4.4.0 || ^5.0.0 || ^6.0.0 || ^7.0.0`** (was `^4.0.0`). Installing alongside openai 5–7 no longer fails with ERESOLVE. Tested against 4.4.0 and the latest 4.x, 5.x, 6.x and 7.x; 4.0–4.3 work at runtime but lack the types the SDK's declarations use. openai 7 requires Node.js 22+.
- `@anthropic-ai/sdk` stays `>=0.20.0`, tested against 0.20.0 and the latest release.
- CI now installs the packed tarball into fresh ESM, CommonJS and TypeScript projects and runs real provider SDK calls against a local mock, across the supported provider versions, and re-runs weekly against the latest provider releases.

## 0.4.0 — 2026-09-28

Security and reliability release.

### Breaking changes

- **Default `baseUrl` is now `https://api.signalvault.io`** (was `http://localhost:4000`). Set `baseUrl` explicitly for local development.
- **Plain `http://` base URLs are refused** except for `localhost`, `127.0.0.1` and `::1`. The API key and prompts would otherwise travel unencrypted. A `baseUrl` with a query string or fragment is refused too.
- **Blocked requests throw `SignalVaultBlockedError`** with `violations`, `requestId` and `dashboardUrl` properties. The message no longer embeds the violations JSON; it lists the violation types.
- **`SignalVaultDecision.redactions`** is now `Array<{ type, count }>`, matching the API. Check `.length`, not truthiness.

### Security

- A failed guardrail check is no longer silent. An invalid key (401), inactive account (402), denied access (403), rate or trial limit (429), server error, timeout or invalid response now prints a warning (at most once a minute per cause) even with `debug: false`.
- New `failMode: 'open' | 'closed'` option. With `'closed'`, the SDK throws `SignalVaultUnavailableError` instead of calling the provider unchecked. Default stays `'open'`.
- The Anthropic `system` prompt is now included in the pre-flight scan and the audit record.
- Requests to SignalVault no longer follow redirects, so the API key is never re-sent to another URL.
- When the pre-flight check could not be completed (unreachable, timeout, 5xx, invalid response) and the request went ahead unchecked, the request is now recorded in the background, marked `preflight_unavailable`. Previously only the response was sent, which the API rejects, so these calls were missing from the audit log. After a refused check (401/402/403/429) no audit events are sent.
- Malformed decisions (for example a non-object violation) no longer throw a `TypeError` into the caller.

### Fixes

- Mirror mode sends `ai.request` before `ai.response` instead of concurrently, so response events are no longer lost to a race.
- Streams record the (partial) response when the consumer stops iterating early or the stream throws. A stream that is never iterated is not recorded.
- Timeouts are detected by error name, so they are classified correctly across realms (for example under Jest).
- Normal-mode non-streaming calls no longer wait for the response audit event before returning.
- Anthropic responses record every text block, not only the first.

### Added

- `flush()` / `close()` wait for queued audit events before a process exits.
- Every background event carries an `event_id`. The SDK retries once on connection errors and 5xx (not timeouts), and on 429 only when `Retry-After` is 5 seconds or less, which the SignalVault API does not currently send. `tools.record()` does not retry; its events also carry an `event_id`.
- `Accept: application/json` and `User-Agent: signalvault-node/<version>` headers.

### Other

- Dropped the `uuid` dependency in favour of `crypto.randomUUID`.
- Compiled tests are no longer included in the npm package.
- Added a LICENSE file.
