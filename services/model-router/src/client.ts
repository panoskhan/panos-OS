export const DEFAULT_MODEL = "google/gemma-4-31b-it";
export const DEFAULT_MODEL_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const DEFAULT_MODEL_TIMEOUT_MS = 60_000;

export interface ModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResult {
  text: string;
  model: string;
}

export type ModelErrorCode = "model_unreachable" | "model_timeout" | "model_http_error" | "model_bad_response";

/** A failed model call. The message never contains the API key. */
export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly httpStatus?: number
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

/** What the last real model calls say about whether the model works. */
export interface ModelHealth {
  configured: boolean;
  model?: string;
  calls: number;
  failures: number;
  lastSuccessAt?: string;
  lastFailure?: { at: string; message: string };
}

/**
 * The model settings from the environment, or null when no key is set (the model is then simply not configured).
 * NVIDIA_API_KEY, KHAN_MODEL, KHAN_MODEL_BASE_URL and KHAN_MODEL_TIMEOUT_MS are read; only the key is required.
 */
export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelConfig | null {
  const apiKey = env.NVIDIA_API_KEY?.trim();
  if (!apiKey) return null;

  const timeoutText = env.KHAN_MODEL_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutText ? Number(timeoutText) : DEFAULT_MODEL_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ModelConfigError(`KHAN_MODEL_TIMEOUT_MS must be a positive whole number of milliseconds, got '${timeoutText}'`);
  }
  const baseUrl = (env.KHAN_MODEL_BASE_URL?.trim() || DEFAULT_MODEL_BASE_URL).replace(/\/+$/, "");
  try {
    new URL(baseUrl);
  } catch {
    throw new ModelConfigError(`KHAN_MODEL_BASE_URL is not a valid URL: '${baseUrl}'`);
  }
  return { apiKey, baseUrl, model: env.KHAN_MODEL?.trim() || DEFAULT_MODEL, timeoutMs };
}

const SNIPPET_LIMIT = 200;
const snippet = (text: string) => (text.length > SNIPPET_LIMIT ? `${text.slice(0, SNIPPET_LIMIT)}…` : text);

/** A client for an OpenAI-compatible chat completions endpoint (NVIDIA's by default). */
export class ModelClient {
  private calls = 0;
  private failures = 0;
  private lastSuccessAt?: string;
  private lastFailure?: { at: string; message: string };

  constructor(
    private readonly config: ModelConfig,
    private readonly clock: () => number = Date.now
  ) {}

  get model(): string {
    return this.config.model;
  }

  health(): ModelHealth {
    return {
      configured: true,
      model: this.config.model,
      calls: this.calls,
      failures: this.failures,
      lastSuccessAt: this.lastSuccessAt,
      lastFailure: this.lastFailure
    };
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    this.calls += 1;
    try {
      const result = await this.request(messages, options);
      this.lastSuccessAt = new Date(this.clock()).toISOString();
      return result;
    } catch (error) {
      this.failures += 1;
      this.lastFailure = { at: new Date(this.clock()).toISOString(), message: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }

  private async request(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
          max_tokens: options.maxTokens ?? 1024,
          temperature: options.temperature ?? 0.2
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs)
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new ModelError("model_timeout", `Model did not answer within ${this.config.timeoutMs}ms`);
      }
      throw new ModelError("model_unreachable", `Could not reach the model endpoint: ${error instanceof Error ? error.message : String(error)}`);
    }

    const raw = await response.text().catch(() => "");
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? " (check NVIDIA_API_KEY)" : "";
      throw new ModelError("model_http_error", `Model endpoint answered HTTP ${response.status}${hint}: ${snippet(raw)}`, response.status);
    }

    let text: unknown;
    try {
      text = (JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
    } catch {
      throw new ModelError("model_bad_response", `Model endpoint did not return JSON: ${snippet(raw)}`);
    }
    if (typeof text !== "string" || !text.trim()) {
      throw new ModelError("model_bad_response", `Model endpoint returned no message text: ${snippet(raw)}`);
    }
    return { text: text.trim(), model: this.config.model };
  }
}
