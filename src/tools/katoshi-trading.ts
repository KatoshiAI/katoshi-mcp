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

  if (!KATOSHI_API_BASE_URL) {
    log("error", "KATOSHI_API_BASE_URL environment variable is not set");
    throw new Error("KATOSHI_API_BASE_URL environment variable is not set");
  }

  if (!userId) {
    throw new Error("user_id is required (should be provided as 'id' query parameter in the request URL)");
  }

  if (!apiKey) {
    throw new Error("api_key is required (should be provided via Authorization bearer token)");
  }

  /** Only add to payload if value is not undefined, null, 0 (number), "" (string), or [] (array). */
  function setIfValid(p: Record<string, unknown>, key: string, value: unknown): void {
    if (value === undefined || value === null) return;
    if (typeof value === "number" && value === 0) return;
    if (typeof value === "string" && value === "") return;
    if (Array.isArray(value) && value.length === 0) return;
    p[key] = value;
  }

  /** Like setIfValid but allows 0 (number). Use for fields where 0 is valid (e.g. stop-loss). */
  function setIfValidAllowZero(p: Record<string, unknown>, key: string, value: unknown): void {
    if (value === undefined || value === null) return;
    if (typeof value === "string" && value === "") return;
    if (Array.isArray(value) && value.length === 0) return;
    p[key] = value;
  }

  const payload: Record<string, unknown> = {
    action,
    api_key: apiKey,
  };

  setIfValid(payload, "bot_id", args.bot_id);
  setIfValid(payload, "coin", args.coin);
  setIfValid(payload, "coins", args.coins);
  setIfValid(payload, "is_buy", args.is_buy);
  setIfValid(payload, "reduce_only", args.reduce_only);
  // Send at most one size parameter; skip empty/0/null
  const sizeUsd = args.size_usd !== undefined && args.size_usd !== null && Number(args.size_usd) !== 0 ? args.size_usd : undefined;
  const size = args.size !== undefined && args.size !== null && Number(args.size) !== 0 ? args.size : undefined;
  const sizePct = args.size_pct !== undefined && args.size_pct !== null && Number(args.size_pct) !== 0 ? args.size_pct : undefined;
  if (sizeUsd !== undefined) {
    payload.size_usd = sizeUsd;
  } else if (size !== undefined) {
    payload.size = size;
  } else if (sizePct !== undefined) {
    payload.size_pct = sizePct;
  }
  setIfValid(payload, "price", args.price);
  setIfValid(payload, "tp_pct", args.tp_pct);
  setIfValid(payload, "tp", args.tp);
  setIfValidAllowZero(payload, "sl_pct", args.sl_pct);
  setIfValidAllowZero(payload, "sl", args.sl);
  setIfValid(payload, "slippage_pct", args.slippage_pct);
  setIfValid(payload, "leverage", args.leverage);
  setIfValid(payload, "is_cross", args.is_cross);
  setIfValid(payload, "amount", args.amount);
  setIfValid(payload, "is_add", args.is_add);
  setIfValid(payload, "order_id", args.order_id);
  setIfValid(payload, "order_ids", args.order_ids);
  setIfValid(payload, "dexs", args.dexs);
  setIfValid(payload, "type", args.type);
  setIfValid(payload, "start_price", args.start_price);
  setIfValid(payload, "end_price", args.end_price);
  setIfValid(payload, "num_orders", args.num_orders);
  setIfValid(payload, "skew", args.skew);
  setIfValid(payload, "price_start", args.price_start);
  setIfValid(payload, "price_end", args.price_end);
  setIfValid(payload, "grids", args.grids);

  const apiUrl = `${KATOSHI_API_BASE_URL}?id=${encodeURIComponent(userId)}`;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      throw new Error(`Katoshi API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (parseError) {
      log("error", "Failed to parse API response", {
        action,
        userId,
        parseError: parseError instanceof Error ? parseError.message : String(parseError),
      });
      throw new Error(
        `Failed to parse Katoshi API response: ${parseError instanceof Error ? parseError.message : String(parseError)}`
      );
    }

    log("info", "Trading action completed", { action, userId, botId: args.bot_id, coin: args.coin, responseTimeMs: responseTime });
    return JSON.stringify(data, null, 2);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Katoshi API error")) throw error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to execute trading action: ${errorMessage}`);
  }
}

