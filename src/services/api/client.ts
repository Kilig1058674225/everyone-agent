import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_USER_AGENT =
  process.env.ANTHROPIC_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
export const DEFAULT_MODEL =
  process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

function readNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export const DEFAULT_MAX_TOKENS = readNumberEnv("MODEL_MAX_TOKENS", 128000);

let clientInstance: Anthropic | null = null;

export function normalizeAnthropicBaseURL(
  baseURL: string | undefined,
): string | undefined {
  if (!baseURL) {
    return undefined;
  }

  const trimmed = baseURL.trim().replace(/\/+$/, "");

  if (trimmed.endsWith("/v1/messages")) {
    return trimmed.slice(0, -"/v1/messages".length);
  }

  if (trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -"/v1".length);
  }

  return trimmed;
}

export function getAnthropicClient(options?: {
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}): Anthropic {
  if (clientInstance && !options) {
    return clientInstance;
  }

  const client = new Anthropic({
    apiKey: options?.apiKey ?? process.env.ANTHROPIC_API_KEY,
    authToken: options?.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN,
    baseURL: normalizeAnthropicBaseURL(
      options?.baseURL ?? process.env.ANTHROPIC_BASE_URL,
    ),
    defaultHeaders: {
      "User-Agent": DEFAULT_USER_AGENT,
      ...options?.headers,
    },
  });

  if (!options) {
    clientInstance = client;
  }

  return client;
}
