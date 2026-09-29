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

function makeClient(config: Partial<SignalVaultConfig> = {}) {
  const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake', ...config });
  const openai = openaiStub();
  (client as any).openai = openai.client;
  return { client, openai };
}

const allow = { status: 200, body: { decision: 'allow', violations: [], redactions: [] } };
const messages = [{ role: 'user' as const, content: 'hi' }];

let warnSpy: jest.SpyInstance;
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
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

  it('retries once on 503 with the same event_id', async () => {
    const f = stubFetch({ 'ai.request': [allow], 'ai.response': [{ status: 503 }, { status: 200 }] });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await client.flush();

    const responses = f.calls.filter((c) => c.body.type === 'ai.response');
    expect(responses).toHaveLength(2);
    expect(responses[0].body.event_id).toBe(responses[1].body.event_id);
  });

  it('honours a short Retry-After on 429 and drops with a warning on a long one', async () => {
    const f = stubFetch({
      'ai.request': [allow, allow],
      'ai.response': [
        { status: 429, headers: { 'retry-after': '0' } },
        { status: 200 },
        { status: 429, headers: { 'retry-after': '60' } },
      ],
    });
    const { client } = makeClient();

    await client.chat.completions.create({ model: 'm', messages });
    await client.flush();
    expect(f.types().filter((t) => t === 'ai.response')).toHaveLength(2);

    await client.chat.completions.create({ model: 'm', messages });
    await client.flush();
    expect(f.types().filter((t) => t === 'ai.response')).toHaveLength(3);
    expect(warnSpy.mock.calls.some((c) => /events are being dropped/.test(c[0]))).toBe(true);
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
    expect(fallback.payload).toEqual({ messages, preflight_unavailable: true });
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
  it('does not retry a timed-out event', async () => {
    let responses = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async (_u, init) => {
      const type = JSON.parse((init as RequestInit).body as string).type;
      if (type === 'ai.response') {
        responses++;
        throw new DOMException('timed out', 'TimeoutError');
      }
      return new Response(JSON.stringify(allow.body), { status: 200 });
    });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await client.flush();
    expect(responses).toBe(1);
  });

  it('warns when the retry is rate limited too', async () => {
    stubFetch({
      'ai.request': [allow],
      'ai.response': [
        { status: 429, headers: { 'retry-after': '0' } },
        { status: 429, headers: { 'retry-after': '60' } },
      ],
    });
    const { client } = makeClient();
    await client.chat.completions.create({ model: 'm', messages });
    await client.flush();
    expect(warnSpy.mock.calls.some((c) => /events are being dropped/.test(c[0]))).toBe(true);
  });

  it('tools.record() does not retry', async () => {
    const f = stubFetch({ 'agent.tool_call': [{ status: 503 }, { status: 200 }] });
    const { client } = makeClient();
    await client.tools.record({ toolName: 't', durationMs: 1 });
    expect(f.types()).toEqual(['agent.tool_call']);
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
