import { getRequestContext } from "./request-context.js";
import { toContent, type SdkToolDefinition } from "./tool-registry.js";
// import * as hl from "@nktkas/hyperliquid"; // SDK disabled - uninstalled

/**
 * Hyperliquid API tools
 * Documentation: https://api.hyperliquid.xyz/info
 * SDK: https://github.com/nktkas/hyperliquid
 *
 * NOTE: Currently disabled - SDK has been uninstalled
 * To re-enable: install @nktkas/hyperliquid and uncomment the code below
 */

// Create a shared InfoClient instance
// const infoClient = new hl.InfoClient({
//   transport: new hl.HttpTransport(),
// });

/**
 * Retrieve mids for all coins
 * Uses the Hyperliquid SDK InfoClient
 * Note: If the book is empty, the last trade price will be used as a fallback
 */
async function getAllMids(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  // SDK disabled - uncomment when re-enabling
  // try {
  //   const data = await infoClient.allMids();
  //   return JSON.stringify(data, null, 2);
  // } catch (error) {
  //   const errorMessage =
  //     error instanceof Error ? error.message : String(error);
  //   throw new Error(`Failed to retrieve mids: ${errorMessage}`);
  // }
  throw new Error("Hyperliquid tools are currently disabled");
}

export const hyperliquidApiTools: SdkToolDefinition[] = [
  {
    name: "get_all_mids",
    title: "Get All Mids",
    description:
      "Retrieve mids (mid prices) for all coins from Hyperliquid using the SDK. If the book is empty, the last trade price will be used as a fallback.",
    inputSchema: {},
    handler: async (args, _extra) => toContent(await getAllMids(args, getRequestContext())),
  },
];
