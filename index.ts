import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { MCPServer } from "./src/mcp-server.js";

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
 * Validate API key by calling the auth service
 */
async function validateApiKey(apiKey: string): Promise<boolean> {
  const authUrl = process.env.AUTH_URL;
  
  if (!authUrl) {
    console.error("AUTH_URL environment variable is not set");
    return false;
  }

  try {
    const response = await fetch(authUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ api_key: apiKey }),
    });

    return response.ok;
  } catch (error) {
    console.error("Error validating API key:", error);
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
    };
  }

  // API Gateway format
  return {
    method: event.httpMethod || "GET",
    path: event.path || "/",
    body: event.body || null,
    headers: event.headers || {},
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
    const { method, path, body } = normalized;

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
      // Authentication check for MCP requests
      const token = extractBearerToken(normalized.headers);
      
      if (!token) {
        return {
          statusCode: 401,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32001,
              message: "Unauthorized - Missing Authorization bearer token",
            },
          }),
        };
      }

      // Validate the API key
      const isValid = await validateApiKey(token);
      if (!isValid) {
        return {
          statusCode: 401,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32001,
              message: "Unauthorized - Invalid API key",
            },
          }),
        };
      }
      
      let parsedBody: any;
      try {
        parsedBody = body ? JSON.parse(body) : {};
      } catch (parseError) {
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

      // Validate JSON-RPC 2.0 format
      if (!parsedBody.jsonrpc || parsedBody.jsonrpc !== "2.0") {
        return {
          statusCode: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: parsedBody.id || null,
            error: {
              code: -32600,
              message: "Invalid Request - must be JSON-RPC 2.0",
            },
          }),
        };
      }

      // Handle the MCP request
      const response = await server.handleRequest({
        jsonrpc: parsedBody.jsonrpc,
        id: parsedBody.id || null,
        method: parsedBody.method,
        params: parsedBody.params,
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
    console.error("Lambda handler error:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal server error",
        },
      }),
    };
  }
}

