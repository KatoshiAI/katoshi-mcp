import type { Tool } from "../mcp-server.js";
import { hyperliquidApiTools } from "./hyperliquid-apis.js";
// Import additional API tools here
// import { userApiTools } from "./user-apis.js";
// import { productApiTools } from "./product-apis.js";

// Combine all your API tools
export const apiTools: Tool[] = [
  ...hyperliquidApiTools,
  // ...userApiTools,
  // ...productApiTools,
];