// --- Handlers (each calls executeAction with fixed action) ---

function requireSize(args: Record<string, unknown>): void {
  if (args.size === undefined && args.size_usd === undefined && args.size_pct === undefined) {
    throw new Error("One of size, size_usd, or size_pct is required");
  }
}

async function openPosition(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  if (!args.coin) throw new Error("coin is required");
  if (typeof args.is_buy !== "boolean") throw new Error("is_buy is required (true for long, false for short)");
  requireSize(args);
  return executeAction("open_position", args, context);
}

async function closePosition(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  if (!args.coin) throw new Error("coin is required");
  requireSize(args);
  return executeAction("close_position", args, context);
}

async function marketOrder(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  if (!args.coin) throw new Error("coin is required");
  if (typeof args.is_buy !== "boolean") throw new Error("is_buy is required");
  if (typeof args.reduce_only !== "boolean") throw new Error("reduce_only is required");
  requireSize(args);
  return executeAction("market_order", args, context);
}

async function limitOrder(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  if (!args.coin) throw new Error("coin is required");
  if (typeof args.is_buy !== "boolean") throw new Error("is_buy is required");
  if (typeof args.reduce_only !== "boolean") throw new Error("reduce_only is required");
  if (args.price === undefined) throw new Error("price is required for limit_order");
  requireSize(args);
  return executeAction("limit_order", args, context);
}

async function stopMarketOrder(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  if (!args.coin) throw new Error("coin is required");
  if (typeof args.is_buy !== "boolean") throw new Error("is_buy is required");
  if (typeof args.reduce_only !== "boolean") throw new Error("reduce_only is required");
  if (args.price === undefined) throw new Error("price is required for stop_market_order");
  requireSize(args);
  return executeAction("stop_market_order", args, context);
}

async function scaleOrder(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  if (!args.coin) throw new Error("coin is required");
  if (typeof args.is_buy !== "boolean") throw new Error("is_buy is required");
  if (typeof args.reduce_only !== "boolean") throw new Error("reduce_only is required for scale_order");
  if (args.start_price === undefined) throw new Error("start_price is required for scale_order");
  if (args.end_price === undefined) throw new Error("end_price is required for scale_order");
  if (args.num_orders === undefined) throw new Error("num_orders is required for scale_order");
  requireSize(args);
  return executeAction("scale_order", args, context);
}

async function gridOrder(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  if (!args.coin) throw new Error("coin is required");
  if (typeof args.is_buy !== "boolean") throw new Error("is_buy is required");
  if (args.price_start === undefined) throw new Error("price_start is required for grid_order");
  if (args.price_end === undefined) throw new Error("price_end is required for grid_order");
  if (args.grids === undefined) throw new Error("grids is required for grid_order");
  requireSize(args);
  return executeAction("grid_order", args, context);
}

async function moveOrder(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  if (!args.coin) throw new Error("coin is required");
  if (!args.order_id) throw new Error("order_id is required for move_order");
  if (args.price === undefined) throw new Error("price is required for move_order");
  return executeAction("move_order", args, context);
}

async function cancelOrder(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  if (!args.coin) throw new Error("coin is required");
  return executeAction("cancel_order", args, context);
}

async function closeAll(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  return executeAction("close_all", args, context);
}

async function sellAll(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  return executeAction("sell_all", args, context);
}

async function clearAll(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  return executeAction("clear_all", args, context);
}

async function cancelAll(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  return executeAction("cancel_all", args, context);
}

