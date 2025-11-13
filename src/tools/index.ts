import type { Tool } from "../mcp-server.js";
import { hyperliquidApiTools } from "./hyperliquid-apis.js";
import { katoshiTradingTools } from "./katoshi-trading.js";
// Import additional API tools here
// import { userApiTools } from "./user-apis.js";
// import { productApiTools } from "./product-apis.js";

// Combine all your API tools
export const apiTools: Tool[] = [
  ...hyperliquidApiTools,
  ...katoshiTradingTools,
  // ...userApiTools,
  // ...productApiTools,
];

