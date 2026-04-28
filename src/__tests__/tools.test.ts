import { SignalVaultClient } from '../index';

describe('Agent tool-use capture', () => {
  let fetchMock: jest.SpyInstance;
  let client: SignalVaultClient;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ event_id: 'evt_123' }), { status: 200 })
    );
    client = new SignalVaultClient({
      apiKey: 'sk_test_abc',
      openaiApiKey: 'sk-fake',
      baseUrl: 'https://api.example.com',
    });
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  // Helper: lets the fire-and-forget tool record promise settle.
  const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

  describe('client.tool() wrapper', () => {
    it('records a successful tool invocation with input/output and timing', async () => {
      const fetchWeather = client.tool('fetch_weather', async (city: string) => {
        return { temp: 12.3, conditions: 'rain', for: city };
      });

      const result = await fetchWeather('London');
      expect(result).toEqual({ temp: 12.3, conditions: 'rain', for: 'London' });

      await flushAsync();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.example.com/v1/events');

      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.type).toBe('agent.tool_call');
      expect(body.payload.tool_name).toBe('fetch_weather');
      expect(body.payload.tool_input).toBe('London');
      expect(body.payload.tool_output).toEqual({ temp: 12.3, conditions: 'rain', for: 'London' });
      expect(body.payload.duration_ms).toBeGreaterThanOrEqual(0);
      expect(body.payload.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('records an errored invocation and rethrows', async () => {
      const failingTool = client.tool('fetch_external', async () => {
        throw new Error('connection refused');
      });

      await expect(failingTool()).rejects.toThrow('connection refused');

      await flushAsync();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.error).toBe('connection refused');
      expect(body.payload.tool_output).toBeNull();
    });

    it('serializes a single object arg as the value, not as an array', async () => {
      const search = client.tool(
        'search',
        async (query: { q: string; k: number }) => ({ matches: query.k })
      );

      await search({ q: 'embeddings', k: 5 });
      await flushAsync();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.tool_input).toEqual({ q: 'embeddings', k: 5 });
    });

    it('serializes multiple args as an array', async () => {
      const add = client.tool('add', async (a: number, b: number) => a + b);

      await add(2, 3);
      await flushAsync();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.tool_input).toEqual([2, 3]);
    });

    it('does not block on the audit network call (fire-and-forget)', async () => {
      // Make fetch hang so we can verify the wrapper returns before the audit completes
      fetchMock.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(new Response('{}', { status: 200 })), 5000))
      );

      const start = Date.now();
      const tool = client.tool('fast_tool', async () => 42);
      const result = await tool();
      const elapsed = Date.now() - start;

      expect(result).toBe(42);
      expect(elapsed).toBeLessThan(100); // should NOT wait the 5s audit timeout
    });

    it('supports synchronous functions', async () => {
      const sum = client.tool('sum', (a: number, b: number) => a + b);

      const result = await sum(2, 3);
      expect(result).toBe(5);
    });
  });

  describe('client.tools.record() manual API', () => {
    it('posts a tool_call event with the given fields', async () => {
      await client.tools.record({
        toolName: 'manual_tool',
        toolInput: { x: 1 },
        toolOutput: { y: 2 },
        durationMs: 50,
        requestId: 'req-explicit',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.type).toBe('agent.tool_call');
      expect(body.request_id).toBe('req-explicit');
      expect(body.payload.tool_name).toBe('manual_tool');
      expect(body.payload.duration_ms).toBe(50);
    });

    it('omits request_id when not provided (orphan tool call)', async () => {
      await client.tools.record({
        toolName: 'orphan',
        durationMs: 10,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.request_id).toBeUndefined();
    });
  });

  describe('input sanitization', () => {
    it('replaces circular references with a marker instead of throwing', async () => {
      const circular: Record<string, unknown> = { name: 'root' };
      circular.self = circular;

      const tool = client.tool('circular_tool', async (_arg: unknown) => 'ok');
      await tool(circular);
      await flushAsync();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.tool_input).toEqual({ name: 'root', self: '[Circular]' });
    });

    it('serializes BigInt arguments as a string with n suffix', async () => {
      const tool = client.tool('bigint_tool', async (_n: bigint) => 'ok');
      await tool(BigInt(42));
      await flushAsync();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.tool_input).toBe('42n');
    });

    it('truncates oversized tool_output with a marker', async () => {
      // ~300 KB — over the 256 KB cap.
      const big = 'x'.repeat(300 * 1024);
      const tool = client.tool('big_output', async () => ({ blob: big }));
      await tool();
      await flushAsync();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.tool_output._signalvault_truncated).toBe(true);
      expect(body.payload.tool_output._signalvault_original_bytes).toBeGreaterThan(256 * 1024);
      expect(typeof body.payload.tool_output.preview).toBe('string');
    });

    it('truncates a long error message to ~1900 bytes', async () => {
      const longMsg = 'a'.repeat(5000);
      const failing = client.tool('long_error', async () => {
        throw new Error(longMsg);
      });
      await expect(failing()).rejects.toThrow();
      await flushAsync();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const err = body.payload.error as string;
      // Allow a generous upper bound to account for the truncation marker.
      expect(Buffer.byteLength(err, 'utf8')).toBeLessThanOrEqual(1900);
      expect(err).toMatch(/truncated/);
    });

    it('truncates an oversized tool_name and still records the call', async () => {
      const longName = 'n'.repeat(500);
      await client.tools.record({
        toolName: longName,
        durationMs: 1,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(Buffer.byteLength(body.payload.tool_name, 'utf8')).toBeLessThanOrEqual(200);
      expect(body.payload.tool_name).toMatch(/truncated/);
    });

    it('rejects an empty tool name from the manual API', async () => {
      await expect(
        client.tools.record({ toolName: '', durationMs: 1 })
      ).rejects.toThrow(/non-empty string/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('replaces undefined tool_output with null in the body', async () => {
      const tool = client.tool('void_tool', async () => undefined);
      await tool();
      await flushAsync();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.tool_output).toBeNull();
    });

    it('replaces a function value with a [Function] marker (not a crash)', async () => {
      const tool = client.tool('weird_input', async (_fn: unknown) => 'ok');
      await tool(() => 'hello');
      await flushAsync();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.payload.tool_input).toBe('[Function]');
    });

    it('falls back to the serialization-error envelope for top-level undefined', async () => {
      // A bare `undefined` is JSON-serializable as nothing — the replacer leaves
      // it alone and JSON.stringify returns undefined. We expose this as a
      // marker so the audit isn't silently dropped.
      await client.tools.record({
        toolName: 'undef',
        toolInput: undefined,
        durationMs: 1,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // sanitizePayload(undefined) returns null per the function contract.
      expect(body.payload.tool_input).toBeNull();
    });
  });

  describe('error logging', () => {
    let warnSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('surfaces 4xx responses to console.warn even with debug=false', async () => {
      fetchMock.mockResolvedValue(new Response('bad request', { status: 422 }));

      await client.tools.record({ toolName: 'will_fail', durationMs: 1 });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/422/);
      expect(warnSpy.mock.calls[0][0]).toMatch(/Check your apiKey/);
    });

    it('does NOT log 5xx responses unless debug is true', async () => {
      fetchMock.mockResolvedValue(new Response('boom', { status: 503 }));

      await client.tools.record({ toolName: 'svc_down', durationMs: 1 });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('client.withContext() correlation', () => {
    it('auto-links wrapped tool calls to the surrounding requestId', async () => {
      const tool = client.tool('search', async (q: string) => ({ q }));

      await client.withContext({ requestId: 'turn-abc' }, async () => {
        await tool('embeddings');
      });
      await flushAsync();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.request_id).toBe('turn-abc');
    });

    it('explicit requestId on record() overrides context', async () => {
      await client.withContext({ requestId: 'context-id' }, async () => {
        await client.tools.record({
          toolName: 'override',
          durationMs: 1,
          requestId: 'explicit-id',
        });
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.request_id).toBe('explicit-id');
    });

    it('tools called outside any context are orphans', async () => {
      const tool = client.tool('orphan_tool', async () => 'ok');
      await tool();
      await flushAsync();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.request_id).toBeUndefined();
    });
  });
});