async function setLeverage(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  if (!args.coin) throw new Error("coin is required");
  if (args.leverage === undefined) throw new Error("leverage is required for set_leverage");
  if (typeof args.is_cross !== "boolean") throw new Error("is_cross is required for set_leverage");
  return executeAction("set_leverage", args, context);
}

async function adjustMargin(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  if (!args.coin) throw new Error("coin is required");
  if (args.amount === undefined) throw new Error("amount is required for adjust_margin");
  if (typeof args.is_add !== "boolean") throw new Error("is_add is required for adjust_margin");
  return executeAction("adjust_margin", args, context);
}

async function startBot(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  return executeAction("start_bot", args, context);
}

async function stopBot(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  return executeAction("stop_bot", args, context);
}

async function modifyTpsl(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  if (!args.coin) throw new Error("coin is required");
  if (
    args.sl_pct === undefined &&
    args.tp_pct === undefined &&
    args.sl === undefined &&
    args.tp === undefined
  ) {
    throw new Error("modify_tpsl requires at least one of: sl_pct, tp_pct, sl, tp");
  }
  return executeAction("modify_tp_sl", args, context);
}

async function cancelTpsl(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  if (!args.coin) throw new Error("coin is required");
  return executeAction("cancel_tp_sl", args, context);
}

// --- Common schema fragments ---

const botIdProp = {
  type: "string" as const,
  description: "The bot ID to execute the action for",
};

const coinProp = {
  type: "string" as const,
  description: "The coin symbol (e.g., 'BTC', 'ETH', 'SOL')",
};

const isBuyProp = {
  type: "boolean" as const,
  description: "Trade direction: true for long/buy, false for short/sell",
};

const reduceOnlyProp = {
  type: "boolean" as const,
  description: "If true, only close/reduce. If false, can open or close. Perps only.",
};

const sizeProps = {
  size: {
    type: "number" as const,
    description: "Size in contracts (e.g. 0.005). Provide exactly one of size, size_usd, or size_pct.",
  },
  size_usd: {
    type: "number" as const,
    description: "Size in USD (e.g. 11). Provide exactly one of size, size_usd, or size_pct.",
  },
  size_pct: {
    type: "number" as const,
    description: "Size as fraction (e.g. 0.1 for 10%). Provide exactly one of size, size_usd, or size_pct.",
  },
};

const tpslProps = {
  tp_pct: { type: "number" as const, description: "Take-profit as % from entry (e.g., 0.02 for 2%). Perps only." },
  sl_pct: { type: "number" as const, description: "Stop-loss as % from entry (e.g., 0.01 for 1%). Perps only." },
  tp: { type: "number" as const, description: "Take-profit as price (e.g., 72500). Perps only." },
  sl: { type: "number" as const, description: "Stop-loss as price (e.g., 62500). Perps only." },
};

const slippageProp = {
  type: "number" as const,
  description: "Max slippage % (e.g., 0.05 for 5%). Defaults to 5% if not set.",
};

