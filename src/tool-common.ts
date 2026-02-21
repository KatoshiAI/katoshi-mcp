import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";

/**
 * Result shape returned by MCP tool handlers (SDK CallToolResult).
 * Use content for text; use structuredContent when the tool has an outputSchema (per SDK docs).
 */
export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  /** Optional; required when the tool is registered with outputSchema (SDK validates it). */
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * SDK-style tool definition for server.registerTool(name, config, handler) per MCP SDK docs.
 * config: title (display name), description, inputSchema, optional outputSchema.
 * Handlers receive (args, extra); use getRequestContext() for apiKey/userId.
 */
export interface SdkToolDefinition {
  name: string;
  /** Human-readable display name (recommended by MCP SDK for tools). */
  title?: string;
  description: string;
  /** Zod raw shape for input - e.g. { bot_id: z.number(), coin: z.string() } */
  inputSchema: ZodRawShapeCompat;
  /** Optional Zod raw shape for output; when set, handler should return structuredContent. */
  outputSchema?: ZodRawShapeCompat;
  handler: (
    args: Record<string, unknown>,
    _extra: { signal?: AbortSignal; sessionId?: string; _meta?: unknown }
  ) => Promise<CallToolResult>;
}

/** Shared helper for tools that return plain text. */
export function toContent(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Coerce numeric-like input to number for schema parsing and payload normalization.
 * Accepts finite numbers and non-empty numeric strings (e.g. "10", "2.5").
 * Returns original value when coercion is not possible.
 */
export function coerceNumberInput(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return value;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}

/**
 * Coerce array-like input for tolerant agent calls.
 * Accepts actual arrays, JSON-stringified arrays, comma-separated strings, and single values.
 */
export function coerceArrayInput(value: unknown): unknown {
  if (Array.isArray(value) || value === null || value === undefined) return value;
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (trimmed === "") return value;
  if (trimmed.toLowerCase() === "null") return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) || parsed === null) return parsed;
  } catch {
    // Fall through to relaxed parsing.
  }

  if (trimmed.includes(",")) {
    const values = trimmed.split(",").map((v) => v.trim()).filter(Boolean);
    return values.length > 0 ? values : value;
  }

  return [trimmed];
}
