import * as fs from 'fs';
import * as path from 'path';
import {
  SDK_VERSION,
  SignalVaultBlockedError,
  SignalVaultClient,
  SignalVaultConfig,
  SignalVaultUnavailableError,
  normalizeBaseUrl,
} from '../index';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/**
 * Stubs global fetch. `replies` maps an event type to the replies returned
 * for successive calls of that type; unmatched calls get 200 {}.
 */
function stubFetch(replies: Record<string, Reply[]> = {}) {
  const calls: Array<{ body: any; init: RequestInit }> = [];
  const spy = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    calls.push({ body, init: init as RequestInit });
    const reply = replies[body.type]?.shift() ?? { status: 200, body: {} };
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
    return new Response(text, { status: reply.status, headers: reply.headers });
  });
  return { calls, spy, types: () => calls.map((c) => c.body.type) };
}

function openaiStub(chunks?: unknown[]) {
  const sent: any[] = [];
  return {
    sent,
    client: {
      chat: {
        completions: {
          create: async (params: any) => {
            sent.push(params);
            if (params.stream) {
              return (async function* () {
                for (const c of chunks ?? []) yield c;
              })();
            }
            return {
              choices: [{ message: { content: 'hello' } }],
              usage: { prompt_tokens: 3, completion_tokens: 1 },
            };
          },
        },
      },
    },
  };
}

/** Clients from makeClient(); their queues are emptied after each test so no retry outlives it. */
const clients: SignalVaultClient[] = [];

function makeClient(config: Partial<SignalVaultConfig> = {}) {
  const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake', ...config });
  const openai = openaiStub();
  (client as any).openai = openai.client;
  clients.push(client);
  return { client, openai };
}

/**
 * Fake timers for the retry backoff. Microtasks and setImmediate stay real:
 * Response bodies need them. Math.random is pinned so the jitter takes
 * nothing off and each backoff is exact: 4s, 8s, 16s, 32s, 60s.
 */
function fakeTimers() {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  jest.spyOn(Math, 'random').mockReturnValue(1);
}

const allow = { status: 200, body: { decision: 'allow', violations: [], redactions: [] } };
const messages = [{ role: 'user' as const, content: 'hi' }];
const dropWarnings = (): string[] => warnSpy.mock.calls.map((c) => c[0]).filter((m) => /Dropped/.test(m));
const responsesOf = (f: ReturnType<typeof stubFetch>) => f.calls.filter((c) => c.body.type === 'ai.response');

let warnSpy: jest.SpyInstance;
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  for (const client of clients.splice(0)) (client as any).queue.abandon('exit');
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('baseUrl', () => {
  it('accepts https and localhost http', () => {
    expect(normalizeBaseUrl('https://api.signalvault.io/')).toBe('https://api.signalvault.io');
    expect(normalizeBaseUrl('http://localhost:4000')).toBe('http://localhost:4000');
    expect(normalizeBaseUrl('http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000');
  });

  it('refuses plaintext http to remote hosts', () => {
    expect(() => makeClient({ baseUrl: 'http://api.signalvault.io' })).toThrow(/must use https/);
  });

  it('refuses a query string or fragment', () => {
    expect(() => normalizeBaseUrl('https://api.signalvault.io?x=1')).toThrow(/query or fragment/);
    expect(() => normalizeBaseUrl('https://api.signalvault.io#frag')).toThrow(/query or fragment/);
  });

  it('refuses invalid URLs and other schemes', () => {
    expect(() => normalizeBaseUrl('api.signalvault.io')).toThrow(/not a valid URL/);
    expect(() => normalizeBaseUrl('ftp://api.signalvault.io')).toThrow(/https/);
  });

  it('refuses credentials in the URL', () => {
    // fetch refuses such URLs, which failMode 'open' used to turn into "allow".
    expect(() => makeClient({ baseUrl: 'https://user:hunter2@api.signalvault.io' })).toThrow(/credentials/);
    expect(() => makeClient({ baseUrl: 'https://token@api.signalvault.io' })).toThrow(/credentials/);
  });

  it('never quotes the URL in errors', () => {
    for (const bad of ['hunter2', 'https://api.signalvault.io?key=hunter2', 'https://u:hunter2@api.signalvault.io']) {
      expect(() => normalizeBaseUrl(bad)).toThrow();
      try {
        normalizeBaseUrl(bad);
      } catch (e) {
        expect((e as Error).message).not.toContain('hunter2');
      }
    }
  });
});

describe('apiKey', () => {
  const block = {
    status: 200,
    body: {
      decision: 'block',
      violations: [{ rule_id: 'r1', type: 'contains_secret', severity: 9, action: 'block', details: {} }],
      redactions: [],
    },
  };

  it.each(['sk_test_abc\n', 'sk_test_abc\r\n', '  sk_test_abc ', '\tsk_test_abc', '﻿sk_test_abc'])(
    'strips surrounding whitespace and enforces a block (%j)',
    async (raw) => {
      // A key read from a file used to make every pre-flight fail locally,
      // which failMode 'open' turned into "allow".
      const f = stubFetch({ 'ai.request': [block] });
      const { client, openai } = makeClient({ apiKey: raw });
      await expect(client.chat.completions.create({ model: 'm', messages })).rejects.toBeInstanceOf(
        SignalVaultBlockedError
      );
      expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_abc');
      expect(openai.sent).toHaveLength(0);
    }
  );

  it.each([
    ['', /empty/],
    [' \n', /empty/],
    ['sk_test abc_SECRET', /whitespace/],
    ['sk_test\nabc_SECRET', /whitespace/],
    ['sk_test\u0000abc_SECRET', /control/],
    ['sk_test_abc_SECRETé', /non-ASCII/],
  ])('refuses %j without quoting it', (bad, pattern) => {
    expect(() => makeClient({ apiKey: bad })).toThrow(pattern);
    try {
      makeClient({ apiKey: bad });
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET');
    }
  });

  it('refuses a missing key', () => {
    expect(() => makeClient({ apiKey: undefined as unknown as string })).toThrow(/must be a string, got undefined/);
  });

  it('keeps the key out of debug output', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Shaped like undici's error for an invalid header value.
    const failure = new TypeError('fetch failed');
    (failure as any).cause = new Error('bad header "Bearer sk_test_abc"');
    jest.spyOn(global, 'fetch').mockRejectedValue(failure);
    const { client } = makeClient({ debug: true });
    await client.chat.completions.create({ model: 'm', messages });
    // The fallback ai.request's first attempt fails the same way.
    await new Promise((resolve) => setImmediate(resolve));

    const logged = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).toContain('Pre-flight failed: TypeError: fetch failed <- Error: bad header "Bearer [redacted]"');
    expect(logged).toContain('Event send failed: TypeError: fetch failed <- Error: bad header "Bearer [redacted]"');
    expect(logged).not.toContain('sk_test_abc');
  });
});

