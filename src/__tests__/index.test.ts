import { SignalVaultClient } from '../index';

// Minimal unit tests for the SDK (no network calls)
describe('SignalVaultClient', () => {
  it('should construct with required config', () => {
    const client = new SignalVaultClient({
      apiKey: 'sk_test_abc',
      openaiApiKey: 'sk-fake',
    });
    expect(client).toBeDefined();
    expect(client.chat).toBeDefined();
    expect(client.chat.completions).toBeDefined();
    expect(typeof client.chat.completions.create).toBe('function');
  });

  it('should default to localhost and production', () => {
    const client = new SignalVaultClient({
      apiKey: 'sk_test_abc',
      openaiApiKey: 'sk-fake',
    });
    // Access private fields via bracket notation for testing
    expect((client as any).signalvaultBaseUrl).toBe('http://localhost:4000');
    expect((client as any).signalvaultEnvironment).toBe('production');
    expect((client as any).debugMode).toBe(false);
    expect((client as any).mirrorMode).toBe(false);
  });

  it('should accept custom baseUrl and environment', () => {
    const client = new SignalVaultClient({
      apiKey: 'sk_test_abc',
      openaiApiKey: 'sk-fake',
      baseUrl: 'https://api.signalvault.io/',
      environment: 'staging',
      debug: true,
      mirrorMode: true,
    });
    expect((client as any).signalvaultBaseUrl).toBe('https://api.signalvault.io');
    expect((client as any).signalvaultEnvironment).toBe('staging');
    expect((client as any).debugMode).toBe(true);
    expect((client as any).mirrorMode).toBe(true);
  });

  it('should strip trailing slashes from baseUrl', () => {
    const client = new SignalVaultClient({
      apiKey: 'sk_test_abc',
      openaiApiKey: 'sk-fake',
      baseUrl: 'https://example.com///',
    });
    expect((client as any).signalvaultBaseUrl).toBe('https://example.com');
  });
});
