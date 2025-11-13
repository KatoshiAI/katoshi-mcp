import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { MCPServer } from "./src/mcp-server.js";
import { log } from "./src/utils/logger.js";

// Reuse server instance across Lambda invocations (warm starts)
let mcpServer: MCPServer | null = null;

/**
 * Extract bearer token from Authorization header
 */
function extractBearerToken(headers: Record<string, string>): string | null {
  const authHeader = headers["authorization"] || headers["Authorization"] || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Extract API key from query parameters
 */
function extractApiKeyFromQuery(queryStringParameters: Record<string, string> | null): string | null {
  if (!queryStringParameters) {
    return null;
  }
  return queryStringParameters["api_key"] || queryStringParameters["apiKey"] || null;
}

/**
 * Validate API key by calling the auth service
 */
async function validateApiKey(apiKey: string, userId?: string): Promise<boolean> {
  const authUrl = process.env.AUTH_URL;
  
  if (!authUrl) {
    log("error", "AUTH_URL environment variable is not set");
    return false;
  }

  try {
    const body: Record<string, string> = { api_key: apiKey };
    if (userId) {
      body.user_id = userId;
    }

    const response = await fetch(authUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      log("error", "API key validation failed", {
        userId,
        statusCode: response.status,
      });
    }

    return response.ok;
  } catch (error) {
    log("error", "Error validating API key", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Initialize MCP server (reused across Lambda invocations for better performance)
 */
function getMCPServer(): MCPServer {
  if (!mcpServer) {
    mcpServer = new MCPServer();
  }
  return mcpServer;
}

/**
 * Normalize event from either API Gateway or Lambda Function URL
 */
function normalizeEvent(event: any): {
  method: string;
  path: string;
  body: string | null;
  headers: Record<string, string>;
  queryStringParameters: Record<string, string> | null;
} {
  // Lambda Function URL format (version 2.0)
  if (event.requestContext && event.requestContext.http) {
    return {
      method: event.requestContext.http.method || event.requestContext.httpMethod || "GET",
      path: event.rawPath || event.path || "/",
      body: event.isBase64Encoded
        ? Buffer.from(event.body || "", "base64").toString("utf-8")
        : event.body || null,
      headers: event.headers || {},
      queryStringParameters: event.queryStringParameters || null,
    };
  }

  // API Gateway format
  return {
    method: event.httpMethod || "GET",
    path: event.path || "/",
    body: event.body || null,
    headers: event.headers || {},
    queryStringParameters: event.queryStringParameters || null,
  };
}

/**
 * Lambda handler for API Gateway HTTP API and Lambda Function URLs
 * Handles MCP JSON-RPC 2.0 protocol messages over HTTP
 */
export async function handler(
  event: APIGatewayProxyEvent | any
): Promise<APIGatewayProxyResult> {
  const server = getMCPServer();

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  try {
    const normalized = normalizeEvent(event);
    const { method, path, body, queryStringParameters } = normalized;
    
    // Extract user_id from query parameters
    const userId = queryStringParameters?.id || null;

    log("info", "Request received", {
      method,
      path,
      userId,
    });

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: "",
      };
    }

    // Health check endpoint (no auth required)
    if (path.includes("/health") || (method === "GET" && !path.includes("/mcp"))) {
      const tools = server.getTools();
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
        body: JSON.stringify({
          status: "ok",
          service: "katoshi-mcp-server",
          version: "1.0.0",
          tools: tools.length,
          availableTools: tools.map((t) => t.name),
        }),
      };
    }

    // Handle MCP protocol messages (POST requests with JSON-RPC)
    if (method === "POST") {
      // Parse body first to extract request id for error responses
      let parsedBody: any;
      try {
        parsedBody = body ? JSON.parse(body) : {};
      } catch (parseError) {
        // For parse errors, we can't extract the id, so we return null
        // This is acceptable per JSON-RPC 2.0 spec for parse errors
        return {
          statusCode: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32700,
              message: "Parse error",
            },
          }),
        };
      }

      // Authentication check for MCP requests
      // Try bearer token first, then fall back to query parameter
      const bearerToken = extractBearerToken(normalized.headers);
      const queryApiKey = extractApiKeyFromQuery(queryStringParameters);
      const token = bearerToken || queryApiKey;
      
      if (!token) {
        // Preserve the request id if it exists and is valid
        const requestId = parsedBody?.id !== undefined && 
                         parsedBody?.id !== null && 
                         (typeof parsedBody.id === 'string' || typeof parsedBody.id === 'number')
          ? parsedBody.id 
          : null;
        
        log("error", "Missing API key", {
          method: parsedBody?.method,
          userId,
        });
        
        return {
          statusCode: 401,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            error: {
              code: -32001,
              message: "Unauthorized - Missing API key. Provide via Authorization bearer token or api_key query parameter",
            },
          }),
        };
      }

      // Validate the API key
      const isValid = await validateApiKey(token, userId || undefined);
      if (!isValid) {
        // Preserve the request id if it exists and is valid
        const requestId = parsedBody?.id !== undefined && 
                         parsedBody?.id !== null && 
                         (typeof parsedBody.id === 'string' || typeof parsedBody.id === 'number')
          ? parsedBody.id 
          : null;
        
        log("error", "Invalid API key", {
          method: parsedBody?.method,
          userId,
        });
        
        return {
          statusCode: 401,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            error: {
              code: -32001,
              message: "Unauthorized - Invalid API key",
            },
          }),
        };
      }

      // Validate JSON-RPC 2.0 format
      if (!parsedBody.jsonrpc || parsedBody.jsonrpc !== "2.0") {
        // Preserve the request id if it exists and is valid
        const requestId = parsedBody?.id !== undefined && 
                         parsedBody?.id !== null && 
                         (typeof parsedBody.id === 'string' || typeof parsedBody.id === 'number')
          ? parsedBody.id 
          : null;
        
        return {
          statusCode: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            error: {
              code: -32600,
              message: "Invalid Request - must be JSON-RPC 2.0",
            },
          }),
        };
      }

      // Extract and validate the request id
      // JSON-RPC 2.0 requires id to be string, number, or null (for notifications)
      const requestId = parsedBody.id !== undefined && 
                       parsedBody.id !== null && 
                       (typeof parsedBody.id === 'string' || typeof parsedBody.id === 'number')
        ? parsedBody.id 
        : null;

      // Handle the MCP request
      log("info", "Processing MCP request", {
        method: parsedBody.method,
        userId,
        requestId,
      });

      const response = await server.handleRequest({
        jsonrpc: parsedBody.jsonrpc,
        id: requestId,
        method: parsedBody.method,
        params: parsedBody.params,
        context: {
          apiKey: token,
          userId: userId || undefined,
        },
      });

      log("info", "MCP request completed", {
        method: parsedBody.method,
        userId,
        requestId,
        hasError: !!response.error,
      });

      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
        body: JSON.stringify(response),
      };
    }

    // 404 for unknown endpoints
    return {
      statusCode: 404,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
      body: JSON.stringify({
        error: "Not found",
        message: "Use POST with JSON-RPC 2.0 format or GET /health for health check",
      }),
    };
  } catch (error) {
    // Try to extract request id from event if possible
    let requestId: string | number | null = null;
    try {
      const normalized = normalizeEvent(event);
      if (normalized.body) {
        const parsedBody = JSON.parse(normalized.body);
        if (parsedBody?.id !== undefined && 
            parsedBody?.id !== null && 
            (typeof parsedBody.id === 'string' || typeof parsedBody.id === 'number')) {
          requestId = parsedBody.id;
        }
      }
    } catch {
      // If we can't parse, use null
    }

    log("error", "Lambda handler error", {
      error: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      requestId,
    });
    
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
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