describe('request headers', () => {
  it('sends Accept, User-Agent and an event_id on background events', async () => {
    const f = stubFetch({ 'ai.request': [allow] });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await client.flush();

    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/json');
    expect(headers['User-Agent']).toMatch(/^signalvault-node\/\d+\.\d+\.\d+ node\//);
    expect(f.calls[0].init.redirect).toBe('manual');
    expect(f.calls[1].body.type).toBe('ai.response');
    expect(f.calls[1].body.event_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('SDK_VERSION matches package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

describe('pre-flight failures', () => {
  it.each([
    [401, { errors: { detail: 'Unauthorized' } }, /API key/],
    [402, { error: 'subscription_inactive' }, /not active/],
    [403, { error: 'environment_not_allowed' }, /denied access/],
    [429, { error: 'rate_limited' }, /rate limit/],
    [429, { error: { type: 'trial_limit_exceeded' } }, /trial limit/],
    [503, {}, /API error/],
  ])('fail-open warns loudly on %i (not only in debug)', async (status, body, pattern) => {
    stubFetch({ 'ai.request': [{ status, body }] });
    const { client, openai } = makeClient();

    await client.chat.completions.create({ model: 'm', messages });

    expect(openai.sent).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(pattern);
    expect(warnSpy.mock.calls[0][0]).toMatch(/NOT applied/);
  });

  it('warns at most once per minute for the same failure', async () => {
    stubFetch({ 'ai.request': [{ status: 401 }, { status: 401 }, { status: 401 }] });
    const { client } = makeClient();
    for (let i = 0; i < 3; i++) await client.chat.completions.create({ model: 'm', messages });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('fail-closed throws and never calls the provider', async () => {
    stubFetch({ 'ai.request': [{ status: 401 }] });
    const { client, openai } = makeClient({ failMode: 'closed' });

    await expect(client.chat.completions.create({ model: 'm', messages })).rejects.toBeInstanceOf(
      SignalVaultUnavailableError
    );
    expect(openai.sent).toHaveLength(0);
  });

  it('treats a non-JSON 200 as unavailable instead of crashing', async () => {
    stubFetch({ 'ai.request': [{ status: 200, body: '<html>maintenance</html>' }] });
    const { client, openai } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    expect(openai.sent).toHaveLength(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/invalid response/);
  });

  it('rejects an unknown failMode', () => {
    expect(() => makeClient({ failMode: 'maybe' as any })).toThrow(/failMode/);
  });
});

describe('fail_mode on the pre-flight', () => {
  it.each([
    [undefined, 'open'],
    ['open', 'open'],
    ['closed', 'closed'],
  ] as const)('is sent in the payload (failMode: %s)', async (failMode, expected) => {
    const f = stubFetch({ 'ai.request': [allow] });
    const { client } = makeClient({ failMode });
    await client.chat.completions.create({ model: 'm', messages });
    expect(f.calls[0].body.payload).toEqual({ messages, fail_mode: expected });
  });

  // Mirror mode never forwards on a decision, and the fallback ai.request is
  // a record of a call already made.
  it('is not sent on mirror-mode or fallback requests', async () => {
    const mirror = stubFetch();
    const { client } = makeClient({ mirrorMode: true });
    await client.chat.completions.create({ model: 'm', messages });
    await client.flush();
    expect(mirror.calls[0].body.payload).toEqual({ messages, monitor_mode: true });
    mirror.spy.mockRestore();

    const fallback = stubFetch({ 'ai.request': [{ status: 503 }] });
    await makeClient().client.chat.completions.create({ model: 'm', messages });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fallback.calls[1].body.payload).toEqual({ messages, preflight_unavailable: true, fail_mode: 'open' });
  });
});

// Over the app's rule-check rate limit the server stores the ai.request
// unchecked and answers 429 with `recorded: true`.
describe('pre-flight over the rule-check rate limit (429, recorded)', () => {
  const recorded = {
    status: 429,
    headers: { 'retry-after': '60' },
    body: {
      error: 'rate_limited', recorded: true, event_id: 'evt_1', decision: 'unchecked', reason: 'pre_flight_rate_limited',
    },
  };

  it('fail-open warns, forwards, and sends the response without a fallback ai.request', async () => {
    const f = stubFetch({ 'ai.request': [recorded] });
    const { client, openai } = makeClient();
    const completion = await client.chat.completions.create({ model: 'm', messages });
    await client.flush();

    expect(completion.choices[0].message.content).toBe('hello');
    expect(openai.sent).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(
      /rule-check rate limit reached \(429\)\. Guardrails were NOT applied.*still recorded in the audit log/
    );
    expect(f.types()).toEqual(['ai.request', 'ai.response']);
    expect(f.calls[1].body.request_id).toBe(f.calls[0].body.request_id);
    expect(f.calls[1].body.payload.output).toBe('hello');
  });

  it('fail-open, streaming: the response is sent when the stream ends', async () => {
    const f = stubFetch({ 'ai.request': [recorded] });
    const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake' });
    (client as any).openai = openaiStub([{ choices: [{ delta: { content: 'hi' } }] }]).client;
    const stream = await client.chat.completions.create({ model: 'm', messages, stream: true });
    for await (const _ of stream) void _;
    await client.flush();
    expect(f.types()).toEqual(['ai.request', 'ai.response']);
    expect(f.calls[1].body.payload.output).toBe('hi');
  });

  it('fail-closed throws SignalVaultUnavailableError and sends nothing else', async () => {
    const f = stubFetch({ 'ai.request': [recorded] });
    const { client, openai } = makeClient({ failMode: 'closed' });
    const err = await client.chat.completions.create({ model: 'm', messages }).catch((e) => e);
    await client.flush();

    expect(err).toBeInstanceOf(SignalVaultUnavailableError);
    expect(err.status).toBe(429);
    expect(err.requestId).toBe(f.calls[0].body.request_id);
    expect(err.message).toMatch(/rate limit.*Request not sent \(failMode: 'closed'\)/);
    expect(openai.sent).toHaveLength(0);
    expect(f.types()).toEqual(['ai.request']);
  });

  it.each([
    ['no recorded field', { error: 'rate_limited' }, /rate limit reached/],
    ['recorded: false', { error: 'rate_limited', recorded: false }, /rate limit reached/],
    ['recorded as a string', { error: 'rate_limited', recorded: 'true' }, /rate limit reached/],
    ['trial limit', { error: { type: 'trial_limit_exceeded' } }, /trial limit/],
  ])('a 429 with %s is handled as before: forwarded, no audit events', async (_label, body, pattern) => {
    const f = stubFetch({ 'ai.request': [{ status: 429, headers: { 'retry-after': '60' }, body }] });
    const { client, openai } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await client.flush();

    expect(openai.sent).toHaveLength(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(pattern);
    expect(warnSpy.mock.calls[0][0]).not.toMatch(/still recorded/);
    expect(f.types()).toEqual(['ai.request']);
  });

  it('a plain 429 still throws in fail-closed', async () => {
    stubFetch({ 'ai.request': [{ status: 429, body: { error: 'rate_limited' } }] });
    const { client, openai } = makeClient({ failMode: 'closed' });
    const err = await client.chat.completions.create({ model: 'm', messages }).catch((e) => e);
    expect(err).toBeInstanceOf(SignalVaultUnavailableError);
    expect(err.status).toBe(429);
    expect(openai.sent).toHaveLength(0);
  });
});

describe('decisions', () => {
  it('block throws SignalVaultBlockedError carrying violations and dashboard_url', async () => {
    const violations = [{ rule_id: 'r1', type: 'contains_secret', severity: 9, action: 'block', details: {} }];
    stubFetch({
      'ai.request': [{ status: 200, body: { decision: 'block', violations, redactions: [], dashboard_url: 'https://signalvault.io/x' } }],
    });
    const { client, openai } = makeClient();

    const err = await client.chat.completions.create({ model: 'm', messages }).catch((e) => e);
    expect(err).toBeInstanceOf(SignalVaultBlockedError);
    expect(err.message).toBe('[SignalVault] Request blocked by guardrails (contains_secret).');
    expect(err.violations).toEqual(violations);
    expect(err.dashboardUrl).toBe('https://signalvault.io/x');
    expect(openai.sent).toHaveLength(0);
  });

  it('parses redactions as an array and still sends the request unmodified', async () => {
    stubFetch({
      'ai.request': [{ status: 200, body: { decision: 'redact', violations: [], redactions: [{ type: 'contains_pii', count: 1 }] } }],
    });
    const { client, openai } = makeClient();
    const decision = await (client as any).sendRequest('r', 'm', messages, {}, 'openai');
    expect(decision.redactions).toEqual([{ type: 'contains_pii', count: 1 }]);

    await client.chat.completions.create({ model: 'm', messages });
    expect(openai.sent[0].messages).toEqual(messages);
  });
});

describe('Anthropic system prompt', () => {
  function anthropicClient() {
    const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake' });
    const sent: any[] = [];
    (client as any).anthropic = {
      messages: {
        create: async (p: any) => {
          sent.push(p);
          return {
            content: [
              { type: 'text', text: 'Let me check. ' },
              { type: 'tool_use', id: 't', name: 'lookup', input: {} },
              { type: 'text', text: 'Done.' },
            ],
            usage: { input_tokens: 5, output_tokens: 2 },
          };
        },
      },
    };
    return { client, sent };
  }

  it('is included in the pre-flight scan; the provider call is unchanged', async () => {
    const f = stubFetch({ 'ai.request': [allow] });
    const { client, sent } = anthropicClient();

    await client.messages.create({ model: 'claude', max_tokens: 5, system: 'SYS sk-secret', messages });
    await client.flush();

    expect(f.calls[0].body.payload.messages[0]).toEqual({ role: 'system', content: 'SYS sk-secret' });
    expect(sent[0].system).toBe('SYS sk-secret');
    expect(sent[0].messages).toEqual(messages);
  });

  it('records every text block of the response, not only the first', async () => {
    const f = stubFetch({ 'ai.request': [allow] });
    const { client } = anthropicClient();
    await client.messages.create({ model: 'claude', max_tokens: 5, messages });
    await client.flush();
    expect(f.calls[1].body.payload.output).toBe('Let me check. Done.');
  });
});

// The server reads Anthropic usage under Anthropic's names and adds the cache
// counts to the input. Under OpenAI's `prompt_tokens` it would take the count
// as already including them, so the SDK must not rename.
describe('Anthropic usage', () => {
  function usageClient(reply: { usage?: unknown; events?: unknown[] }, mirrorMode = false) {
    const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake', mirrorMode });
    (client as any).anthropic = {
      messages: {
        create: async (p: any) =>
          p.stream
            ? (async function* () {
                for (const e of reply.events ?? []) yield e;
              })()
            : { content: [{ type: 'text', text: 'ok' }], usage: reply.usage },
      },
    };
    return client;
  }

  async function recordedUsage(
    client: SignalVaultClient,
    f: ReturnType<typeof stubFetch>,
    opts: { stream?: boolean; breakAfter?: number } = {}
  ) {
    const result: any = await client.messages.create({
      model: 'claude', max_tokens: 5, messages, stream: opts.stream,
    });
    if (opts.stream) {
      let seen = 0;
      for await (const _ of result) {
        if (++seen === opts.breakAfter) break;
      }
    }
    await client.flush();
    return f.calls.find((c) => c.body.type === 'ai.response')?.body.payload.usage;
  }

  const cached = {
    input_tokens: 12,
    cache_creation_input_tokens: 2_000,
    cache_read_input_tokens: 90_000,
    output_tokens: 300,
  };
  const text = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } };

  it.each([false, true])('is sent under Anthropic names, with the cache counts (mirrorMode: %s)', async (mirrorMode) => {
    const f = stubFetch({ 'ai.request': [allow] });
    expect(await recordedUsage(usageClient({ usage: cached }, mirrorMode), f)).toEqual(cached);
  });

  it('leaves out cache counts that are null or missing, and defaults input and output to 0', async () => {
    const f = stubFetch({ 'ai.request': [allow] });
    const client = usageClient({ usage: { cache_creation_input_tokens: null, cache_read_input_tokens: 7 } });
    expect(await recordedUsage(client, f)).toEqual({
      input_tokens: 0, cache_read_input_tokens: 7, output_tokens: 0,
    });
  });

  // The server prices 1-hour cache writes from this breakdown.
  it('includes the cache_creation breakdown, without anything else in it', async () => {
    const f = stubFetch({ 'ai.request': [allow] });
    const client = usageClient({
      usage: {
        ...cached,
        cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 1_500, other: 1 },
        service_tier: 'standard',
      },
    });
    expect(await recordedUsage(client, f)).toEqual({
      ...cached,
      cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 1_500 },
    });
  });

  it('leaves out a cache_creation breakdown with no counts', async () => {
    const f = stubFetch({ 'ai.request': [allow] });
    const client = usageClient({
      usage: { ...cached, cache_creation: { ephemeral_5m_input_tokens: null } },
    });
    expect(await recordedUsage(client, f)).toEqual(cached);
  });

  it('is sent with zero counts when the response has no usage', async () => {
    const f = stubFetch({ 'ai.request': [allow] });
    expect(await recordedUsage(usageClient({}), f)).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('streaming: keeps the counts from message_start and takes output from message_delta', async () => {
    const f = stubFetch({ 'ai.request': [allow] });
    const client = usageClient({
      events: [
        { type: 'message_start', message: { usage: { ...cached, output_tokens: 1 } } },
        text,
        { type: 'message_delta', usage: { output_tokens: 300 } },
        { type: 'message_stop' },
      ],
    });
    expect(await recordedUsage(client, f, { stream: true })).toEqual(cached);
  });

  it('streaming: input and cache counts in message_delta override message_start', async () => {
    const f = stubFetch({ 'ai.request': [allow] });
    const client = usageClient({
      events: [
        { type: 'message_start', message: { usage: { input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 } } },
        text,
        { type: 'message_delta', usage: cached },
        { type: 'message_stop' },
      ],
    }, true);
    expect(await recordedUsage(client, f, { stream: true })).toEqual(cached);
  });

  it('streaming: a cache_creation breakdown in message_delta overrides message_start count by count', async () => {
    const f = stubFetch({ 'ai.request': [allow] });
    const client = usageClient({
      events: [
        {
          type: 'message_start',
          message: {
            usage: {
              ...cached,
              cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 0 },
            },
          },
        },
        text,
        { type: 'message_delta', usage: { output_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 5 } } },
        { type: 'message_stop' },
      ],
    });
    expect(await recordedUsage(client, f, { stream: true })).toEqual({
      ...cached,
      cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 5 },
    });
  });

  it('streaming: records the message_start counts when the consumer breaks out early', async () => {
    const f = stubFetch({ 'ai.request': [allow] });
    const client = usageClient({
      events: [
        { type: 'message_start', message: { usage: { ...cached, output_tokens: 1 } } },
        text,
        { type: 'message_delta', usage: { output_tokens: 300 } },
      ],
    });
    expect(await recordedUsage(client, f, { stream: true, breakAfter: 2 })).toEqual({
      ...cached, output_tokens: 1,
    });
  });
});

describe('mirror mode', () => {
  it('sends ai.request before ai.response, never concurrently', async () => {
    const order: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (_u, init) => {
      const type = JSON.parse((init as RequestInit).body as string).type;
      order.push(`start:${type}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end:${type}`);
      return new Response('{}', { status: 200 });
    });
    const { client } = makeClient({ mirrorMode: true });

    await client.chat.completions.create({ model: 'm', messages });
    await client.flush();

    expect(order).toEqual(['start:ai.request', 'end:ai.request', 'start:ai.response', 'end:ai.response']);
  });
});

describe('streaming', () => {
  const chunk = (t: string) => ({ choices: [{ delta: { content: t } }] });

  it('records the partial response when the consumer breaks out early', async () => {
    const f = stubFetch({ 'ai.request': [allow] });
    const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake' });
    (client as any).openai = openaiStub([chunk('a'), chunk('b'), chunk('c')]).client;

    const stream = await client.chat.completions.create({ model: 'm', messages, stream: true });
    for await (const _ of stream) break;
    await client.flush();

    const response = f.calls.find((c) => c.body.type === 'ai.response');
    expect(response?.body.payload.output).toBe('a');
  });
});

describe('background delivery', () => {
  it('does not wait for the response event before returning the completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    jest.spyOn(global, 'fetch').mockImplementation(async (_u, init) => {
      const type = JSON.parse((init as RequestInit).body as string).type;
      if (type === 'ai.response') await gate;
      return new Response(JSON.stringify(allow.body), { status: 200 });
    });
    const { client } = makeClient();

    const outcome = await Promise.race([
      client.chat.completions.create({ model: 'm', messages }).then((c) => c.choices[0].message.content),
      new Promise((resolve) => setTimeout(() => resolve('blocked on the response event'), 500)),
    ]);
    expect(outcome).toBe('hello');
    release();
    await client.flush();
  });

  it('flush() retries a 503 at once, with the same event_id', async () => {
    const f = stubFetch({ 'ai.request': [allow], 'ai.response': [{ status: 503 }, { status: 200 }] });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await client.flush();

    const responses = f.calls.filter((c) => c.body.type === 'ai.response');
    expect(responses).toHaveLength(2);
    expect(responses[0].body.event_id).toBe(responses[1].body.event_id);
  });

  it('flush() waits for pending tool events', async () => {
    let delivered = false;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      delivered = true;
      return new Response('{}', { status: 200 });
    });
    const { client } = makeClient();
    await client.tool('t', async () => 1)();
    expect(delivered).toBe(false);
    await client.flush();
    expect(delivered).toBe(true);
  });
});

