import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiTools } from "./tool-registry.js";
import { log } from "./utils.js";

/**
 * Create a new MCP server instance with all tools registered via server.registerTool().
 * Uses the MCP SDK registerTool(name, config, handler) per
 * https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md
 * - config: title (display name), description, inputSchema, optional outputSchema
 * - SDK validates inputs against inputSchema and optionally output against outputSchema
 * One server per request (stateless); tools get apiKey/userId via getRequestContext() in handlers.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "katoshi-mcp-server",
      version: "1.0.0",
    },
    { capabilities: { tools: {} } }
  );

  for (const tool of apiTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      },
      async (args: Record<string, unknown>, extra: unknown) => {
        log("info", "Tool call", {
          tool: tool.name,
          arguments: args,
        });
        return tool.handler(args, extra as { signal?: AbortSignal; sessionId?: string; _meta?: unknown });
      }
    );
  }

  return server;
}
