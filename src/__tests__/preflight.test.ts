import {
  FailMode,
  SignalVaultBlockedError,
  SignalVaultClient,
  SignalVaultUnavailableError,
} from '../index';

// What the SDK does with each answer to the pre-flight check, in both fail
// modes. Every test checks whether the provider was called, what the caller
// got, and exactly which events SignalVault received.

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Form = 'full' | 'minimal';

const messages = [{ role: 'user' as const, content: 'hi' }];
const METADATA = { user_id: 'u_1' };
const MODEL = 'gpt-4o';

/** Clients from setup(); their queues are emptied after each test so no retry outlives it. */
const clients: SignalVaultClient[] = [];
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const client of clients.splice(0)) (client as any).queue.abandon('exit');
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const warnings = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));

/**
 * 'preflight', 'fallback' (the SDK's own record of a request whose check got
 * no decision), or the event type.
 */
function roleOf(body: any): string {
  if (body.type !== 'ai.request') return body.type;
  return body.payload?.preflight_unavailable === true ? 'fallback' : 'preflight';
}

interface Options {
  failMode?: FailMode;
  provider?: 'openai' | 'anthropic';
  /** Thrown by the provider call. */
  providerError?: Error;
  /** The answer to every fallback ai.request. Default: 200 {}. */
  fallbackReply?: Reply;
}

/**
 * A client whose pre-flight is answered with `preflight`; every other event
 * gets 200 {} (or `fallbackReply`). `timeline` holds the SignalVault events
 * and the provider call ('provider') in the order they happened.
 */
function setup(preflight: Reply | Error, options: Options = {}) {
  const timeline: string[] = [];
  const received: any[] = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    const role = roleOf(body);
    timeline.push(role);
    received.push(body);
    let reply: Reply = { status: 200, body: {} };
    if (role === 'preflight') {
      // Not `instanceof Error`: a DOMException fails it across realms under Jest.
      if (typeof (preflight as Reply).status !== 'number') throw preflight;
      reply = preflight as Reply;
    } else if (role === 'fallback' && options.fallbackReply) {
      reply = options.fallbackReply;
    }
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
    return new Response(text, { status: reply.status, headers: reply.headers });
  });

  const client = new SignalVaultClient({
    apiKey: 'sk_test_abc',
    openaiApiKey: 'sk-fake',
    failMode: options.failMode,
    metadata: METADATA,
  });
  clients.push(client);

  const sent: any[] = [];
  const provider = async (params: any, result: unknown, chunks: unknown[]) => {
    timeline.push('provider');
    sent.push(params);
    if (options.providerError) throw options.providerError;
    if (!params.stream) return result;
    return (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
  };
  (client as any).openai = {
    chat: {
      completions: {
        create: (params: any) =>
          provider(
            params,
            { choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
            [{ choices: [{ delta: { content: 'hel' } }] }, { choices: [{ delta: { content: 'lo' } }] }]
          ),
      },
    },
  };
  (client as any).anthropic = {
    messages: {
      create: (params: any) =>
        provider(
          params,
          { content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 3, output_tokens: 1 } },
          [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }]
        ),
    },
  };

  const create = (params: Record<string, unknown> = {}): Promise<any> =>
    options.provider === 'anthropic'
      ? client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 5, messages, ...params })
      : client.chat.completions.create({ model: MODEL, messages, ...params } as any);

  return { client, timeline, received, sent, create };
}

/** Waits for the queue; never longer than a second. */
const settle = (client: SignalVaultClient) => client.flush(1_000);

/** The fallback ai.request the SDK must send. */
function fallbackOf(
  requestId: string,
  status: number | null,
  reason: string,
  form: Form,
  { provider = 'openai', model = MODEL as unknown, msgs = messages as unknown } = {}
) {
  const payload = { preflight_unavailable: true, fail_mode: 'open', preflight_status: status, preflight_reason: reason };
  const base = { type: 'ai.request', request_id: requestId, environment: 'production', provider };
  return form === 'full'
    ? { ...base, model, metadata: METADATA, payload: { ...payload, messages: msgs } }
    : { ...base, ...(typeof model === 'string' ? { model } : {}), payload };
}

const VIOLATION = { rule_id: 'r1', type: 'contains_secret', severity: 9, action: 'block', details: {} };
const DASHBOARD = 'https://signalvault.io/dashboard/apps/app_1/rules';

