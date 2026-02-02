import {
  type CallToolResult,
  type SdkToolDefinition,
  toContent,
} from "./tool-common.js";
import { hyperliquidApiTools } from "./hyperliquid-tools.js";
import { katoshiTradingTools } from "./katoshi-tools.js";

// Re-export for consumers that import from tool-registry
export type { CallToolResult, SdkToolDefinition };
export { toContent };

// Combine all tool modules (SDK format: Zod inputSchema + CallToolResult handler)
export const apiTools: SdkToolDefinition[] = [
  ...hyperliquidApiTools,
  ...katoshiTradingTools
];