describe('audit when the pre-flight got no decision', () => {
  it('records the request (deduplicated by request_id) before the response on 503', async () => {
    const f = stubFetch({ 'ai.request': [{ status: 503 }] });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await client.flush();

    expect(f.types()).toEqual(['ai.request', 'ai.request', 'ai.response']);
    const fallback = f.calls[1].body;
    expect(fallback.request_id).toBe(f.calls[0].body.request_id);
    expect(fallback.event_id).toBeUndefined();
    expect(fallback.payload).toEqual({ messages, preflight_unavailable: true, fail_mode: 'open' });
  });

  it('sends no audit events after the server refused the pre-flight (401)', async () => {
    const f = stubFetch({ 'ai.request': [{ status: 401 }] });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await client.flush();
    expect(f.types()).toEqual(['ai.request']);
  });
});

describe('failure classification', () => {
  it('reports a redirect as a baseUrl problem', async () => {
    stubFetch({ 'ai.request': [{ status: 307, headers: { location: 'https://elsewhere' } }] });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    expect(warnSpy.mock.calls[0][0]).toMatch(/redirected \(307\).*baseUrl/);
  });

  it('reports a timeout as a timeout, and fail-closed throws on it', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const open = makeClient();
    await open.client.chat.completions.create({ model: 'm', messages });
    expect(warnSpy.mock.calls[0][0]).toMatch(/timed out after 2000ms/);

    const closed = makeClient({ failMode: 'closed' });
    await expect(closed.client.chat.completions.create({ model: 'm', messages })).rejects.toBeInstanceOf(
      SignalVaultUnavailableError
    );
    expect(closed.openai.sent).toHaveLength(0);
  });

  it('fail-closed throws on a network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const { client, openai } = makeClient({ failMode: 'closed' });
    const err = await client.chat.completions.create({ model: 'm', messages }).catch((e) => e);
    expect(err).toBeInstanceOf(SignalVaultUnavailableError);
    expect(err.message).toMatch(/unreachable/);
    expect(openai.sent).toHaveLength(0);
  });

  it('survives malformed violations in a block decision', async () => {
    stubFetch({
      'ai.request': [{ status: 200, body: { decision: 'block', violations: [null, 7, { type: 9 }, { type: 'pii' }] } }],
    });
    const { client } = makeClient();
    const err = await client.chat.completions.create({ model: 'm', messages }).catch((e) => e);
    expect(err).toBeInstanceOf(SignalVaultBlockedError);
    expect(err.message).toBe('[SignalVault] Request blocked by guardrails (9, pii).');
  });
});

