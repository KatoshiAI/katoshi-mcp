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
