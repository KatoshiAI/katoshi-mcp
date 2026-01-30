import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { MCPServer } from "./src/mcp-server.js";
import { log } from "./src/utils/logger.js";

// Reuse server instance across requests
let mcpServer: MCPServer | null = null;

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
 * Extract API key/token from headers (Bearer or X-Api-Key / Api-Key).
 */
function extractTokenFromHeaders(headers: Record<string, string>): string | null {
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

function extractApiKeyFromQuery(queryStringParameters: Record<string, string> | null): string | null {
  if (!queryStringParameters) return null;
  return queryStringParameters["api_key"] || queryStringParameters["apiKey"] || null;
}

function getMCPServer(): MCPServer {
  if (!mcpServer) {
    mcpServer = new MCPServer();
  }
  return mcpServer;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, Api-Key, Mcp-Session-Id, Accept",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

/**
 * Core request handler: takes a normalized HTTP request and returns the response.
 * Used by both the HTTP server (Railway) and can be reused for tests.
 */
export async function handleRequest(normalized: NormalizedRequest): Promise<HandlerResponse> {
  const server = getMCPServer();
  const { method, path, body, headers, queryStringParameters } = normalized;
  const userId = queryStringParameters?.id ?? null;

  log("info", "Request received", { method, path, userId });

  if (method === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  const isMcpPath = path === "/" || path === "/mcp" || path.startsWith("/mcp/");
  const wantsSse = (headers["accept"] || "").toLowerCase().includes("text/event-stream");

  // Streamable HTTP: GET with Accept: text/event-stream = client opening SSE stream; return SSE
  if (method === "GET" && isMcpPath && wantsSse) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...CORS_HEADERS },
      body: ": keepalive\n\n",
    };
  }

  // Health: GET /health or GET / (when client doesn't want SSE)
  if (path.includes("/health") || (method === "GET" && !path.includes("/mcp"))) {
    const tools = server.getTools();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({
        status: "ok",
        service: "katoshi-mcp-server",
        version: "1.0.0",
        tools: tools.length,
        availableTools: tools.map((t) => t.name),
      }),
    };
  }

  // GET / or GET /mcp without Accept: text/event-stream → health (for backwards compat)
  if (method === "GET" && isMcpPath) {
    const tools = server.getTools();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({
        status: "ok",
        service: "katoshi-mcp-server",
        version: "1.0.0",
        tools: tools.length,
        availableTools: tools.map((t) => t.name),
      }),
    };
  }

  // Streamable HTTP: DELETE terminates session; we're stateless so just ack
  if (method === "DELETE" && isMcpPath) {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  if (method === "POST") {
    let parsedBody: any;
    try {
      parsedBody = body ? JSON.parse(body) : {};
    } catch {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
      };
    }

    const headerToken = extractTokenFromHeaders(headers);
    const queryApiKey = extractApiKeyFromQuery(queryStringParameters);
    const token = headerToken || queryApiKey;

    if (!token) {
      const requestId =
        parsedBody?.id !== undefined &&
        parsedBody?.id !== null &&
        (typeof parsedBody.id === "string" || typeof parsedBody.id === "number")
          ? parsedBody.id
          : null;
      log("error", "Missing API key", { method: parsedBody?.method, userId });
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          error: {
            code: -32001,
            message:
              "Unauthorized - Missing API key. Provide via Authorization: Bearer <key>, X-Api-Key header, or api_key query parameter",
          },
        }),
      };
    }

    if (!parsedBody.jsonrpc || parsedBody.jsonrpc !== "2.0") {
      const requestId =
        parsedBody?.id !== undefined &&
        parsedBody?.id !== null &&
        (typeof parsedBody.id === "string" || typeof parsedBody.id === "number")
          ? parsedBody.id
          : null;
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          error: { code: -32600, message: "Invalid Request - must be JSON-RPC 2.0" },
        }),
      };
    }

    const requestId =
      parsedBody.id !== undefined &&
      parsedBody.id !== null &&
      (typeof parsedBody.id === "string" || typeof parsedBody.id === "number")
        ? parsedBody.id
        : null;

    log("info", "Processing MCP request", { method: parsedBody.method, userId, requestId });

    try {
      const response = await server.handleRequest({
        jsonrpc: parsedBody.jsonrpc,
        id: requestId,
        method: parsedBody.method,
        params: parsedBody.params,
        context: { apiKey: token, userId: userId || undefined },
      });

      log("info", "MCP request completed", {
        method: parsedBody.method,
        userId,
        requestId,
        hasError: !!response.error,
      });

      // Streamable HTTP: return Mcp-Session-Id on initialize so client can send it on subsequent requests
      const responseHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      };
      if (parsedBody.method === "initialize" && response.result) {
        responseHeaders["Mcp-Session-Id"] = randomUUID();
      }

      return {
        statusCode: 200,
        headers: responseHeaders,
        body: JSON.stringify(response),
      };
    } catch (error) {
      log("error", "MCP request error", {
        error: error instanceof Error ? error.message : String(error),
        requestId,
      });
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal server error",
          },
        }),
      };
    }
  }

  return {
    statusCode: 404,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify({
      error: "Not found",
      message: "Use POST with JSON-RPC 2.0 format or GET /health for health check",
    }),
  };
}

function parseUrl(url: string): { pathname: string; query: Record<string, string> } {
  const u = new URL(url, "http://localhost");
  const query: Record<string, string> = {};
  u.searchParams.forEach((v, k) => {
    query[k] = v;
  });
  return { pathname: u.pathname, query };
}

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function headersToRecord(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

const REQUEST_TIMEOUT_MS = 55_000; // Slightly under typical client timeouts so we respond before client cancels

function serve(req: IncomingMessage, res: ServerResponse): void {
  const { pathname, query } = parseUrl(req.url || "/");
  const method = req.method || "GET";
  const headers = headersToRecord(req.headers);
  const requestStart = Date.now();

  const timeout = setTimeout(() => {
    if (!res.headersSent) {
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
    if (res.headersSent) return;
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
    handleRequest(normalized)
      .then((result) => {
        sendResponse(result);
      })
      .catch((err) => {
        log("error", "Server error", {
          method,
          path: pathname,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - requestStart,
        });
        if (!res.headersSent) {
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
    collectBody(req).then(onBody);
  } else {
    onBody("");
  }
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0"; // Listen on all interfaces for Railway private network

const server = createServer(serve);

server.listen(PORT, HOST, () => {
  log("info", "Katoshi MCP server listening", { host: HOST, port: PORT });
});
