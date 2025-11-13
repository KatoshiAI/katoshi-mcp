import type { Tool } from "../mcp-server.js";
import { log } from "../utils/logger.js";

/**
 * Katoshi Trading API tools
 * Documentation: https://katoshi.gitbook.io/katoshi-docs/api/actions
 * Endpoint: https://api.katoshi.ai/signal
 */

const KATOSHI_API_BASE_URL = process.env.KATOSHI_API_BASE_URL;

/**
 * Shared helper to execute a trading action via Katoshi Signal API
 */
async function executeAction(
  action: string,
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const startTime = Date.now();
  const apiKey = context?.apiKey;
  const userId = context?.userId;

  // Validate environment variable
  if (!KATOSHI_API_BASE_URL) {
    log("error", "KATOSHI_API_BASE_URL environment variable is not set");
    throw new Error("KATOSHI_API_BASE_URL environment variable is not set");
  }

  // Validate user_id is provided
  if (!userId) {
    throw new Error("user_id is required (should be provided as 'id' query parameter in the request URL)");
  }

  if (!apiKey) {
    throw new Error("api_key is required (should be provided via Authorization bearer token)");
  }

  // Build base payload
  const payload: Record<string, unknown> = {
    action,
    api_key: apiKey,
  };

  // Add bot_id if provided
  if (args.bot_id !== undefined) {
    payload.bot_id = args.bot_id;
  }

  // Add coin if provided
  if (args.coin !== undefined) {
    payload.coin = args.coin;
  }

  // Add is_buy if provided
  if (args.is_buy !== undefined) {
    payload.is_buy = args.is_buy;
  }

  // Add reduce_only if provided
  if (args.reduce_only !== undefined) {
    payload.reduce_only = args.reduce_only;
  }

  // Add size (one of: size, size_usd, size_pct)
  if (args.size !== undefined) {
    payload.size = args.size;
  } else if (args.size_usd !== undefined) {
    payload.size_usd = args.size_usd;
  } else if (args.size_pct !== undefined) {
    payload.size_pct = args.size_pct;
  }

  // Add price if provided
  if (args.price !== undefined) {
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

  // Add leverage if provided
  if (args.leverage !== undefined) {
    payload.leverage = args.leverage;
  }

  // Add is_cross if provided (for set_leverage)
  if (args.is_cross !== undefined) {
    payload.is_cross = args.is_cross;
  }

  // Add amount if provided (for adjust_margin)
  if (args.amount !== undefined) {
    payload.amount = args.amount;
  }

  // Add is_add if provided (for adjust_margin)
  if (args.is_add !== undefined) {
    payload.is_add = args.is_add;
  }

  // Add order_id if provided (for move_order)
  if (args.order_id !== undefined) {
    payload.order_id = args.order_id;
  }

  // Add order_ids if provided (for cancel_order and cancel_all)
  if (args.order_ids !== undefined) {
    payload.order_ids = args.order_ids;
  }

  // Add coins if provided (for bulk operations - array of coins)
  if (args.coins !== undefined) {
    payload.coins = args.coins;
  }

  // Add dexs if provided (for bulk operations - array of DEXs)
  if (args.dexs !== undefined) {
    payload.dexs = args.dexs;
  }

  // Add type if provided (for cancel_tp_sl)
  if (args.type !== undefined) {
    payload.type = args.type;
  }

  // Add scale order parameters (start_price, end_price, num_orders, skew)
  if (args.start_price !== undefined) {
    payload.start_price = args.start_price;
  }
  if (args.end_price !== undefined) {
    payload.end_price = args.end_price;
  }
  if (args.num_orders !== undefined) {
    payload.num_orders = args.num_orders;
  }
  if (args.skew !== undefined) {
    payload.skew = args.skew;
  }

  // Add grid order parameters (price_start, price_end, grids)
  if (args.price_start !== undefined) {
    payload.price_start = args.price_start;
  }
  if (args.price_end !== undefined) {
    payload.price_end = args.price_end;
  }
  if (args.grids !== undefined) {
    payload.grids = args.grids;
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

    const responseTime = Date.now() - startTime;

    if (!response.ok) {
      let errorText: string;
      try {
        errorText = await response.text();
      } catch {
        errorText = "Unable to read error response";
      }

      log("error", "Katoshi API error", {
        action,
        userId,
        botId: args.bot_id,
        coin: args.coin,
        statusCode: response.status,
        errorText: errorText.substring(0, 500),
        responseTimeMs: responseTime,
      });

      throw new Error(
        `Katoshi API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (parseError) {
      log("error", "Failed to parse API response", {
        action,
        userId,
        botId: args.bot_id,
        coin: args.coin,
        statusCode: response.status,
        parseError: parseError instanceof Error ? parseError.message : String(parseError),
        responseTimeMs: responseTime,
      });
      throw new Error(
        `Failed to parse Katoshi API response: ${parseError instanceof Error ? parseError.message : String(parseError)}`
      );
    }

    log("info", "Trading action completed", {
      action,
      userId,
      botId: args.bot_id,
      coin: args.coin,
      statusCode: response.status,
      responseTimeMs: responseTime,
    });

    return JSON.stringify(data, null, 2);
  } catch (error) {
    const responseTime = Date.now() - startTime;

    // Re-throw if it's already our formatted error
    if (error instanceof Error && error.message.includes("Katoshi API error")) {
      throw error;
    }

    log("error", "Failed to execute trading action", {
      action,
      userId,
      botId: args.bot_id,
      coin: args.coin,
      error: error instanceof Error ? error.message : String(error),
      responseTimeMs: responseTime,
    });

    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to execute trading action: ${errorMessage}`);
  }
}

// Handler functions for each tool group
async function placeOrder(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const orderType = args.order_type as string;
  if (!orderType) {
    throw new Error("order_type is required (market_order, limit_order, or stop_market_order)");
  }
  if (!["market_order", "limit_order", "stop_market_order"].includes(orderType)) {
    throw new Error("order_type must be one of: market_order, limit_order, stop_market_order");
  }

  if (!args.bot_id) {
    throw new Error("bot_id is required");
  }
  if (!args.coin) {
    throw new Error("coin is required");
  }
  if (typeof args.is_buy !== "boolean") {
    throw new Error("is_buy is required (true for long/buy, false for short/sell)");
  }
  if (typeof args.reduce_only !== "boolean") {
    throw new Error("reduce_only is required");
  }

  if (args.size === undefined && args.size_usd === undefined && args.size_pct === undefined) {
    throw new Error("One of size, size_usd, or size_pct is required");
  }

  if ((orderType === "limit_order" || orderType === "stop_market_order") && args.price === undefined) {
    throw new Error(`price is required for ${orderType}`);
  }

  return executeAction(orderType, args, context);
}

async function managePosition(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const action = args.action as string;
  if (!action) {
    throw new Error("action is required (open_position or close_position)");
  }
  if (!["open_position", "close_position"].includes(action)) {
    throw new Error("action must be one of: open_position, close_position");
  }

  if (!args.bot_id) {
    throw new Error("bot_id is required");
  }
  if (!args.coin) {
    throw new Error("coin is required");
  }
  // is_buy is required for open_position, optional for close_position (closes both long/short if not specified)
  if (action === "open_position" && typeof args.is_buy !== "boolean") {
    throw new Error("is_buy is required for open_position");
  }

  if (args.size === undefined && args.size_usd === undefined && args.size_pct === undefined) {
    throw new Error("One of size, size_usd, or size_pct is required");
  }

  return executeAction(action, args, context);
}

async function manageOrder(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const action = args.action as string;
  if (!action) {
    throw new Error("action is required");
  }
  if (!["cancel_order", "move_order", "modify_tp_sl", "cancel_tp_sl"].includes(action)) {
    throw new Error("action must be one of: cancel_order, move_order, modify_tp_sl, cancel_tp_sl");
  }

  if (!args.bot_id) {
    throw new Error("bot_id is required");
  }

  // All actions in this tool require coin
  if (!args.coin) {
    throw new Error("coin is required for this action");
  }

  // move_order requires order_id and price
  if (action === "move_order") {
    if (!args.order_id) {
      throw new Error("order_id is required for move_order action");
    }
    if (args.price === undefined) {
      throw new Error("price is required for move_order action");
    }
  }

  // modify_tp_sl requires at least one of: sl_pct, tp_pct, sl, tp
  if (action === "modify_tp_sl") {
    if (
      args.sl_pct === undefined &&
      args.tp_pct === undefined &&
      args.sl === undefined &&
      args.tp === undefined
    ) {
      throw new Error("modify_tp_sl requires at least one of: sl_pct, tp_pct, sl, tp");
    }
  }

  return executeAction(action, args, context);
}

async function advancedStrategy(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const action = args.action as string;
  if (!action) {
    throw new Error("action is required (scale_order or grid_order)");
  }
  if (!["scale_order", "grid_order"].includes(action)) {
    throw new Error("action must be one of: scale_order, grid_order");
  }

  if (!args.bot_id) {
    throw new Error("bot_id is required");
  }
  if (!args.coin) {
    throw new Error("coin is required");
  }
  if (typeof args.is_buy !== "boolean") {
    throw new Error("is_buy is required");
  }
  // reduce_only is required for scale_order, not for grid_order
  if (action === "scale_order" && typeof args.reduce_only !== "boolean") {
    throw new Error("reduce_only is required for scale_order");
  }

  if (args.size === undefined && args.size_usd === undefined && args.size_pct === undefined) {
    throw new Error("One of size, size_usd, or size_pct is required");
  }

  // scale_order requires start_price, end_price, and num_orders
  if (action === "scale_order") {
    if (args.start_price === undefined) {
      throw new Error("start_price is required for scale_order");
    }
    if (args.end_price === undefined) {
      throw new Error("end_price is required for scale_order");
    }
    if (args.num_orders === undefined) {
      throw new Error("num_orders is required for scale_order");
    }
  }

  // grid_order requires price_start, price_end, and grids
  if (action === "grid_order") {
    if (args.price_start === undefined) {
      throw new Error("price_start is required for grid_order");
    }
    if (args.price_end === undefined) {
      throw new Error("price_end is required for grid_order");
    }
    if (args.grids === undefined) {
      throw new Error("grids is required for grid_order");
    }
  }

  return executeAction(action, args, context);
}

async function accountSettings(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const action = args.action as string;
  if (!action) {
    throw new Error("action is required (set_leverage or adjust_margin)");
  }
  if (!["set_leverage", "adjust_margin"].includes(action)) {
    throw new Error("action must be one of: set_leverage, adjust_margin");
  }

  if (!args.bot_id) {
    throw new Error("bot_id is required");
  }
  if (!args.coin) {
    throw new Error("coin is required");
  }

  if (action === "set_leverage") {
    if (args.leverage === undefined) {
      throw new Error("leverage is required for set_leverage");
    }
    if (typeof args.is_cross !== "boolean") {
      throw new Error("is_cross is required for set_leverage (true for Cross margin, false for Isolated margin)");
    }
  }
  if (action === "adjust_margin") {
    if (args.amount === undefined) {
      throw new Error("amount is required for adjust_margin");
    }
    if (typeof args.is_add !== "boolean") {
      throw new Error("is_add is required for adjust_margin (true to add margin, false to remove margin)");
    }
  }

  return executeAction(action, args, context);
}

async function bulkOperations(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const action = args.action as string;
  if (!action) {
    throw new Error("action is required (close_all, cancel_all, clear_all, or sell_all)");
  }
  if (!["close_all", "cancel_all", "clear_all", "sell_all"].includes(action)) {
    throw new Error("action must be one of: close_all, cancel_all, clear_all, sell_all");
  }

  if (!args.bot_id) {
    throw new Error("bot_id is required");
  }

  // dexs is not available for sell_all
  if (action === "sell_all" && args.dexs !== undefined) {
    throw new Error("dexs parameter is not available for sell_all action");
  }

  return executeAction(action, args, context);
}

async function botControl(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const action = args.action as string;
  if (!action) {
    throw new Error("action is required (start_bot or stop_bot)");
  }
  if (!["start_bot", "stop_bot"].includes(action)) {
    throw new Error("action must be one of: start_bot, stop_bot");
  }

  if (!args.bot_id) {
    throw new Error("bot_id is required");
  }

  return executeAction(action, args, context);
}

export const katoshiTradingTools: Tool[] = [
  {
    name: "katoshi_place_order",
    description:
      "Place trading orders: market orders (immediate execution), limit orders (at specific price), or stop market orders (triggered at price). " +
      "Use market_order for immediate execution at current market price, limit_order to set a specific execution price, or stop_market_order to trigger a market order when price reaches a level.",
    inputSchema: {
      type: "object",
      properties: {
        order_type: {
          type: "string",
          enum: ["market_order", "limit_order", "stop_market_order"],
          description: "Type of order to place",
        },
        bot_id: {
          type: ["string", "number"],
          description: "The bot ID to execute the order for",
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
            "Price for limit orders or stop market orders (required for limit_order and stop_market_order)",
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
      },
      required: ["order_type", "bot_id", "coin", "is_buy", "reduce_only"],
    },
    handler: placeOrder,
  },
  {
    name: "katoshi_manage_position",
    description:
      "Manage trading positions: open new positions or close existing positions. " +
      "Use open_position to enter a new trade, or close_position to exit an existing position.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["open_position", "close_position"],
          description: "Action to perform: open_position or close_position",
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
            "Trade direction: For open_position, true opens a long position and false opens a short position. For close_position, true closes long positions and false closes short positions. Required for open_position. Optional for close_position - if not specified, closes both long and short positions for the coin.",
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
            "Size as percentage: when opening, percentage of available balance; when closing, percentage of current position (e.g., 0.1 for 10%). Use one of: size, size_usd, or size_pct",
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
      },
      required: ["action", "bot_id", "coin"],
    },
    handler: managePosition,
  },
  {
    name: "katoshi_manage_order",
    description:
      "Manage individual orders: cancel a specific order, move an order to a new price, or modify/cancel take-profit and stop-loss levels. " +
      "Use cancel_order to cancel a specific order, move_order to adjust order price, modify_tp_sl to update TP/SL levels, or cancel_tp_sl to remove TP/SL. " +
      "For bulk operations like canceling all orders, use katoshi_bulk_operations instead.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["cancel_order", "move_order", "modify_tp_sl", "cancel_tp_sl"],
          description: "Action to perform: cancel_order, move_order, modify_tp_sl, or cancel_tp_sl",
        },
        bot_id: {
          type: ["string", "number"],
          description: "The bot ID to execute the action for",
        },
        coin: {
          type: "string",
          description: "The coin symbol (e.g., 'BTC', 'ETH', 'SOL')",
        },
        order_id: {
          type: ["string", "number"],
          description: "ID of the order to move (required for move_order action)",
        },
        order_ids: {
          type: "array",
          items: {
            type: ["string", "number"],
          },
          description: "List of specific order IDs to cancel (optional for cancel_order - if not specified, all resting orders for the coin will be canceled)",
        },
        price: {
          type: "number",
          description: "New price for move_order action (required for move_order)",
        },
        type: {
          type: "string",
          enum: ["tpsl", "tp", "sl"],
          description:
            "Type of TPSL orders to cancel for cancel_tp_sl action: 'tpsl' cancels all take-profit and stop-loss orders (default), 'tp' cancels all take-profit orders, 'sl' cancels all stop-loss orders. Defaults to 'tpsl' if not specified.",
        },
        tp_pct: {
          type: "number",
          description:
            "Take-profit as percentage from entry (e.g., 0.02 for 2%). Used with modify_tp_sl. At least one of sl_pct, tp_pct, sl, or tp is required for modify_tp_sl. Only available for Perps.",
        },
        sl_pct: {
          type: "number",
          description:
            "Stop-loss as percentage from entry (e.g., 0.01 for 1%). Used with modify_tp_sl. At least one of sl_pct, tp_pct, sl, or tp is required for modify_tp_sl. Only available for Perps.",
        },
        tp: {
          type: "number",
          description:
            "Take-profit as direct price (e.g., 72500). Used with modify_tp_sl. At least one of sl_pct, tp_pct, sl, or tp is required for modify_tp_sl. Only available for Perps.",
        },
        sl: {
          type: "number",
          description:
            "Stop-loss as direct price (e.g., 62500). Used with modify_tp_sl. At least one of sl_pct, tp_pct, sl, or tp is required for modify_tp_sl. Only available for Perps.",
        },
      },
      required: ["action", "bot_id", "coin"],
    },
    handler: manageOrder,
  },
  {
    name: "katoshi_advanced_strategy",
    description:
      "Execute advanced trading strategies: scale orders (gradual entry/exit) or grid orders (automated trading at multiple price levels). " +
      "Use scale_order for DCA (Dollar Cost Averaging) strategies, or grid_order for automated range trading.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["scale_order", "grid_order"],
          description: "Strategy type: scale_order or grid_order",
        },
        bot_id: {
          type: ["string", "number"],
          description: "The bot ID to execute the strategy for",
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
            "If true, only allows closing/reducing position. If false, allows both opening and closing positions. Required for scale_order. Not used for grid_order. Only available for Perps.",
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
        start_price: {
          type: "number",
          description: "Starting price for scale_order - price to place the first limit order (closest to current price). Required for scale_order. Price must be below current coin price for long positions, and above for short positions.",
        },
        end_price: {
          type: "number",
          description: "Ending price for scale_order - price to place the last limit order (farthest from current price). Required for scale_order. Price must be below current coin price for long positions, and above for short positions.",
        },
        num_orders: {
          type: "number",
          description: "Total number of limit orders to place for scale_order. Required for scale_order.",
        },
        skew: {
          type: "number",
          description: "Size difference between first and last limit order for scale_order. A value of 2 makes the last order twice as large as the first. A value of 0.5 makes the first order twice as large as the last. Defaults to 1 (equal order size) if not specified.",
        },
        price_start: {
          type: "number",
          description: "Starting price for grid_order (required for grid_order)",
        },
        price_end: {
          type: "number",
          description: "Ending price for grid_order (required for grid_order)",
        },
        grids: {
          type: "number",
          description: "Number of grid levels for grid_order (required for grid_order)",
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
      },
      required: ["action", "bot_id", "coin", "is_buy"],
    },
    handler: advancedStrategy,
  },
  {
    name: "katoshi_account_settings",
    description:
      "Configure account settings: set leverage for a position or adjust margin. " +
      "Use set_leverage to change the leverage multiplier, or adjust_margin to modify margin allocation.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["set_leverage", "adjust_margin"],
          description: "Action to perform: set_leverage or adjust_margin",
        },
        bot_id: {
          type: ["string", "number"],
          description: "The bot ID to execute the action for",
        },
        coin: {
          type: "string",
          description: "The coin symbol (e.g., 'BTC', 'ETH', 'SOL')",
        },
        leverage: {
          type: "number",
          description: "Leverage multiplier (e.g., 5 for 5x leverage). Required for set_leverage action.",
        },
        is_cross: {
          type: "boolean",
          description: "Margin mode: true for Cross margin, false for Isolated margin. Required for set_leverage action.",
        },
        amount: {
          type: "number",
          description: "Amount in USD to add or remove from margin. Required for adjust_margin action (e.g., 5 for $5 USD).",
        },
        is_add: {
          type: "boolean",
          description: "Whether to add (true) or remove (false) margin. Required for adjust_margin action. true adds amount to margin, false removes amount from margin.",
        },
      },
      required: ["action", "bot_id", "coin"],
    },
    handler: accountSettings,
  },
  {
    name: "katoshi_bulk_operations",
    description:
      "Perform bulk operations across all positions or orders: close all positions, cancel all orders, clear all (positions and orders), or sell all positions. " +
      "Use close_all to close all open positions, cancel_all to cancel all pending orders, clear_all to do both, or sell_all to liquidate all positions.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["close_all", "cancel_all", "clear_all", "sell_all"],
          description: "Bulk action to perform: close_all, cancel_all, clear_all, or sell_all",
        },
        bot_id: {
          type: ["string", "number"],
          description: "The bot ID to execute the action for",
        },
        coins: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional: List of coins to target for the action (e.g., ['BTC', 'ETH', 'HYPE']). If omitted, applies to all coins. Used for cancel_all, close_all, clear_all, and sell_all.",
        },
        is_buy: {
          type: "boolean",
          description:
            "Optional: Trade direction for close_all action. true closes long positions, false closes short positions. If not specified, closes positions in any direction (both long and short). Only used for close_all action.",
        },
        size_pct: {
          type: "number",
          description: "Optional: Size as percentage of current position to close (e.g., 0.1 for 10%). Used for close_all and sell_all actions. If not specified, closes 100% of positions.",
        },
        order_ids: {
          type: "array",
          items: {
            type: ["string", "number"],
          },
          description: "Optional: List of specific order IDs to cancel (for cancel_all action). If not specified, all resting orders for the specified coins will be canceled.",
        },
        dexs: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional: List of DEXs to target (e.g., ['hyperliquid', 'xyz']). If omitted, applies to all available DEXs. Used for cancel_all, close_all, and clear_all. Not available for sell_all.",
        },
      },
      required: ["action", "bot_id"],
    },
    handler: bulkOperations,
  },
  {
    name: "katoshi_bot_control",
    description:
      "Control bot lifecycle: start or stop a trading bot. " +
      "Use start_bot to activate a bot, or stop_bot to deactivate it.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start_bot", "stop_bot"],
          description: "Action to perform: start_bot or stop_bot",
        },
        bot_id: {
          type: ["string", "number"],
          description: "The bot ID to start or stop",
        },
      },
      required: ["action", "bot_id"],
    },
    handler: botControl,
  },
];

