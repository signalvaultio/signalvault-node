import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';

export interface SignalVaultConfig {
  apiKey: string;
  openaiApiKey: string;
  baseUrl?: string;
  environment?: 'development' | 'staging' | 'production';
  debug?: boolean;
  mirrorMode?: boolean;
}

export interface SignalVaultDecision {
  decision: 'allow' | 'warn' | 'block' | 'redact';
  violations: Array<{
    rule_id?: string;
    type: string;
    severity: number;
    action: string;
    details: Record<string, unknown>;
  }>;
  redactions: Array<{
    start: number;
    end: number;
    replacement: string;
  }>;
}

/**
 * SignalVault Client — wraps OpenAI with guardrails and audit logging.
 *
 * @example
 * ```typescript
 * const client = new SignalVaultClient({
 *   apiKey: 'sk_live_...',
 *   openaiApiKey: process.env.OPENAI_API_KEY!,
 *   baseUrl: 'https://api.signalvault.io',
 * });
 *
 * // Non-streaming
 * const res = await client.chat.completions.create({ model: 'gpt-4', messages: [...] });
 *
 * // Streaming
 * const stream = await client.chat.completions.create({ model: 'gpt-4', messages: [...], stream: true });
 * for await (const chunk of stream) { ... }
 * ```
 */
export class SignalVaultClient {
  private signalvaultApiKey: string;
  private signalvaultBaseUrl: string;
  private signalvaultEnvironment: string;
  private debugMode: boolean;
  private mirrorMode: boolean;
  private openai: OpenAI;

  constructor(config: SignalVaultConfig) {
    this.signalvaultApiKey = config.apiKey;
    this.signalvaultBaseUrl = (config.baseUrl || 'http://localhost:4000').replace(/\/+$/, '');
    this.signalvaultEnvironment = config.environment || 'production';
    this.debugMode = config.debug || false;
    this.mirrorMode = config.mirrorMode || false;

    this.openai = new OpenAI({
      apiKey: config.openaiApiKey,
    });
  }