export const katoshiTradingTools: Tool[] = [
  {
    name: "katoshi_open_position",
    description: "Open a new long or short position for a coin. Require exactly one of size, size_usd, or size_pct. Optional: tp_pct, sl_pct (e.g. 0.01 for 1%, 0.05 for 5%).",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coin: coinProp,
        is_buy: isBuyProp,
        ...sizeProps,
        ...tpslProps,
        slippage_pct: slippageProp,
      },
      required: ["bot_id", "coin", "is_buy"],
    },
    handler: openPosition,
  },
  {
    name: "katoshi_close_position",
    description: "Close an existing position (fully or partially). Optionally restrict to long or short via is_buy; if omitted, closes both.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coin: coinProp,
        is_buy: { type: "boolean" as const, description: "Optional: true = close long, false = close short; omit to close both." },
        ...sizeProps,
        ...tpslProps,
        slippage_pct: slippageProp,
      },
      required: ["bot_id", "coin"],
    },
    handler: closePosition,
  },
  {
    name: "katoshi_market_order",
    description: "Place a market order (immediate execution at current market price).",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coin: coinProp,
        is_buy: isBuyProp,
        reduce_only: reduceOnlyProp,
        ...sizeProps,
        ...tpslProps,
        slippage_pct: slippageProp,
      },
      required: ["bot_id", "coin", "is_buy", "reduce_only"],
    },
    handler: marketOrder,
  },
  {
    name: "katoshi_limit_order",
    description: "Place a limit order at a specific price.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coin: coinProp,
        is_buy: isBuyProp,
        reduce_only: reduceOnlyProp,
        ...sizeProps,
        price: { type: "number" as const, description: "Limit price for the order." },
        ...tpslProps,
        slippage_pct: slippageProp,
      },
      required: ["bot_id", "coin", "is_buy", "reduce_only", "price"],
    },
    handler: limitOrder,
  },
  {
    name: "katoshi_stop_market_order",
    description: "Place a stop market order that triggers a market order when price reaches the trigger level.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coin: coinProp,
        is_buy: isBuyProp,
        reduce_only: reduceOnlyProp,
        ...sizeProps,
        price: { type: "number" as const, description: "Trigger price for the stop." },
        ...tpslProps,
        slippage_pct: slippageProp,
      },
      required: ["bot_id", "coin", "is_buy", "reduce_only", "price"],
    },
    handler: stopMarketOrder,
  },
  {
    name: "katoshi_scale_order",
    description: "Place a scale (DCA) order: multiple limit orders between start_price and end_price.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coin: coinProp,
        is_buy: isBuyProp,
        reduce_only: reduceOnlyProp,
        ...sizeProps,
        start_price: { type: "number" as const, description: "Price of first order (closest to current price)." },
        end_price: { type: "number" as const, description: "Price of last order." },
        num_orders: { type: "number" as const, description: "Number of limit orders." },
        skew: { type: "number" as const, description: "Size skew between first and last order (e.g., 2 = last 2x first). Default 1." },
        ...tpslProps,
        slippage_pct: slippageProp,
      },
      required: ["bot_id", "coin", "is_buy", "reduce_only", "start_price", "end_price", "num_orders"],
    },
    handler: scaleOrder,
  },
  {
    name: "katoshi_grid_order",
    description: "Place a grid order: automated orders at multiple price levels between price_start and price_end.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coin: coinProp,
        is_buy: isBuyProp,
        ...sizeProps,
        price_start: { type: "number" as const, description: "Start of grid price range." },
        price_end: { type: "number" as const, description: "End of grid price range." },
        grids: { type: "number" as const, description: "Number of grid levels." },
        ...tpslProps,
        slippage_pct: slippageProp,
      },
      required: ["bot_id", "coin", "is_buy", "price_start", "price_end", "grids"],
    },
    handler: gridOrder,
  },
  {
    name: "katoshi_move_order",
    description: "Move an existing order to a new price.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coin: coinProp,
        order_id: { type: "string" as const, description: "ID of the order to move." },
        price: { type: "number" as const, description: "New price for the order." },
      },
      required: ["bot_id", "coin", "order_id", "price"],
    },
    handler: moveOrder,
  },
  {
    name: "katoshi_cancel_order",
    description: "Cancel one or more resting orders for a coin. Optionally pass order_ids to cancel specific orders; otherwise cancels all resting orders for the coin.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coin: coinProp,
        order_ids: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Optional: specific order IDs to cancel. If omitted, all resting orders for the coin are canceled.",
        },
      },
      required: ["bot_id", "coin"],
    },
    handler: cancelOrder,
  },
  {
    name: "katoshi_close_all",
    description: "Close all open positions. Optionally filter by coins, direction (is_buy), size_pct, or dexs.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coins: { type: "array" as const, items: { type: "string" as const }, description: "Optional: limit to these coins (e.g. ['BTC','ETH'])." },
        is_buy: { type: "boolean" as const, description: "Optional: true = long only, false = short only." },
        size_pct: { type: "number" as const, description: "Optional: close only this % of each position." },
        dexs: { type: "array" as const, items: { type: "string" as const }, description: "Optional: limit to these DEXs." },
      },
      required: ["bot_id"],
    },
    handler: closeAll,
  },
  {
    name: "katoshi_sell_all",
    description: "Sell (liquidate) all positions. Optionally filter by coins or size_pct.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coins: { type: "array" as const, items: { type: "string" as const }, description: "Optional: limit to these coins." },
        size_pct: { type: "number" as const, description: "Optional: sell only this % of each position." },
      },
      required: ["bot_id"],
    },
    handler: sellAll,
  },
  {
    name: "katoshi_clear_all",
    description: "Close all positions and cancel all orders. Optionally filter by coins or dexs.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coins: { type: "array" as const, items: { type: "string" as const }, description: "Optional: limit to these coins." },
        dexs: { type: "array" as const, items: { type: "string" as const }, description: "Optional: limit to these DEXs." },
      },
      required: ["bot_id"],
    },
    handler: clearAll,
  },
  {
    name: "katoshi_cancel_all",
    description: "Cancel all resting orders. Optionally filter by coins, order_ids, or dexs.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coins: { type: "array" as const, items: { type: "string" as const }, description: "Optional: limit to these coins." },
        order_ids: { type: "array" as const, items: { type: "string" as const }, description: "Optional: cancel only these order IDs." },
        dexs: { type: "array" as const, items: { type: "string" as const }, description: "Optional: limit to these DEXs." },
      },
      required: ["bot_id"],
    },
    handler: cancelAll,
  },
  {
    name: "katoshi_set_leverage",
    description: "Set leverage and margin mode (cross or isolated) for a coin.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coin: coinProp,
        leverage: { type: "number" as const, description: "Leverage multiplier (e.g., 5 for 5x)." },
        is_cross: { type: "boolean" as const, description: "true = Cross margin, false = Isolated margin." },
      },
      required: ["bot_id", "coin", "leverage", "is_cross"],
    },
    handler: setLeverage,
  },
  {
    name: "katoshi_adjust_margin",
    description: "Add or remove margin for a position.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coin: coinProp,
        amount: { type: "number" as const, description: "Amount in USD to add or remove (e.g., 5 for $5)." },
        is_add: { type: "boolean" as const, description: "true = add margin, false = remove margin." },
      },
      required: ["bot_id", "coin", "amount", "is_add"],
    },
    handler: adjustMargin,
  },
  {
    name: "katoshi_start_bot",
    description: "Start a trading bot.",
    inputSchema: {
      type: "object",
      properties: { bot_id: botIdProp },
      required: ["bot_id"],
    },
    handler: startBot,
  },
  {
    name: "katoshi_stop_bot",
    description: "Stop a trading bot.",
    inputSchema: {
      type: "object",
      properties: { bot_id: botIdProp },
      required: ["bot_id"],
    },
    handler: stopBot,
  },
  {
    name: "katoshi_modify_tpsl",
    description: "Modify take-profit and/or stop-loss levels for a position. Provide at least one of tp_pct, sl_pct, tp, or sl.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coin: coinProp,
        ...tpslProps,
      },
      required: ["bot_id", "coin"],
    },
    handler: modifyTpsl,
  },
  {
    name: "katoshi_cancel_tpsl",
    description: "Cancel take-profit and/or stop-loss orders for a position. Optionally restrict by type: tpsl (both), tp, or sl.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: botIdProp,
        coin: coinProp,
        type: {
          type: "string" as const,
          enum: ["tpsl", "tp", "sl"],
          description: "Optional: 'tpsl' = both (default), 'tp' = take-profit only, 'sl' = stop-loss only.",
        },
      },
      required: ["bot_id", "coin"],
    },
    handler: cancelTpsl,
  },
];
