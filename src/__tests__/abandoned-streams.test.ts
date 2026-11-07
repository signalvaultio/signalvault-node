import * as v8 from 'v8';
import * as vm from 'vm';
import { SignalVaultClient } from '../index';

// A stream dropped before it finishes (never iterated, or abandoned without
// break/return) has its response recorded when it is garbage collected,
// marked `stream_abandoned: true`. Streams that end, throw or that the
// consumer breaks out of are recorded as before.

const messages = [{ role: 'user' as const, content: 'hi' }];
const ALLOW = { decision: 'allow', violations: [], redactions: [] };
const OPENAI_CHUNKS = [
  { choices: [{ delta: { content: 'hel' } }] },
  { choices: [{ delta: { content: 'lo' } }] },
  { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
];
const ANTHROPIC_EVENTS = [
  { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
  { type: 'message_delta', usage: { output_tokens: 2 } },
];

/** Clients made here; their queues are emptied after each test so no retry outlives it. */
const clients: SignalVaultClient[] = [];
beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const client of clients.splice(0)) (client as any).queue.abandon('exit');
  jest.restoreAllMocks();
});

/**
 * Every event SignalVault receives, in order. The pre-flight is answered
 * with `preflightStatus` (an allow decision on 200); every other event 200.
 */
function stubSignalVault(preflightStatus = 200): any[] {
  const events: any[] = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string);
    events.push(body);
    const preflight =
      body.type === 'ai.request' && !body.payload?.preflight_unavailable && !body.payload?.monitor_mode;
    if (!preflight) return new Response('{}', { status: 200 });
    return new Response(JSON.stringify(preflightStatus === 200 ? ALLOW : {}), { status: preflightStatus });
  });
  return events;
}

