import { SignalVaultClient } from '../index';

describe('SignalVaultClient', () => {
  describe('construction', () => {
    it('constructs with openaiApiKey', () => {
      const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake' });
      expect(client).toBeDefined();
      expect(client.chat).toBeDefined();
      expect(client.chat.completions).toBeDefined();
      expect(typeof client.chat.completions.create).toBe('function');
    });

    it('throws when neither openaiApiKey nor anthropicApiKey is provided', () => {
      expect(() => new SignalVaultClient({ apiKey: 'sk_test_abc' })).toThrow(
        'At least one of openaiApiKey or anthropicApiKey is required'
      );
    });

    it('defaults to localhost and production', () => {
      const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake' });
      expect((client as any).svBaseUrl).toBe('http://localhost:4000');
      expect((client as any).svEnvironment).toBe('production');
      expect((client as any).debugMode).toBe(false);
      expect((client as any).mirrorMode).toBe(false);
    });

    it('accepts custom config', () => {
      const client = new SignalVaultClient({
        apiKey: 'sk_test_abc',
        openaiApiKey: 'sk-fake',
        baseUrl: 'https://api.signalvault.io/',
        environment: 'staging',
        debug: true,
        mirrorMode: true,
      });
      expect((client as any).svBaseUrl).toBe('https://api.signalvault.io');
      expect((client as any).svEnvironment).toBe('staging');
      expect((client as any).debugMode).toBe(true);
      expect((client as any).mirrorMode).toBe(true);
    });

    it('strips trailing slashes from baseUrl', () => {
      const client = new SignalVaultClient({
        apiKey: 'sk_test_abc',
        openaiApiKey: 'sk-fake',
        baseUrl: 'https://example.com///',
      });
      expect((client as any).svBaseUrl).toBe('https://example.com');
    });
  });

  describe('timeout configuration', () => {
    it('defaults to 2000ms preflight and 10000ms background', () => {
      const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake' });
      expect((client as any).preflightTimeout).toBe(2000);
      expect((client as any).bgTimeout).toBe(10000);
    });

    it('accepts custom timeouts', () => {
      const client = new SignalVaultClient({
        apiKey: 'sk_test_abc',
        openaiApiKey: 'sk-fake',
        preflightTimeout: 500,
        timeout: 5000,
      });
      expect((client as any).preflightTimeout).toBe(500);
      expect((client as any).bgTimeout).toBe(5000);
    });
  });

  describe('metadata', () => {
    it('defaults to empty metadata', () => {
      const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake' });
      expect((client as any).defaultMetadata).toEqual({});
    });

    it('accepts metadata in config', () => {
      const client = new SignalVaultClient({
        apiKey: 'sk_test_abc',
        openaiApiKey: 'sk-fake',
        metadata: { user_id: 'u_123', feature: 'chat' },
      });
      expect((client as any).defaultMetadata).toEqual({ user_id: 'u_123', feature: 'chat' });
    });
  });

  describe('Anthropic', () => {
    it('throws on messages access when anthropicApiKey not provided', () => {
      const client = new SignalVaultClient({ apiKey: 'sk_test_abc', openaiApiKey: 'sk-fake' });
      expect(() => client.messages).toThrow('anthropicApiKey not provided');
    });

    it('throws when @anthropic-ai/sdk is not installed', () => {
      expect(() =>
        new SignalVaultClient({ apiKey: 'sk_test_abc', anthropicApiKey: 'sk-ant-fake' })
      ).toThrow('@anthropic-ai/sdk is not installed');
    });
  });

  describe('fail-open on preflight timeout', () => {
    it('sendRequest returns allow decision on fetch error', async () => {
      const client = new SignalVaultClient({
        apiKey: 'sk_test_abc',
        openaiApiKey: 'sk-fake',
        baseUrl: 'http://127.0.0.1:1',  // unreachable
        preflightTimeout: 100,
      });
      const decision = await (client as any).sendRequest(
        'req-1', 'gpt-4', [], {}, 'openai'
      );
      expect(decision.decision).toBe('allow');
      expect(decision.violations).toEqual([]);
    });
  });
});