// ---------------------------------------------------------------------------
// No decision, nothing stored: failMode decides
// ---------------------------------------------------------------------------

// [label, pre-flight answer, preflight_status, preflight_reason, form, `status` of the error in 'closed']
const NO_DECISION: Array<[string, Reply | Error, number | null, string, Form, number | undefined]> = [
  ['network error', new TypeError('fetch failed'), null, 'network', 'full', undefined],
  ['timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError'), null, 'timeout', 'full', undefined],
  ['301', { status: 301, headers: { location: 'https://elsewhere.example' } }, 301, 'redirect', 'full', 301],
  ['302', { status: 302, headers: { location: 'https://elsewhere.example' } }, 302, 'redirect', 'full', 302],
  ['400', { status: 400, body: { errors: { detail: 'Bad Request' } } }, 400, 'http_400', 'minimal', 400],
  ['401', { status: 401, body: { errors: { detail: 'Unauthorized' } } }, 401, 'http_401', 'full', 401],
  [
    '402',
    { status: 402, body: { error: { type: 'subscription_inactive', code: 'subscription_inactive' } } },
    402, 'subscription_inactive', 'full', 402,
  ],
  [
    '403',
    { status: 403, body: { error: 'environment_not_allowed', message: 'This key may not send events.' } },
    403, 'environment_not_allowed', 'full', 403,
  ],
  ['404', { status: 404, body: { errors: { detail: 'Not Found' } } }, 404, 'http_404', 'minimal', 404],
  ['409 (an unknown 4xx)', { status: 409, body: { error: 'conflict' } }, 409, 'conflict', 'minimal', 409],
  ['413', { status: 413, body: { errors: { detail: 'Request Entity Too Large' } } }, 413, 'http_413', 'minimal', 413],
  ['422', { status: 422, body: { error: 'model must be a string' } }, 422, 'http_422', 'minimal', 422],
  [
    '429 trial limit',
    { status: 429, body: { error: { type: 'trial_limit_exceeded', code: 'trial_limit_exceeded', message: 'Trial over.' } } },
    429, 'trial_limit_exceeded', 'full', 429,
  ],
  [
    '429 rate limit without recorded',
    { status: 429, headers: { 'retry-after': '60' }, body: { error: 'rate_limited' } },
    429, 'rate_limited', 'full', 429,
  ],
  ['500', { status: 500, body: { errors: { detail: 'Internal Server Error' } } }, 500, 'http_500', 'full', 500],
  [
    '503',
    { status: 503, headers: { 'retry-after': '5' }, body: { error: { code: 'encryption_unavailable', message: 'Try again.' } } },
    503, 'encryption_unavailable', 'full', 503,
  ],
  ['200 that is not JSON', { status: 200, body: '<html>maintenance</html>' }, 200, 'invalid_response', 'full', undefined],
  ['200 without a valid decision', { status: 200, body: { decision: 'maybe' } }, 200, 'invalid_response', 'full', undefined],
];

describe('pre-flight answered without a decision', () => {
  it.each(NO_DECISION)(
    "%s, 'open': queues the SDK's record of the request, then calls the provider; the response follows",
    async (_label, preflight, status, reason, form) => {
      const { client, timeline, received, sent, create } = setup(preflight);
      const completion = await create();
      await settle(client);

      expect(completion.choices[0].message.content).toBe('hello');
      expect(sent).toHaveLength(1);
      expect(timeline).toEqual(['preflight', 'fallback', 'provider', 'ai.response']);
      const [pre, fallback, response] = received;
      expect(fallback).toEqual(fallbackOf(pre.request_id, status, reason, form));
      expect(response).toMatchObject({ type: 'ai.response', request_id: pre.request_id, payload: { output: 'hello' } });
      expect(warnings()).toEqual([expect.stringMatching(/Guardrails were NOT applied/)]);
    }
  );

  it.each(NO_DECISION)(
    "%s, 'closed': throws SignalVaultUnavailableError; the provider is not called and nothing else is sent",
    async (_label, preflight, _status, _reason, _form, errorStatus) => {
      const { client, timeline, received, sent, create } = setup(preflight, { failMode: 'closed' });
      const err = await create().catch((e) => e);
      await settle(client);

      expect(err).toBeInstanceOf(SignalVaultUnavailableError);
      expect(err.status).toBe(errorStatus);
      expect(err.requestId).toBe(received[0].request_id);
      expect(sent).toHaveLength(0);
      expect(timeline).toEqual(['preflight']);
      expect(warnings()).toEqual([]);
    }
  );
});