function generate(items: unknown[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

function makeClient(mirrorMode = false) {
  const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake', mirrorMode });
  clients.push(client);
  (client as any).openai = { chat: { completions: { create: async () => generate(OPENAI_CHUNKS) } } };
  (client as any).anthropic = { messages: { create: async () => generate(ANTHROPIC_EVENTS) } };
  return client;
}

const openaiStream = (client: SignalVaultClient): Promise<AsyncGenerator<any>> =>
  client.chat.completions.create({ model: 'm', messages, stream: true }) as any;

/**
 * Stands in for the client's FinalizationRegistry, so collection happens
 * when the test says: collect() does what garbage collection of every
 * stream still registered would do.
 */
function collector(client: SignalVaultClient) {
  const live = new Map<object, (abandoned: boolean) => void>();
  (client as any).abandonedStreams = {
    register: (_stream: object, record: (abandoned: boolean) => void, token: object) => live.set(token, record),
    unregister: (token: object) => live.delete(token),
  };
  return {
    live,
    collect() {
      for (const [token, record] of [...live]) {
        live.delete(token);
        record(true);
      }
    },
  };
}

const typesOf = (events: any[]) => events.map((e) => e.type);
const responsesOf = (events: any[]) => events.filter((e) => e.type === 'ai.response');

describe('a stream dropped before it finishes', () => {
  it('never iterated: nothing until it is collected, then an empty response marked stream_abandoned', async () => {
    const events = stubSignalVault();
    const client = makeClient();
    const gc = collector(client);
    await openaiStream(client);
    await client.flush();
    expect(typesOf(events)).toEqual(['ai.request']);

    gc.collect();
    await client.flush();
    expect(typesOf(events)).toEqual(['ai.request', 'ai.response']);
    expect(responsesOf(events)[0].request_id).toBe(events[0].request_id);
    expect(responsesOf(events)[0].payload).toEqual({
      output: '',
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      stream_abandoned: true,
    });
  });

  it('abandoned after one chunk without break or return: the output read so far', async () => {
    const events = stubSignalVault();
    const client = makeClient();
    const gc = collector(client);
    const stream = await openaiStream(client);
    expect((await stream.next()).value).toEqual(OPENAI_CHUNKS[0]);

    gc.collect();
    await client.flush();
    expect(responsesOf(events).map((e) => e.payload)).toEqual([
      { output: 'hel', usage: { prompt_tokens: 0, completion_tokens: 0 }, stream_abandoned: true },
    ]);
  });

  it('after a failed check: the response follows the SDK record of the request', async () => {
    const events = stubSignalVault(503);
    const client = makeClient();
    const gc = collector(client);
    await openaiStream(client);
    gc.collect();
    await client.flush();

    expect(events.map((e) => (e.payload?.preflight_unavailable ? 'fallback' : e.type))).toEqual([
      'ai.request', 'fallback', 'ai.response',
    ]);
    expect(events[2].payload.stream_abandoned).toBe(true);
  });

  it('mirror mode: the request and the response, the response marked', async () => {
    const events = stubSignalVault();
    const client = makeClient(true);
    const gc = collector(client);
    await openaiStream(client);
    await client.flush();
    expect(events).toEqual([]);

    gc.collect();
    await client.flush();
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ['ai.request', { messages, monitor_mode: true }],
      ['ai.response', { output: '', usage: { prompt_tokens: 0, completion_tokens: 0 }, monitor_mode: true, stream_abandoned: true }],
    ]);
  });

  it('Anthropic: abandoned after two events, with the usage seen so far', async () => {
    const events = stubSignalVault();
    const client = makeClient();
    const gc = collector(client);
    const stream: AsyncGenerator<any> = await client.messages.create({ model: 'c', max_tokens: 5, messages, stream: true });
    await stream.next();
    await stream.next();

    gc.collect();
    await client.flush();
    expect(responsesOf(events).map((e) => e.payload)).toEqual([
      { output: 'hello', usage: { input_tokens: 3, output_tokens: 1 }, stream_abandoned: true },
    ]);
  });

  it.each(['read to the end', 'left with break'])(
    '%s: recorded once, unmarked, and no longer watched',
    async (how) => {
      const events = stubSignalVault();
      const client = makeClient();
      const gc = collector(client);
      const stream = await openaiStream(client);
      for await (const _ of stream) {
        if (how === 'left with break') break;
      }
      await client.flush();
      expect(gc.live.size).toBe(0);
      gc.collect();
      await client.flush();

      const responses = responsesOf(events);
      expect(responses).toHaveLength(1);
      expect(responses[0].payload).not.toHaveProperty('stream_abandoned');
      expect(responses[0].payload.output).toBe(how === 'left with break' ? 'hel' : 'hello');
    }
  );
});

// The same with the client's real FinalizationRegistry and a forced garbage
// collection: the record must not keep the stream it records alive.
describe('a stream dropped before it finishes, collected for real', () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;

  /** Collects garbage until `done()`, at most 10 times. */
  async function collectUntil(done: () => boolean) {
    for (let i = 0; i < 10 && !done(); i++) {
      gc();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it('never iterated', async () => {
    const events = stubSignalVault();
    const client = makeClient();
    await (async () => {
      await openaiStream(client);
    })();
    await collectUntil(() => responsesOf(events).length > 0);
    await client.flush();

    expect(responsesOf(events).map((e) => e.payload)).toEqual([
      { output: '', usage: { prompt_tokens: 0, completion_tokens: 0 }, stream_abandoned: true },
    ]);
  });

  it('abandoned after one chunk', async () => {
    const events = stubSignalVault();
    const client = makeClient();
    await (async () => {
      const stream = await openaiStream(client);
      await stream.next();
    })();
    await collectUntil(() => responsesOf(events).length > 0);
    await client.flush();

    expect(responsesOf(events).map((e) => e.payload)).toEqual([
      { output: 'hel', usage: { prompt_tokens: 0, completion_tokens: 0 }, stream_abandoned: true },
    ]);
  });
});
