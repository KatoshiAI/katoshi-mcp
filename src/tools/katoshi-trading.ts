import type { Tool } from "../mcp-server.js";

/**
 * Katoshi Trading API tools
 * Documentation: https://katoshi.gitbook.io/katoshi-docs/api/actions
 * Endpoint: https://api.katoshi.ai/signal
 */

const KATOSHI_API_BASE_URL = "https://api.katoshi.ai/signal";

/**
 * Execute a trading action via Katoshi Signal API
 */
async function executeTradingAction(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const action = args.action as string;
  const botId = args.bot_id as string | number;
  const apiKey = context?.apiKey;
  const userId = context?.userId;
  const coin = args.coin as string;
  const isBuy = args.is_buy as boolean;
  const reduceOnly = args.reduce_only as boolean;
  
  // Validate user_id is provided
  if (!userId) {
    throw new Error("user_id is required (should be provided as 'id' query parameter in the request URL)");
  }

  // Validate required parameters
  if (!action) {
    throw new Error("action is required (e.g., 'market_order', 'limit_order')");
  }
  if (!botId) {
    throw new Error("bot_id is required");
  }
  if (!apiKey) {
    throw new Error("api_key is required (should be provided via Authorization bearer token)");
  }
  if (!coin) {
    throw new Error("coin is required (e.g., 'BTC', 'ETH')");
  }
  if (typeof isBuy !== "boolean") {
    throw new Error("is_buy is required (true for long/buy, false for short/sell)");
  }
  if (typeof reduceOnly !== "boolean") {
    throw new Error("reduce_only is required (true to only close/reduce, false to allow opening)");
  }

  // Build base payload
  const payload: Record<string, unknown> = {
    action,
    coin,
    is_buy: isBuy,
    reduce_only: reduceOnly,
    bot_id: botId,
    api_key: apiKey,
  };

  // Add size (one of: size, size_usd, size_pct)
  if (args.size !== undefined) {
    payload.size = args.size;
  } else if (args.size_usd !== undefined) {
    payload.size_usd = args.size_usd;
  } else if (args.size_pct !== undefined) {
    payload.size_pct = args.size_pct;
  } else {
    throw new Error("One of size, size_usd, or size_pct is required");
  }

  // Add price for limit orders
  if (action === "limit_order" || action === "stop_market_order") {
    if (args.price === undefined) {
      throw new Error(`price is required for ${action}`);
    }
    payload.price = args.price;
  }

  // Add take-profit and stop-loss (optional)
  if (args.tp_pct !== undefined) {
    payload.tp_pct = args.tp_pct;
  }
  if (args.sl_pct !== undefined) {
    payload.sl_pct = args.sl_pct;
  }
  if (args.tp !== undefined) {
    payload.tp = args.tp;
  }
  if (args.sl !== undefined) {
    payload.sl = args.sl;
  }

  // Add optional parameters
  if (args.slippage_pct !== undefined) {
    payload.slippage_pct = args.slippage_pct;
  }
  if (args.delay !== undefined) {
    payload.delay = args.delay;
  }

  // Build URL with user_id query parameter
  const apiUrl = `${KATOSHI_API_BASE_URL}?id=${encodeURIComponent(userId)}`;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Katoshi API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const data = await response.json();
    return JSON.stringify(data, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to execute trading action: ${errorMessage}`);
  }
}

export const katoshiTradingTools: Tool[] = [
  {
    name: "katoshi_trading_action",
    description:
      "Execute trading actions via Katoshi Signal API. Supports multiple order types: market_order, limit_order, stop_market_order, and more. " +
      "This unified tool allows you to specify the action type and all relevant parameters. " +
      "Use market_order for immediate execution, limit_order for orders at a specific price, and other actions as needed.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            "The order type to execute. Examples: 'market_order', 'limit_order', 'stop_market_order', 'open_position', 'close_position', 'scale_order', 'grid_order', 'modify_tp_sl', 'cancel_tp_sl', 'cancel_order', 'move_order', 'set_leverage', 'adjust_margin', 'close_all', 'cancel_all', 'clear_all', 'sell_all', 'start_bot', 'stop_bot'",
          enum: [
            "market_order",
            "limit_order",
            "stop_market_order",
            "open_position",
            "close_position",
            "scale_order",
            "grid_order",
            "modify_tp_sl",
            "cancel_tp_sl",
            "cancel_order",
            "move_order",
            "set_leverage",
            "adjust_margin",
            "close_all",
            "cancel_all",
            "clear_all",
            "sell_all",
            "start_bot",
            "stop_bot",
          ],
        },
        bot_id: {
          type: ["string", "number"],
          description: "The bot ID to execute the action for",
        },
        coin: {
          type: "string",
          description: "The coin symbol (e.g., 'BTC', 'ETH', 'SOL')",
        },
        is_buy: {
          type: "boolean",
          description:
            "Trade direction: true for long/buy (opens long or closes short), false for short/sell (opens short or closes long)",
        },
        reduce_only: {
          type: "boolean",
          description:
            "If true, only allows closing/reducing position. If false, allows both opening and closing positions. Only available for Perps.",
        },
        size: {
          type: "number",
          description:
            "Size in contracts (e.g., 0.005 for 0.005 BTC). Use one of: size, size_usd, or size_pct",
        },
        size_usd: {
          type: "number",
          description:
            "Size in USD (e.g., 100 for $100 USD). Use one of: size, size_usd, or size_pct",
        },
        size_pct: {
          type: "number",
          description:
            "Size as percentage: when opening (reduce_only=false), percentage of available balance; when closing (reduce_only=true), percentage of current position (e.g., 0.1 for 10%). Use one of: size, size_usd, or size_pct",
        },
        price: {
          type: "number",
          description:
            "Price for limit orders or stop market orders (required for limit_order and stop_market_order actions)",
        },
        tp_pct: {
          type: "number",
          description:
            "Take-profit as percentage from entry (e.g., 0.02 for 2%). Only available for Perps.",
        },
        sl_pct: {
          type: "number",
          description:
            "Stop-loss as percentage from entry (e.g., 0.01 for 1%). Only available for Perps.",
        },
        tp: {
          type: "number",
          description:
            "Take-profit as direct price (e.g., 72500). Only available for Perps.",
        },
        sl: {
          type: "number",
          description:
            "Stop-loss as direct price (e.g., 62500). Only available for Perps.",
        },
        slippage_pct: {
          type: "number",
          description:
            "Maximum slippage percentage allowed (e.g., 0.05 for 5%). Defaults to 5% if not specified.",
        },
        delay: {
          type: "number",
          description:
            "Delay in seconds before triggering the action (max 10 seconds)",
        },
      },
      required: [
        "action",
        "bot_id",
        "coin",
        "is_buy",
        "reduce_only",
      ],
    },
    handler: executeTradingAction,
  },
];

