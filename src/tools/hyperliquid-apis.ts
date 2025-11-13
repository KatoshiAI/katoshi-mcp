import type { Tool } from "../mcp-server.js";

/**
 * Hyperliquid API tools
 * Documentation: https://api.hyperliquid.xyz/info
 */

/**
 * Retrieve mids for all coins
 * POST https://api.hyperliquid.xyz/info
 * Note: If the book is empty, the last trade price will be used as a fallback
 */
async function getAllMids(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const dex = (args.dex as string) || "";

  try {
    const response = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "allMids",
        dex: dex,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Hyperliquid API error: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    return JSON.stringify(data, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve mids: ${errorMessage}`);
  }
}

export const hyperliquidApiTools: Tool[] = [
  {
    name: "get_all_mids",
    description:
      "Retrieve mids (mid prices) for all coins from Hyperliquid. If the book is empty, the last trade price will be used as a fallback.",
    inputSchema: {
      type: "object",
      properties: {
        dex: {
          type: "string",
          description:
            "Perp dex name. Defaults to empty string which represents the first perp dex. Spot mids are only included with the first perp dex.",
          default: "",
        },
      },
      required: [],
    },
    handler: getAllMids,
  },
];