  /**
   * Chat completions with SignalVault guardrails.
   * Supports both streaming and non-streaming.
   */
  get chat() {
    return {
      completions: {
        create: async (
          params: OpenAI.Chat.ChatCompletionCreateParams
        ): Promise<any> => {
          const requestId = uuidv4();

          if (this.debugMode) {
            console.log(
              '[SignalVault] Processing request:',
              requestId,
              this.mirrorMode ? '(MIRROR MODE)' : '',
              params.stream ? '(STREAMING)' : ''
            );
          }

          // Mirror mode: call OpenAI first, then audit
          if (this.mirrorMode) {
            return this.handleMirrorMode(requestId, params);
          }

          // Normal mode: pre-flight checks first
          return this.handleNormalMode(requestId, params);
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Mirror mode — no latency added, audit asynchronously
  // ---------------------------------------------------------------------------

  private async handleMirrorMode(
    requestId: string,
    params: OpenAI.Chat.ChatCompletionCreateParams
  ) {
    try {
      const response = await this.openai.chat.completions.create(params as any);

      if (params.stream) {
        // Wrap the stream to collect chunks for auditing
        return this.wrapStreamForAudit(requestId, params, response as any);
      }

      // Non-streaming: audit in background
      const completion = response as OpenAI.Chat.ChatCompletion;
      this.sendAudit(requestId, params, completion).catch((err) => {
        if (this.debugMode) {
          console.error('[SignalVault] Audit failed (non-blocking):', err);
        }
      });

      return completion;
    } catch (error) {
      if (this.debugMode) {
        console.error('[SignalVault] OpenAI error:', error);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Normal mode — pre-flight guardrails, then OpenAI, then post-flight
  // ---------------------------------------------------------------------------

  private async handleNormalMode(
    requestId: string,
    params: OpenAI.Chat.ChatCompletionCreateParams
  ) {
    try {
      // Pre-flight check
      const decision = await this.sendRequest(requestId, params);

      if (decision.decision === 'block') {
        throw new Error(
          `[SignalVault] Request blocked: ${JSON.stringify(decision.violations)}`
        );
      }

      if (decision.decision === 'warn' && this.debugMode) {
        console.warn('[SignalVault] Warnings:', decision.violations);
      }

      const response = await this.openai.chat.completions.create(params as any);

      if (params.stream) {
        // Wrap stream to collect output for post-flight logging
        return this.wrapStreamForPostFlight(requestId, params, response as any);
      }

      // Non-streaming: post-flight logging
      const completion = response as OpenAI.Chat.ChatCompletion;
      await this.sendResponse(requestId, completion, params.model as string);
      return completion;
    } catch (error) {
      if (this.debugMode) {
        console.error('[SignalVault] Error:', error);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Stream wrappers — collect chunks and send audit/post-flight events
  // ---------------------------------------------------------------------------

  private async *wrapStreamForAudit(
    requestId: string,
    params: OpenAI.Chat.ChatCompletionCreateParams,
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
  ) {
    const chunks: string[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) chunks.push(content);

      // Collect usage if provided in final chunk
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens || 0;
        completionTokens = chunk.usage.completion_tokens || 0;
      }

      yield chunk;
    }

    // Send audit after stream completes
    const fullOutput = chunks.join('');
    this.sendStreamAudit(requestId, params, fullOutput, promptTokens, completionTokens).catch(
      (err) => {
        if (this.debugMode) {
          console.error('[SignalVault] Stream audit failed:', err);
        }
      }
    );
  }

  private async *wrapStreamForPostFlight(
    requestId: string,
    params: OpenAI.Chat.ChatCompletionCreateParams,
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
  ) {
    const chunks: string[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) chunks.push(content);

      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens || 0;
        completionTokens = chunk.usage.completion_tokens || 0;
      }

      yield chunk;
    }

    // Post-flight logging
    const fullOutput = chunks.join('');
    try {
      await this.sendStreamResponse(
        requestId,
        params.model as string,
        fullOutput,
        promptTokens,
        completionTokens
      );
    } catch (err) {
      if (this.debugMode) {
        console.error('[SignalVault] Post-flight logging failed:', err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // API communication
  // ---------------------------------------------------------------------------

  private async sendRequest(
    requestId: string,
    params: OpenAI.Chat.ChatCompletionCreateParams
  ): Promise<SignalVaultDecision> {
    const response = await fetch(`${this.signalvaultBaseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.signalvaultApiKey}`,
      },
      body: JSON.stringify({
        type: 'ai.request',
        request_id: requestId,
        environment: this.signalvaultEnvironment,
        provider: 'openai',
        model: params.model,
        metadata: {},
        payload: { messages: params.messages },
      }),
    });

    if (!response.ok) {
      if (this.debugMode) {
        console.error('[SignalVault] API error:', response.status);
      }
      return { decision: 'allow', violations: [], redactions: [] };
    }

    return (await response.json()) as SignalVaultDecision;
  }

  private async sendResponse(
    requestId: string,
    response: OpenAI.Chat.ChatCompletion,
    model: string
  ): Promise<void> {
    try {
      const output = response.choices[0]?.message?.content || '';
      await fetch(`${this.signalvaultBaseUrl}/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.signalvaultApiKey}`,
        },
        body: JSON.stringify({
          type: 'ai.response',
          request_id: requestId,
          environment: this.signalvaultEnvironment,
          provider: 'openai',
          model,
          metadata: {},
          payload: {
            output,
            usage: {
              prompt_tokens: response.usage?.prompt_tokens || 0,
              completion_tokens: response.usage?.completion_tokens || 0,
            },
          },
        }),
      });
    } catch (error) {
      if (this.debugMode) {
        console.error('[SignalVault] Failed to send response:', error);
      }
    }
  }

  private async sendStreamResponse(
    requestId: string,
    model: string,
    output: string,
    promptTokens: number,
    completionTokens: number
  ): Promise<void> {
    await fetch(`${this.signalvaultBaseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.signalvaultApiKey}`,
      },
      body: JSON.stringify({
        type: 'ai.response',
        request_id: requestId,
        environment: this.signalvaultEnvironment,
        provider: 'openai',
        model,
        metadata: {},
        payload: {
          output,
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
        },
      }),
    });
  }

  private async sendAudit(
    requestId: string,
    params: OpenAI.Chat.ChatCompletionCreateParams,
    response: OpenAI.Chat.ChatCompletion
  ): Promise<void> {
    const output = response.choices[0]?.message?.content || '';

    // Send ai.request event
    await fetch(`${this.signalvaultBaseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.signalvaultApiKey}`,
      },
      body: JSON.stringify({
        type: 'ai.request',
        request_id: requestId,
        environment: this.signalvaultEnvironment,
        provider: 'openai',
        model: params.model,
        metadata: {},
        payload: { messages: params.messages, monitor_mode: true },
      }),
    });

    // Send ai.response event
    await fetch(`${this.signalvaultBaseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.signalvaultApiKey}`,
      },
      body: JSON.stringify({
        type: 'ai.response',
        request_id: requestId,
        environment: this.signalvaultEnvironment,
        provider: 'openai',
        model: params.model,
        metadata: {},
        payload: {
          output,
          usage: {
            prompt_tokens: response.usage?.prompt_tokens || 0,
            completion_tokens: response.usage?.completion_tokens || 0,
          },
          monitor_mode: true,
        },
      }),
    });
  }

  private async sendStreamAudit(
    requestId: string,
    params: OpenAI.Chat.ChatCompletionCreateParams,
    output: string,
    promptTokens: number,
    completionTokens: number
  ): Promise<void> {
    // Send ai.request event
    await fetch(`${this.signalvaultBaseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.signalvaultApiKey}`,
      },
      body: JSON.stringify({
        type: 'ai.request',
        request_id: requestId,
        environment: this.signalvaultEnvironment,
        provider: 'openai',
        model: params.model,
        metadata: {},
        payload: { messages: params.messages, monitor_mode: true },
      }),
    });

    // Send ai.response event
    await fetch(`${this.signalvaultBaseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.signalvaultApiKey}`,
      },
      body: JSON.stringify({
        type: 'ai.response',
        request_id: requestId,
        environment: this.signalvaultEnvironment,
        provider: 'openai',
        model: params.model,
        metadata: {},
        payload: {
          output,
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
          monitor_mode: true,
        },
      }),
    });
  }
}

export default SignalVaultClient;
