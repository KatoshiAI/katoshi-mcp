import { apiTools } from "./tools/index.js";

// MCP Tool type definition
export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  handler: (args: Record<string, unknown>, context?: { apiKey?: string; userId?: string }) => Promise<string>;
}

/**
 * MCP Server implementation for HTTP/API Gateway
 * Handles JSON-RPC 2.0 protocol messages over HTTP
 */
export class MCPServer {
  private tools: Map<string, Tool>;

  constructor() {
    this.tools = new Map();
    this.registerTools();
  }

  private registerTools() {
    // Register all API tools
    for (const tool of apiTools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Handle JSON-RPC 2.0 request
   */
  async handleRequest(request: {
    jsonrpc: string;
    id: string | number | null;
    method: string;
    params?: any;
    context?: { apiKey?: string; userId?: string };
  }): Promise<any> {
    const { method, params, id } = request;

    // Ensure id is valid (string, number, or null for notifications)
    // JSON-RPC 2.0 requires id to be preserved in responses
    // For methods that require responses (like initialize), id should always be present
    const responseId = (id !== null && id !== undefined && 
                        (typeof id === 'string' || typeof id === 'number')) 
      ? id 
      : null;

    // Methods that require a response must have a valid id
    const methodsRequiringResponse = ['initialize', 'tools/list', 'tools/call'];
    if (methodsRequiringResponse.includes(method) && responseId === null) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: `Invalid Request: method '${method}' requires a valid id`,
        },
      };
    }

    try {
      let result: any;

      switch (method) {
        case "initialize":
          result = {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "katoshi-mcp-server",
              version: "1.0.0",
            },
          };
          break;

        case "tools/list":
          result = {
            tools: Array.from(this.tools.values()).map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          };
          break;

        case "tools/call":
          if (!params || !params.name) {
            throw new Error("Tool name is required");
          }

          const tool = this.tools.get(params.name);
          if (!tool) {
            throw new Error(`Tool ${params.name} not found`);
          }

          if (!tool.handler) {
            throw new Error(`Tool ${params.name} has no handler`);
          }

          const toolResult = await tool.handler(
            params.arguments || {},
            request.context
          );
          result = {
            content: [
              {
                type: "text",
                text: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
              },
            ],
          };
          break;

        default:
          throw new Error(`Method ${method} not found`);
      }

      // For successful responses, id must match the request id
      // If id is null, this is a notification and shouldn't get a response
      // But we'll still return it to be safe
      return {
        jsonrpc: "2.0",
        id: responseId,
        result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        jsonrpc: "2.0",
        id: responseId,
        error: {
          code: -32603,
          message: errorMessage,
        },
      };
    }
  }

  /**
   * Get all registered tools
   */
  getTools(): Tool[] {
    return Array.from(this.tools.values());
  }
}