describe('background retry policy', () => {
  beforeEach(fakeTimers);

  it('retries 5xx with exponential backoff, keeping the event_id', async () => {
    const f = stubFetch({
      'ai.request': [allow],
      'ai.response': [{ status: 503 }, { status: 502 }, { status: 500 }, { status: 200 }],
    });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(0);
    expect(responsesOf(f)).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(3_999);
    expect(responsesOf(f)).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(responsesOf(f)).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(8_000);
    expect(responsesOf(f)).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(16_000);
    expect(responsesOf(f)).toHaveLength(4);
    await jest.advanceTimersByTimeAsync(300_000);
    expect(responsesOf(f)).toHaveLength(4);

    expect(new Set(responsesOf(f).map((c) => c.body.event_id)).size).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('honours Retry-After on 429, capped at 60 seconds, without warning', async () => {
    const f = stubFetch({
      'ai.request': [allow],
      'ai.response': [
        { status: 429, headers: { 'retry-after': '30' } },
        { status: 429, headers: { 'retry-after': '3600' } },
        { status: 200 },
      ],
    });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(29_999);
    expect(responsesOf(f)).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(responsesOf(f)).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(59_999);
    expect(responsesOf(f)).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(responsesOf(f)).toHaveLength(3);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('retries network errors and timeouts with the same event_id', async () => {
    const failures = [new TypeError('fetch failed'), new DOMException('timed out', 'TimeoutError')];
    const ids: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (_u, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === 'ai.response') {
        ids.push(body.event_id);
        const failure = failures.shift();
        if (failure) throw failure;
      }
      return new Response(JSON.stringify(allow.body), { status: 200 });
    });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(4_000 + 8_000);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  it('drops an event after 6 attempts, and only then warns', async () => {
    const f = stubFetch({ 'ai.request': [allow], 'ai.response': Array(10).fill({ status: 503 }) });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(4_000 + 8_000 + 16_000 + 32_000);
    expect(responsesOf(f)).toHaveLength(5);
    expect(dropWarnings()).toEqual([]);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(responsesOf(f)).toHaveLength(6);
    expect(dropWarnings()).toHaveLength(1);
    expect(dropWarnings()[0]).toBe(
      '[SignalVault] Dropped 1 audit event(s) (retries exhausted: 6 attempts, last: 503): ' +
        `event_id ${responsesOf(f)[0].body.event_id}. Dropped events are not in your audit log. ` +
        'Events queue up while SignalVault is unreachable or rate limiting this app. ' +
        'Counts by cause: client.droppedEvents.'
    );
    expect(client.droppedEvents).toEqual({ queueFull: 0, retriesExhausted: 1, exit: 0 });

    await jest.advanceTimersByTimeAsync(300_000);
    expect(responsesOf(f)).toHaveLength(6);
  });

  it.each([400, 401, 404, 422])('does not retry a %i', async (status) => {
    const f = stubFetch({ 'ai.request': [allow], 'ai.response': [{ status }, { status: 200 }] });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(300_000);
    expect(responsesOf(f)).toHaveLength(1);
    expect(dropWarnings()).toEqual([]);
  });

  it('retries the fallback ai.request without an event_id; the response follows once it lands', async () => {
    const f = stubFetch({ 'ai.request': [{ status: 503 }, { status: 503 }, { status: 200 }] });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(0);
    expect(f.types()).toEqual(['ai.request', 'ai.request']);

    await jest.advanceTimersByTimeAsync(4_000);
    expect(f.types()).toEqual(['ai.request', 'ai.request', 'ai.request', 'ai.response']);
    const [preflight, ...fallbacks] = f.calls.slice(0, 3).map((c) => c.body);
    for (const fallback of fallbacks) {
      expect(fallback.request_id).toBe(preflight.request_id);
      expect(fallback.event_id).toBeUndefined();
      expect(fallback.payload.preflight_unavailable).toBe(true);
    }
  });

  it('mirror mode: does not send the response when its request is dropped, and counts both', async () => {
    const f = stubFetch({ 'ai.request': Array(10).fill({ status: 503 }) });
    const { client } = makeClient({ mirrorMode: true });
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(300_000);
    expect(f.types()).toEqual(Array(6).fill('ai.request'));
    expect(dropWarnings()).toHaveLength(1);
    expect(dropWarnings()[0]).toMatch(
      new RegExp(`^\\[SignalVault\\] Dropped 2 audit event\\(s\\) \\(retries exhausted: 6 attempts, last: 503\\): ` +
        `event_id ${f.calls[0].body.event_id} and its ai.response, not sent\\.`)
    );
    expect(client.droppedEvents.retriesExhausted).toBe(2);
  });

  it('logs a dropped fallback ai.request by its request_id, which it has instead of an event_id', async () => {
    const f = stubFetch({ 'ai.request': Array(10).fill({ status: 503 }) });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(300_000);
    expect(f.types()).toEqual(Array(7).fill('ai.request')); // the pre-flight, then 6 attempts
    expect(dropWarnings()).toHaveLength(1);
    expect(dropWarnings()[0]).toContain(
      `Dropped 2 audit event(s) (retries exhausted: 6 attempts, last: 503): request_id ${f.calls[0].body.request_id} ` +
        '(fallback ai.request, which has no event_id) and its ai.response, not sent.'
    );
    expect(client.droppedEvents).toEqual({ queueFull: 0, retriesExhausted: 2, exit: 0 });
  });

  it('logs every drop with its id; only the explanation is rate limited', async () => {
    const f = stubFetch({ 'ai.request': [allow, allow], 'ai.response': Array(20).fill({ status: 503 }) });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(300_000);

    const ids = [...new Set(responsesOf(f).map((c) => c.body.event_id))];
    expect(ids).toHaveLength(2);
    expect(dropWarnings()).toHaveLength(2);
    ids.forEach((id) => expect(dropWarnings().some((m) => m.includes(`event_id ${id}.`))).toBe(true));
    expect(dropWarnings().filter((m) => m.includes('not in your audit log'))).toHaveLength(1);
    expect(client.droppedEvents.retriesExhausted).toBe(2);
  });

  it('droppedEvents is a read-only snapshot', () => {
    const { client } = makeClient();
    const counts = client.droppedEvents as { exit: number };
    counts.exit = 99;
    expect(client.droppedEvents).toEqual({ queueFull: 0, retriesExhausted: 0, exit: 0 });
  });

  it('tools.record() resolves after the first attempt; the event is retried in the background', async () => {
    const f = stubFetch({ 'agent.tool_call': [{ status: 503 }, { status: 200 }] });
    const { client } = makeClient();
    await client.tools.record({ toolName: 't', durationMs: 1 });
    expect(f.types()).toEqual(['agent.tool_call']);

    await jest.advanceTimersByTimeAsync(4_000);
    expect(f.types()).toEqual(['agent.tool_call', 'agent.tool_call']);
    expect(f.calls[0].body.event_id).toBe(f.calls[1].body.event_id);
  });
});

describe('retry timer', () => {
  it('is unref\'d, so a waiting retry never keeps the process alive', async () => {
    stubFetch({ 'ai.request': [allow], 'ai.response': [{ status: 503 }] });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await new Promise((resolve) => setImmediate(resolve));
    const timer = (client as any).queue.timer as NodeJS.Timeout;
    expect(timer).not.toBeNull();
    expect(timer.hasRef()).toBe(false);
  });
});

describe('queue overflow', () => {
  it('drops the oldest waiting event beyond 1,000, logging each with its event_id, and counts them', async () => {
    fakeTimers();
    let hold = true;
    const held: Array<() => void> = [];
    const sent: number[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (_u, init) => {
      sent.push(JSON.parse((init as RequestInit).body as string).payload.duration_ms);
      if (hold) await new Promise<void>((resolve) => held.push(resolve));
      return new Response('{}', { status: 200 });
    });
    const { client } = makeClient();
    const record = (n: number) => void client.tools.record({ toolName: 't', durationMs: n });
    const queued = () => (client as any).queue.pendingBodies() as Array<{ event_id: string; payload: any }>;
    const idOf = (n: number) => queued().find((b) => b.payload.duration_ms === n)!.event_id;

    // 16 in flight (held), then 1,000 waiting: full, nothing dropped yet.
    for (let n = 0; n < 1016; n++) record(n);
    expect(sent).toHaveLength(16);
    expect(dropWarnings()).toEqual([]);

    const dropped = [idOf(16), idOf(17), idOf(18)];
    record(1016); // drops 16, the oldest waiting
    expect(dropWarnings()).toEqual([
      '[SignalVault] Dropped 1 audit event(s) (queue full: 1000 events were waiting to be sent): ' +
        `event_id ${dropped[0]}. Dropped events are not in your audit log. ` +
        'Events queue up while SignalVault is unreachable or rate limiting this app. ' +
        'Counts by cause: client.droppedEvents.',
    ]);
    record(1017); // drops 17: logged with its id, without the explanation
    expect(dropWarnings()[1]).toBe(
      `[SignalVault] Dropped 1 audit event(s) (queue full: 1000 events were waiting to be sent): event_id ${dropped[1]}.`
    );
    jest.setSystemTime(Date.now() + 60_000);
    record(1018); // drops 18; the explanation is due again
    expect(dropWarnings()).toHaveLength(3);
    expect(dropWarnings()[2]).toContain(`event_id ${dropped[2]}. Dropped events are not in your audit log.`);
    expect(client.droppedEvents).toEqual({ queueFull: 3, retriesExhausted: 0, exit: 0 });

    hold = false;
    held.splice(0).forEach((release) => release());
    await client.flush();
    const expected = [...Array(1019).keys()].filter((n) => n < 16 || n > 18);
    expect(sent).toEqual(expected);
  });
});

describe('flush() and close()', () => {
  beforeEach(fakeTimers);

  it('flush() sends a waiting retry at once instead of waiting out the backoff', async () => {
    const f = stubFetch({ 'ai.request': [allow], 'ai.response': [{ status: 503 }, { status: 200 }] });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(0);
    await client.flush();
    expect(f.types()).toEqual(['ai.request', 'ai.response', 'ai.response']);
    expect((client as any).queue.size).toBe(0);
  });

  it('flush() returns at the deadline with a warning; the event stays queued and is retried', async () => {
    const f = stubFetch({ 'ai.request': [allow], 'ai.response': Array(10).fill({ status: 503 }) });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(0);

    const flushed = client.flush(1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    await flushed;
    expect(warnSpy.mock.calls.some((c) => /flush\(\) timed out with 1 audit event\(s\) still queued/.test(c[0]))).toBe(true);
    expect(dropWarnings()).toEqual([]);
    const attempts = f.types().filter((t) => t === 'ai.response').length;
    expect(attempts).toBe(2); // the first, and the one flush() started at once

    await jest.advanceTimersByTimeAsync(8_000);
    expect(f.types().filter((t) => t === 'ai.response')).toHaveLength(attempts + 1);
  });

  it('close() drops nothing: at the deadline it names what is still queued, which keeps being retried', async () => {
    const f = stubFetch({ 'ai.request': [allow], 'ai.response': [...Array(3).fill({ status: 503 }), { status: 200 }] });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(0);
    const id = responsesOf(f)[0].body.event_id;

    const closed = client.close(1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    await closed;
    expect(warnSpy.mock.calls.map((c) => c[0])).toContain(
      `[SignalVault] close() timed out with 1 audit event(s) still queued: event_id ${id}. ` +
        'They stay queued and are retried while the process runs; they are lost if it exits first.'
    );
    expect(dropWarnings()).toEqual([]);
    expect(client.droppedEvents).toEqual({ queueFull: 0, retriesExhausted: 0, exit: 0 });
    expect((client as any).queue.size).toBe(1);

    await jest.advanceTimersByTimeAsync(8_000 + 16_000);
    expect(responsesOf(f)).toHaveLength(4); // delivered on the fourth attempt
    expect((client as any).queue.size).toBe(0);
  });

  it('close() waits 10 seconds by default', async () => {
    stubFetch({ 'ai.request': [allow], 'ai.response': Array(10).fill({ status: 503 }) });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    let done = false;
    const closed = client.close().then(() => (done = true));
    await jest.advanceTimersByTimeAsync(9_999);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await closed;
    expect(done).toBe(true);
  });
});

describe('flush on process exit (beforeExit)', () => {
  beforeEach(fakeTimers);

  const beforeExit = () => process.emit('beforeExit', 0);

  it('sends queued events at once, without waiting out the backoff', async () => {
    const f = stubFetch({ 'ai.request': [allow], 'ai.response': [{ status: 503 }, { status: 200 }] });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(0);
    expect(responsesOf(f)).toHaveLength(1);

    beforeExit();
    await jest.advanceTimersByTimeAsync(0);
    expect(responsesOf(f)).toHaveLength(2);
    expect((client as any).queue.size).toBe(0);
    expect(dropWarnings()).toEqual([]);
  });

  it('is bounded by exitFlushTimeout; what is left is dropped, logged with its event_id and counted', async () => {
    const f = stubFetch({ 'ai.request': [allow], 'ai.response': Array(10).fill({ status: 503 }) });
    const { client } = makeClient({ exitFlushTimeout: 3_000 });
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(0);
    const id = responsesOf(f)[0].body.event_id;

    beforeExit();
    await jest.advanceTimersByTimeAsync(2_999);
    expect(dropWarnings()).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(dropWarnings()).toEqual([
      '[SignalVault] Dropped 1 audit event(s) (process exiting: not delivered within exitFlushTimeout (3000 ms)): ' +
        `event_id ${id}. Dropped events are not in your audit log. ` +
        'Call flush() before the process ends to deliver them. Counts by cause: client.droppedEvents.',
    ]);
    expect(client.droppedEvents).toEqual({ queueFull: 0, retriesExhausted: 0, exit: 1 });

    // Nothing is left to keep the process alive or retry.
    const attempts = responsesOf(f).length;
    beforeExit();
    await jest.advanceTimersByTimeAsync(300_000);
    expect(responsesOf(f)).toHaveLength(attempts);
    expect((client as any).queue.size).toBe(0);
  });

  it('exitFlushTimeout: 0 disables it', async () => {
    const f = stubFetch({ 'ai.request': [allow], 'ai.response': [{ status: 503 }, { status: 200 }] });
    const { client } = makeClient({ exitFlushTimeout: 0 });
    await client.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(0);

    beforeExit();
    await jest.advanceTimersByTimeAsync(0);
    expect(responsesOf(f)).toHaveLength(1);
    expect((SignalVaultClient as any).exitClients.has(client)).toBe(false);
  });

  it('adds one beforeExit listener per process, and holds a client only while it has events queued', async () => {
    const f = stubFetch({ 'ai.request': [allow, allow, allow], 'ai.response': [{ status: 503 }] });
    const first = makeClient().client;
    await first.chat.completions.create({ model: 'm', messages });
    await jest.advanceTimersByTimeAsync(0);
    const listeners = process.listenerCount('beforeExit');
    expect((SignalVaultClient as any).exitClients.has(first)).toBe(true);

    for (let i = 0; i < 2; i++) {
      const { client } = makeClient();
      await client.chat.completions.create({ model: 'm', messages });
      await jest.advanceTimersByTimeAsync(0);
      expect((SignalVaultClient as any).exitClients.has(client)).toBe(false); // delivered, idle
    }
    expect(process.listenerCount('beforeExit')).toBe(listeners);

    await first.flush();
    expect(responsesOf(f)).toHaveLength(4);
    expect((SignalVaultClient as any).exitClients.has(first)).toBe(false);
  });
});

describe('stream that throws', () => {
  it('records the partial output and rethrows', async () => {
    const f = stubFetch({ 'ai.request': [allow] });
    const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake' });
    (client as any).openai = {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield { choices: [{ delta: { content: 'par' } }] };
              throw new Error('connection reset');
            })(),
        },
      },
    };

    const stream = await client.chat.completions.create({ model: 'm', messages, stream: true });
    await expect(
      (async () => {
        for await (const _ of stream) void _;
      })()
    ).rejects.toThrow('connection reset');
    await client.flush();
    expect(f.calls.find((c) => c.body.type === 'ai.response')?.body.payload.output).toBe('par');
  });
});

describe('OpenAI streaming usage', () => {
  const content = (t: string) => ({ choices: [{ index: 0, delta: { content: t } }] });
  const usageChunk = { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } };

  function streamingClient(config: Partial<SignalVaultConfig> = {}) {
    const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake', ...config });
    const sent: any[] = [];
    (client as any).openai = {
      chat: {
        completions: {
          create: async (p: any) => {
            sent.push(p);
            const withUsage = p.stream_options?.include_usage === true;
            return (async function* () {
              yield content('Hel');
              yield content('lo');
              if (withUsage) yield usageChunk;
            })();
          },
        },
      },
    };
    return { client, sent };
  }

  async function collect(stream: AsyncIterable<any>) {
    const out: any[] = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
  }

  it.each([false, true])(
    'requests usage, hides the usage-only chunk, and records the tokens (mirrorMode: %s)',
    async (mirrorMode) => {
      const f = stubFetch({ 'ai.request': [allow] });
      const { client, sent } = streamingClient({ mirrorMode });
      const params = { model: 'm', messages, stream: true as const };

      const chunks = await collect(await client.chat.completions.create(params));
      await client.flush();

      expect(sent[0].stream_options).toEqual({ include_usage: true });
      expect(params).toEqual({ model: 'm', messages, stream: true }); // caller's object untouched
      expect(chunks).toHaveLength(2);
      expect(chunks.every((c) => c.choices[0].delta)).toBe(true);
      const response = f.calls.find((c) => c.body.type === 'ai.response')!.body;
      expect(response.payload.output).toBe('Hello');
      expect(response.payload.usage).toEqual({ prompt_tokens: 7, completion_tokens: 2 });
    }
  );

  it('passes the usage chunk through when the caller asked for it', async () => {
    stubFetch({ 'ai.request': [allow] });
    const { client } = streamingClient();
    const chunks = await collect(
      await client.chat.completions.create({
        model: 'm', messages, stream: true, stream_options: { include_usage: true },
      })
    );
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toEqual(usageChunk);
  });

  it('keeps the caller\'s other stream_options when adding include_usage', async () => {
    stubFetch({ 'ai.request': [allow] });
    const { client, sent } = streamingClient();
    await collect(
      await client.chat.completions.create({
        model: 'm', messages, stream: true, stream_options: { include_obfuscation: false } as any,
      })
    );
    expect(sent[0].stream_options).toEqual({ include_obfuscation: false, include_usage: true });
  });

  it('stream_options: null removes the key entirely (for servers that reject it)', async () => {
    stubFetch({ 'ai.request': [allow] });
    const { client, sent } = streamingClient();
    const chunks = await collect(
      await client.chat.completions.create({ model: 'm', messages, stream: true, stream_options: null })
    );
    expect('stream_options' in sent[0]).toBe(false);
    expect(chunks).toHaveLength(2);
  });

  it('hides an injected usage chunk that has no choices key at all', async () => {
    stubFetch({ 'ai.request': [allow] });
    const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake' });
    (client as any).openai = {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield content('Hi');
              yield { usage: { prompt_tokens: 1, completion_tokens: 1 } };
            })(),
        },
      },
    };
    const chunks = await collect(await client.chat.completions.create({ model: 'm', messages, stream: true }));
    expect(chunks).toHaveLength(1);
  });

  it('respects an explicit include_usage: false', async () => {
    const f = stubFetch({ 'ai.request': [allow] });
    const { client, sent } = streamingClient();
    await collect(
      await client.chat.completions.create({
        model: 'm', messages, stream: true, stream_options: { include_usage: false },
      })
    );
    await client.flush();
    expect(sent[0].stream_options).toEqual({ include_usage: false });
    expect(f.calls.find((c) => c.body.type === 'ai.response')!.body.payload.usage).toEqual({
      prompt_tokens: 0, completion_tokens: 0,
    });
  });

  it('does not add stream_options to non-streaming requests', async () => {
    stubFetch({ 'ai.request': [allow] });
    const { client, openai } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    expect(openai.sent[0].stream_options).toBeUndefined();
  });
});

describe('ESM entry point', () => {
  it('re-exports every runtime export of the CommonJS build', () => {
    const src = fs.readFileSync(path.join(__dirname, '../esm/index.mjs'), 'utf8');
    const block = src.match(/export \{([^}]*)\} from '\.\/index\.js'/);
    const esmNames = block![1].split(',').map((n) => n.trim()).filter(Boolean).sort();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cjsNames = Object.keys(require('../index')).filter((k) => k !== 'default' && k !== '__esModule').sort();
    expect(esmNames).toEqual(cjsNames);
  });
});
