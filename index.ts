import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createMcpServer } from "./src/mcp-server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { runWithContextAsync } from "./src/request-context.js";
import { apiTools } from "./src/tool-registry.js";
import {
  CORS_HEADERS,
  collectBody,
  extractApiKeyFromQuery,
  extractTokenFromHeaders,
  headersToRecord,
  log,
  parseUrl,
} from "./src/utils.js";


export interface NormalizedRequest {
  method: string;
  path: string;
  body: string | null;
  headers: Record<string, string>;
  queryStringParameters: Record<string, string> | null;
}

export interface HandlerResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Core request handler for non-MCP routes: OPTIONS, health, and 405.
 * MCP POST requests are handled in onBody via the SDK (Streamable HTTP transport).
 */
export async function handleRequest(normalized: NormalizedRequest): Promise<HandlerResponse> {
  const { method, path } = normalized;

  log("info", "Request received", { method, path });

  if (method === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  if (path === "/health" || (method === "GET" && path === "/")) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({
        status: "healthy",
        service: "katoshi-mcp-server",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.round((Date.now() - SERVER_START_MS) / 1000 * 100) / 100,
        tools: apiTools.length,
        availableTools: apiTools.map((t) => t.name),
      }),
    };
  }

  if (method !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({
        error: "Method not allowed",
        message: "Use POST with JSON-RPC 2.0 format or GET /health for health check",
      }),
    };
  }

  // POST is handled in onBody via SDK; should not reach here when called from onBody for POST
  return {
    statusCode: 405,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify({
      error: "Method not allowed",
      message: "Use POST for MCP requests",
    }),
  };
}

const REQUEST_TIMEOUT_MS = 55_000; // Slightly under typical client timeouts
const SERVER_START_MS = Date.now();

function serve(req: IncomingMessage, res: ServerResponse): void {
  const { pathname, query } = parseUrl(req.url || "/");
  const method = req.method || "GET";
  const headers = headersToRecord(req.headers);
  const requestStart = Date.now();

  // Set timeout for long-running requests
  const timeout = setTimeout(() => {
    if (!res.headersSent && !res.writableEnded) {
      log("warn", "Request timeout", { method, path: pathname, durationMs: REQUEST_TIMEOUT_MS });
      res.writeHead(504, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Request timeout" },
        })
      );
    }
  }, REQUEST_TIMEOUT_MS);

  res.on("finish", () => clearTimeout(timeout));
  res.on("close", () => clearTimeout(timeout));

  const sendResponse = (result: HandlerResponse) => {
    if (res.headersSent || res.writableEnded) return;
    const durationMs = Date.now() - requestStart;
    log("info", "Response sent", {
      method,
      path: pathname,
      statusCode: result.statusCode,
      durationMs,
    });
    res.writeHead(result.statusCode, result.headers);
    res.end(result.body);
  };

  const onBody = (body: string) => {
    const normalized: NormalizedRequest = {
      method,
      path: pathname,
      body: method === "POST" ? body : null,
      headers,
      queryStringParameters: Object.keys(query).length ? query : null,
    };

    // MCP POST: handle with @modelcontextprotocol/sdk (Streamable HTTP)
    if (method === "POST") {
      let parsedBody: unknown;
      try {
        parsedBody = body ? JSON.parse(body) : {};
      } catch {
        sendResponse({
          statusCode: 400,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error - invalid JSON" },
          }),
        });
        return;
      }

      const headerToken = extractTokenFromHeaders(normalized.headers);
      const queryApiKey = extractApiKeyFromQuery(normalized.queryStringParameters);
      const token = headerToken || queryApiKey;
      const userId = normalized.queryStringParameters?.id ?? undefined;
      const frontendApiKey =
        normalized.headers["x-frontend-api-key"] ||
        normalized.headers["X-Frontend-Api-Key"] ||
        undefined;

      if (!token) {
        const reqId =
          typeof parsedBody === "object" &&
          parsedBody !== null &&
          "id" in parsedBody &&
          (typeof (parsedBody as { id?: unknown }).id === "string" ||
            typeof (parsedBody as { id?: unknown }).id === "number")
            ? (parsedBody as { id: string | number }).id
            : null;
        log("error", "Missing API key", {
          method: typeof parsedBody === "object" && parsedBody !== null && "method" in parsedBody ? (parsedBody as { method?: string }).method : undefined,
          userId,
        });
        sendResponse({
          statusCode: 401,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: reqId,
            error: {
              code: -32001,
              message:
                "Unauthorized - Missing API key. Provide via Authorization: Bearer <key>, X-Api-Key header, or api_key query parameter",
            },
          }),
        });
        return;
      }

      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });

      runWithContextAsync(
        { apiKey: token, userId: userId ?? undefined, frontendApiKey },
        async () => {
          await server.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
        }
      ).catch((err) => {
        log("error", "MCP request error", {
          method: pathname,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          durationMs: Date.now() - requestStart,
        });
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(500, { "Content-Type": "application/json", ...CORS_HEADERS });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: "Internal server error" },
            })
          );
        }
      });
      return;
    }

    // OPTIONS, health, or 405
    handleRequest(normalized)
      .then(sendResponse)
      .catch((err) => {
        log("error", "Server error", {
          method,
          path: pathname,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          durationMs: Date.now() - requestStart,
        });
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(500, { "Content-Type": "application/json", ...CORS_HEADERS });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: "Internal server error" },
            })
          );
        }
      });
  };

  if (method === "POST") {
    collectBody(req)
      .then(onBody)
      .catch((err) => {
        log("error", "Failed to collect request body", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(400, { "Content-Type": "application/json", ...CORS_HEADERS });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Failed to read request body" },
            })
          );
        }
      });
  } else {
    onBody("");
  }
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = "::"; // Listen on all interfaces for Railway private network

const server = createServer(serve);

// Graceful shutdown
process.on("SIGTERM", () => {
  log("info", "SIGTERM received, shutting down gracefully");
  server.close(() => {
    log("info", "Server closed");
    process.exit(0);
  });

  // Force close after 10 seconds
  setTimeout(() => {
    log("error", "Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
});

server.listen(PORT, HOST, () => {
  log("info", "Katoshi MCP server listening", { host: HOST, port: PORT });
});