// ---------------------------------------------------------------------------
// Refusals: never sent to the provider, whatever the fail mode
// ---------------------------------------------------------------------------

// [label, pre-flight answer, violations, dashboardUrl]
const REFUSALS: Array<[string, Reply, unknown[], string | undefined]> = [
  [
    '200 with decision: block',
    { status: 200, body: { decision: 'block', violations: [VIOLATION], redactions: [], dashboard_url: DASHBOARD } },
    [VIOLATION], DASHBOARD,
  ],
  [
    '400 with error.code content_policy_violation (the proxy shape)',
    {
      status: 400,
      body: {
        error: {
          message: 'Request blocked by SignalVault guardrail (contains_secret). Adjust the rule in your dashboard.',
          type: 'invalid_request_error',
          code: 'content_policy_violation',
          violations: [VIOLATION, null, 7],
          dashboard_url: DASHBOARD,
        },
      },
    },
    [VIOLATION], DASHBOARD,
  ],
  ['400 with error.type content_policy_violation', { status: 400, body: { error: { type: 'content_policy_violation' } } }, [], undefined],
  [
    '200 with error "content_policy_violation" and no decision',
    { status: 200, body: { error: 'content_policy_violation', violations: [VIOLATION], dashboard_url: 7 } },
    [VIOLATION], undefined,
  ],
  [
    '429 with error "content_policy_violation"',
    { status: 429, body: { error: 'content_policy_violation', recorded: true } },
    [], undefined,
  ],
  [
    '403 with decision: block',
    { status: 403, body: { decision: 'block', violations: [VIOLATION], dashboard_url: DASHBOARD } },
    [VIOLATION], DASHBOARD,
  ],
];

describe.each(['open', 'closed'] as const)("a refusal, failMode '%s'", (failMode) => {
  it.each(REFUSALS)(
    '%s: throws SignalVaultBlockedError; the provider is not called and nothing else is sent',
    async (_label, preflight, violations, dashboardUrl) => {
      const { client, timeline, received, sent, create } = setup(preflight, { failMode });
      const err = await create().catch((e) => e);
      await settle(client);

      expect(err).toBeInstanceOf(SignalVaultBlockedError);
      expect(err.requestId).toBe(received[0].request_id);
      expect(err.violations).toEqual(violations);
      expect(err.dashboardUrl).toBe(dashboardUrl);
      expect(err.message).toBe(
        `[SignalVault] Request blocked by guardrails (${violations.length ? 'contains_secret' : 'policy'}).`
      );
      expect(sent).toHaveLength(0);
      expect(timeline).toEqual(['preflight']);
      expect(warnings()).toEqual([]);
    }
  );
});

// ---------------------------------------------------------------------------
// Stored unchecked by SignalVault (429, recorded: true)
// ---------------------------------------------------------------------------

const RECORDED: Array<[string, RegExp]> = [
  ['pre_flight_rate_limited', /rule-check rate limit reached \(429\)/],
  ['scan_timeout', /\(429: scan_timeout\)/],
  ['unscanned_content', /\(429: unscanned_content\)/],
  ['model_check_skipped', /\(429: model_check_skipped\)/],
];
const recorded = (reason: string): Reply => ({
  status: 429,
  body: { error: reason, reason, recorded: true, event_id: 'evt_1', decision: 'unchecked' },
});

describe('429 with recorded: true', () => {
  it.each(RECORDED)(
    "%s, 'open': calls the provider and sends no second record; the response follows",
    async (reason, pattern) => {
      const { client, timeline, received, sent, create } = setup(recorded(reason));
      const completion = await create();
      await settle(client);

      expect(completion.choices[0].message.content).toBe('hello');
      expect(sent).toHaveLength(1);
      expect(timeline).toEqual(['preflight', 'provider', 'ai.response']);
      expect(received[1].request_id).toBe(received[0].request_id);
      expect(warnings()).toEqual([expect.stringMatching(pattern)]);
    }
  );

  it.each(RECORDED)("%s, 'closed': throws SignalVaultUnavailableError (429)", async (reason, pattern) => {
    const { client, timeline, sent, create } = setup(recorded(reason), { failMode: 'closed' });
    const err = await create().catch((e) => e);
    await settle(client);

    expect(err).toBeInstanceOf(SignalVaultUnavailableError);
    expect(err.status).toBe(429);
    expect(err.message).toMatch(pattern);
    expect(sent).toHaveLength(0);
    expect(timeline).toEqual(['preflight']);
  });
});

