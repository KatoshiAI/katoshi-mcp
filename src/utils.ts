import type { IncomingMessage } from "node:http";

/**
 * Structured logging for CloudWatch
 */
export function log(level: "info" | "warn" | "error", message: string, metadata?: Record<string, unknown>) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    service: "katoshi-mcp",
    message,
    ...metadata,
  };
  console.log(JSON.stringify(logEntry));
}

/**
 * Helper to mask sensitive data in logs
 */
export function maskApiKey(apiKey?: string): string {
  if (!apiKey) return "none";
  if (apiKey.length <= 8) return "***";
  return `${apiKey.substring(0, 4)}***${apiKey.substring(apiKey.length - 4)}`;
}

/** CORS headers for HTTP responses */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, Api-Key",
};

/**
 * Extract API key/token from headers (Bearer or X-Api-Key / Api-Key).
 */
export function extractTokenFromHeaders(headers: Record<string, string>): string | null {
  const authHeader = headers["authorization"] || headers["Authorization"] || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) return bearerMatch[1];
  const apiKey =
    headers["x-api-key"] ||
    headers["X-Api-Key"] ||
    headers["api-key"] ||
    headers["Api-Key"];
  return apiKey || null;
}

/**
 * Extract API key from query string (api_key or apiKey).
 */
export function extractApiKeyFromQuery(query: Record<string, string> | null): string | null {
  if (!query) return null;
  return query["api_key"] || query["apiKey"] || null;
}

/**
 * Parse URL into pathname and query record.
 */
export function parseUrl(url: string): { pathname: string; query: Record<string, string> } {
  const u = new URL(url, "http://localhost");
  const query: Record<string, string> = {};
  u.searchParams.forEach((v, k) => {
    query[k] = v;
  });
  return { pathname: u.pathname, query };
}

/**
 * Convert IncomingMessage headers to a flat Record<string, string>.
 */
export function headersToRecord(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/**
 * Collect request body from IncomingMessage as a string.
 */
export function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
