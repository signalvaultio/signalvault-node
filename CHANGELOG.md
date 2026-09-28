# Changelog

## 0.4.0

Security and reliability release.

### Breaking changes

- **Default `baseUrl` is now `https://api.signalvault.io`** (was `http://localhost:4000`). Set `baseUrl` explicitly for local development.
- **Plain `http://` base URLs are refused** except for `localhost`, `127.0.0.1` and `::1`. The API key and prompts would otherwise travel unencrypted.
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