// ---------------------------------------------------------------------------
// A decision that lets the request through
// ---------------------------------------------------------------------------

describe.each(['open', 'closed'] as const)("a decision, failMode '%s'", (failMode) => {
  it.each(['allow', 'warn', 'redact'])('%s: calls the provider; only the response follows', async (decision) => {
    const { client, timeline, sent, create } = setup(
      { status: 200, body: { decision, violations: [], redactions: [] } },
      { failMode }
    );
    const completion = await create();
    await settle(client);

    expect(completion.choices[0].message.content).toBe('hello');
    expect(sent).toHaveLength(1);
    expect(timeline).toEqual(['preflight', 'provider', 'ai.response']);
    expect(warnings()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A request that cannot be serialized for the check
// ---------------------------------------------------------------------------

describe('a request that cannot be serialized for the check', () => {
  const bigintMessages = [{ role: 'user', content: 'hi', tokens: BigInt(1) }];

  it("'open': calls the provider; the record leaves out the messages and metadata", async () => {
    const { client, timeline, received, sent, create } = setup({ status: 200, body: { decision: 'allow' } });
    const completion = await create({ messages: bigintMessages });
    await settle(client);

    expect(completion.choices[0].message.content).toBe('hello');
    expect(sent).toHaveLength(1);
    expect(timeline).toEqual(['fallback', 'provider', 'ai.response']);
    const [fallback, response] = received;
    expect(fallback).toEqual(fallbackOf(fallback.request_id, null, 'unserializable', 'minimal'));
    expect(response.request_id).toBe(fallback.request_id);
    expect(warnings()).toEqual([expect.stringMatching(/could not serialize.*Guardrails were NOT applied/)]);
  });

  it("'open', circular metadata: the record has no metadata and goes before the provider call", async () => {
    const metadata: Record<string, unknown> = { user_id: 'u_2' };
    metadata.self = metadata;
    const { client, timeline, received, sent } = setup({ status: 200, body: { decision: 'allow' } });
    await client.chat.completions.create({ model: MODEL, messages }, { metadata });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sent).toHaveLength(1);
    expect(timeline.slice(0, 2)).toEqual(['fallback', 'provider']);
    expect(received[0]).toEqual(fallbackOf(received[0].request_id, null, 'unserializable', 'minimal'));
  });

  it("'open', a model that is not a string: the record has no model", async () => {
    const { client, timeline, received } = setup({ status: 200, body: { decision: 'allow' } });
    await createWith(client, { model: BigInt(4) });
    await new Promise((resolve) => setImmediate(resolve));

    expect(timeline.slice(0, 2)).toEqual(['fallback', 'provider']);
    expect(received[0]).toEqual(fallbackOf(received[0].request_id, null, 'unserializable', 'minimal', { model: null }));
    expect(received[0]).not.toHaveProperty('model');
  });

  it("'closed': throws SignalVaultUnavailableError; the provider is not called and nothing is sent", async () => {
    const { client, timeline, sent, create } = setup({ status: 200, body: { decision: 'allow' } }, { failMode: 'closed' });
    const err = await create({ messages: bigintMessages }).catch((e) => e);
    await settle(client);

    expect(err).toBeInstanceOf(SignalVaultUnavailableError);
    expect(err.status).toBeUndefined();
    expect(err.message).toMatch(/could not serialize/);
    expect(sent).toHaveLength(0);
    expect(timeline).toEqual([]);
  });

  function createWith(client: SignalVaultClient, params: Record<string, unknown>) {
    return client.chat.completions.create({ model: MODEL, messages, ...params } as any);
  }
});

// ---------------------------------------------------------------------------
// The record goes before the provider call
// ---------------------------------------------------------------------------

describe("the SDK's record is queued before the provider call", () => {
  it('a stream that is never iterated still leaves it', async () => {
    const { client, timeline, received, create } = setup({ status: 503 });
    await create({ stream: true });
    await settle(client);

    expect(timeline).toEqual(['preflight', 'fallback', 'provider']);
    expect(received[1]).toEqual(fallbackOf(received[0].request_id, 503, 'http_503', 'full'));
  });

  it('a stream that is read: the record, the provider call, then the response', async () => {
    const { client, timeline, received, create } = setup({ status: 503 });
    const stream = await create({ stream: true });
    for await (const _ of stream) void _;
    await settle(client);

    expect(timeline).toEqual(['preflight', 'fallback', 'provider', 'ai.response']);
    expect(received[2].payload.output).toBe('hello');
  });

  it.each([false, true])('a provider call that throws still leaves it (stream: %s)', async (stream) => {
    const providerError = new Error('provider unavailable');
    const { client, timeline, received, create } = setup({ status: 503 }, { providerError });
    await expect(create({ stream })).rejects.toBe(providerError);
    await settle(client);

    expect(timeline).toEqual(['preflight', 'fallback', 'provider']);
    expect(received[1]).toEqual(fallbackOf(received[0].request_id, 503, 'http_503', 'full'));
  });

  it('when the provider call threw, a dropped record is counted alone, with no response', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    jest.spyOn(Math, 'random').mockReturnValue(1);
    const providerError = new Error('provider unavailable');
    const { client, timeline, received, create } = setup({ status: 503 }, { providerError, fallbackReply: { status: 503 } });
    await expect(create()).rejects.toBe(providerError);
    await jest.advanceTimersByTimeAsync(300_000);

    expect(timeline).toEqual(['preflight', 'fallback', 'provider', ...Array(5).fill('fallback')]);
    expect(warnings().filter((m) => /Dropped/.test(m))).toEqual([
      `[SignalVault] Dropped 1 audit event(s) (retries exhausted: 6 attempts, last: 503): request_id ` +
        `${received[0].request_id} (fallback ai.request, which has no event_id). Dropped events are not in your ` +
        'audit log. Events queue up while SignalVault is unreachable or rate limiting this app. Counts by cause: ' +
        'client.droppedEvents.',
    ]);
    expect(client.droppedEvents).toEqual({ queueFull: 0, retriesExhausted: 1, exit: 0 });
  });
});

// ---------------------------------------------------------------------------
// Anthropic takes the same paths
// ---------------------------------------------------------------------------

describe('Anthropic', () => {
  it("a refusal (content_policy_violation) throws in 'open'", async () => {
    const { client, timeline, sent, create } = setup(
      { status: 400, body: { error: { type: 'invalid_request_error', code: 'content_policy_violation', violations: [VIOLATION] } } },
      { provider: 'anthropic' }
    );
    const err = await create().catch((e) => e);
    await settle(client);

    expect(err).toBeInstanceOf(SignalVaultBlockedError);
    expect(err.violations).toEqual([VIOLATION]);
    expect(sent).toHaveLength(0);
    expect(timeline).toEqual(['preflight']);
  });

  it.each([
    [{ status: 503 } as Reply, 503, 'http_503', 'full' as Form],
    [{ status: 413 } as Reply, 413, 'http_413', 'minimal' as Form],
  ])("%j, 'open': the record goes before the provider call; the response follows", async (preflight, status, reason, form) => {
    const { client, timeline, received, sent, create } = setup(preflight, { provider: 'anthropic' });
    const response = await create({ system: 'Be brief.' });
    await settle(client);

    expect(response.content[0].text).toBe('hello');
    expect(sent).toHaveLength(1);
    expect(timeline).toEqual(['preflight', 'fallback', 'provider', 'ai.response']);
    expect(received[1]).toEqual(
      fallbackOf(received[0].request_id, status, reason, form, {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        msgs: [{ role: 'system', content: 'Be brief.' }, ...messages],
      })
    );
  });
});

// ---------------------------------------------------------------------------
// preflight_reason
// ---------------------------------------------------------------------------

describe('preflight_reason never carries text from the server', () => {
  it.each([
    [403, { error: 'environment_not_allowed\n[SignalVault] All rules passed' }],
    [503, { error: { code: '[SignalVault] All rules passed' } }],
    [402, { error: { type: 'Subscription inactive. Visit https://signalvault.io/billing' } }],
    [409, { error: 'a'.repeat(65) }],
  ])('%i %j: http_<status> instead', async (status, body) => {
    const { client, received, create } = setup({ status, body });
    await create();
    await settle(client);

    expect(received[1].payload.preflight_reason).toBe(`http_${status}`);
  });
});
