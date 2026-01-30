import * as z from "zod";
import { getRequestContext } from "./request-context.js";
import { log } from "./utils.js";
import { toContent, type SdkToolDefinition } from "./tool-registry.js";

/**
 * Katoshi Trading API tools
 * Documentation: https://katoshi.gitbook.io/katoshi-docs/api/actions
 * Endpoint: https://api.katoshi.ai/signal
 */

const KATOSHI_API_BASE_URL = process.env.KATOSHI_API_BASE_URL;

/**
 * Shared helper to execute a trading action via Katoshi Signal API
 */
/** Coerce to number only when value is a number; otherwise undefined (avoids sending 0/null by mistake). */
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Coerce to boolean only when value is a boolean; otherwise undefined (avoids sending 0/null by mistake). */
function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/** Coerce to string[] only when value is an array of strings; otherwise undefined (avoids sending null/empty by mistake). */
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

/** Coerce to enum only when value is one of the allowed strings; otherwise undefined. */
function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  if (typeof v !== "string") return undefined;
  return allowed.includes(v as T) ? (v as T) : undefined;
}

/** Normalize args so both snake_case and camelCase from agents are accepted. */
function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...args };
  const map: [string, string][] = [
    ["bot_id", "botId"],
    ["size_usd", "sizeUsd"],
    ["size_pct", "sizePct"],
    ["is_buy", "isBuy"],
    ["reduce_only", "reduceOnly"],
    ["slippage_pct", "slippagePct"],
    ["tp_pct", "tpPct"],
    ["sl_pct", "slPct"],
    ["order_id", "orderId"],
    ["order_ids", "orderIds"],
    ["start_price", "startPrice"],
    ["end_price", "endPrice"],
    ["num_orders", "numOrders"],
    ["price_start", "priceStart"],
    ["price_end", "priceEnd"],
    ["num_grids", "numGrids"],
  ];
  for (const [snake, camel] of map) {
    if (normalized[snake] === undefined && normalized[camel] !== undefined) {
      normalized[snake] = normalized[camel];
    }
  }
  return normalized;
}

async function executeAction(
  action: string,
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const startTime = Date.now();
  const apiKey = context?.apiKey;
  const userId = context?.userId;
  const argsNorm = normalizeArgs(args);

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

  /** Only add to payload when value is defined (for non-number fields). */
  function setIfValid(p: Record<string, unknown>, key: string, value: unknown): void {
    if (value === undefined || value === null) return;
    if (typeof value === "string" && value === "") return;
    if (Array.isArray(value) && value.length === 0) return;
    p[key] = value;
  }

  const payload: Record<string, unknown> = {
    action,
    api_key: apiKey,
  };

  // bot_id: accept string or number from agent, always send as integer to API
  const botIdRaw = argsNorm.bot_id;
  const botIdInt =
    botIdRaw !== undefined && botIdRaw !== null && !Number.isNaN(Number(botIdRaw))
      ? Math.trunc(Number(botIdRaw))
      : undefined;
  setIfValid(payload, "bot_id", botIdInt);
  setIfValid(payload, "coin", argsNorm.coin);
  // Optional arrays: only send when actually array of strings (avoids sending null/0)
  const coins = asStringArray(argsNorm.coins);
  if (coins !== undefined) payload.coins = coins;
  // Optional boolean: only send when actually boolean (avoids sending 0)
  const isBuy = asBoolean(argsNorm.is_buy);
  if (isBuy !== undefined) payload.is_buy = isBuy;
  const reduceOnly = asBoolean(argsNorm.reduce_only);
  if (reduceOnly !== undefined) payload.reduce_only = reduceOnly;
  // Size: only send when actually a number (avoids sending 0/null)
  const sizeUsd = asNumber(argsNorm.size_usd);
  const size = asNumber(argsNorm.size);
  const sizePct = asNumber(argsNorm.size_pct);
  if (sizeUsd !== undefined) {
    payload.size_usd = sizeUsd;
  } else if (size !== undefined) {
    payload.size = size;
  } else if (sizePct !== undefined) {
    payload.size_pct = sizePct;
  }
  // Optional number fields: only send when typeof number (never send 0/null by mistake)
  const price = asNumber(argsNorm.price);
  if (price !== undefined) payload.price = price;
  const tpPct = asNumber(argsNorm.tp_pct);
  if (tpPct !== undefined) payload.tp_pct = tpPct;
  const tp = asNumber(argsNorm.tp);
  if (tp !== undefined) payload.tp = tp;
  const slPct = asNumber(argsNorm.sl_pct);
  if (slPct !== undefined) payload.sl_pct = slPct;
  const sl = asNumber(argsNorm.sl);
  if (sl !== undefined) payload.sl = sl;
  const slippagePct = asNumber(argsNorm.slippage_pct);
  if (slippagePct !== undefined) payload.slippage_pct = slippagePct;
  const leverage = asNumber(argsNorm.leverage);
  if (leverage !== undefined) payload.leverage = leverage;
  const isCross = asBoolean(argsNorm.is_cross);
  if (isCross !== undefined) payload.is_cross = isCross;
  const amount = asNumber(argsNorm.amount);
  if (amount !== undefined) payload.amount = amount;
  const isAdd = asBoolean(argsNorm.is_add);
  if (isAdd !== undefined) payload.is_add = isAdd;
  setIfValid(payload, "order_id", argsNorm.order_id);
  const orderIds = asStringArray(argsNorm.order_ids);
  if (orderIds !== undefined) payload.order_ids = orderIds;
  const dexs = asStringArray(argsNorm.dexs);
  if (dexs !== undefined) payload.dexs = dexs;
  const typeVal = asEnum(argsNorm.type, ["tpsl", "tp", "sl"] as const);
  if (typeVal !== undefined) payload.type = typeVal;
  const startPrice = asNumber(argsNorm.start_price);
  if (startPrice !== undefined) payload.start_price = startPrice;
  const endPrice = asNumber(argsNorm.end_price);
  if (endPrice !== undefined) payload.end_price = endPrice;
  const numOrders = asNumber(argsNorm.num_orders);
  if (numOrders !== undefined) payload.num_orders = numOrders;
  const skew = asNumber(argsNorm.skew);
  if (skew !== undefined) payload.skew = skew;
  const priceStart = asNumber(argsNorm.price_start);
  if (priceStart !== undefined) payload.price_start = priceStart;
  const priceEnd = asNumber(argsNorm.price_end);
  if (priceEnd !== undefined) payload.price_end = priceEnd;
  const numGrids = asNumber(argsNorm.num_grids);
  if (numGrids !== undefined) payload.num_grids = numGrids;

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

    log("info", "Trading action completed", {
      action,
      userId,
      botId: argsNorm.bot_id,
      responseTimeMs: responseTime,
    });
    return JSON.stringify(data, null, 2);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Katoshi API error")) throw error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to execute trading action: ${errorMessage}`);
  }
}

// --- Handlers (each calls executeAction with fixed action) ---

function requireSize(args: Record<string, unknown>): void {
  const a = normalizeArgs(args);
  if (a.size === undefined && a.size_usd === undefined && a.size_pct === undefined) {
    throw new Error("One of size, size_usd, or size_pct is required (e.g. size_usd: 11 for $11 USD)");
  }
  const numUsd = Number(a.size_usd);
  const numSize = Number(a.size);
  const numPct = Number(a.size_pct);
  const hasValidUsd = a.size_usd != null && !Number.isNaN(numUsd) && numUsd > 0;
  const hasValidSize = a.size != null && !Number.isNaN(numSize) && numSize > 0;
  const hasValidPct = a.size_pct != null && !Number.isNaN(numPct) && numPct > 0;
  if (!hasValidUsd && !hasValidSize && !hasValidPct) {
    throw new Error("One of size, size_usd, or size_pct must be a positive number (e.g. size_usd: 11 for $11 USD)");
  }
}

async function openPosition(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const a = normalizeArgs(args);
  if (!a.bot_id) throw new Error("bot_id is required");
  if (!a.coin) throw new Error("coin is required");
  if (typeof a.is_buy !== "boolean") throw new Error("is_buy is required (true for long, false for short)");
  requireSize(a);
  return executeAction("open_position", a, context);
}

async function closePosition(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const a = normalizeArgs(args);
  if (!a.bot_id) throw new Error("bot_id is required");
  if (!a.coin) throw new Error("coin is required");
  requireSize(a);
  return executeAction("close_position", a, context);
}

async function marketOrder(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const a = normalizeArgs(args);
  if (!a.bot_id) throw new Error("bot_id is required");
  if (!a.coin) throw new Error("coin is required");
  if (typeof a.is_buy !== "boolean") throw new Error("is_buy is required");
  if (typeof a.reduce_only !== "boolean") throw new Error("reduce_only is required");
  requireSize(a);
  return executeAction("market_order", a, context);
}

async function limitOrder(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const a = normalizeArgs(args);
  if (!a.bot_id) throw new Error("bot_id is required");
  if (!a.coin) throw new Error("coin is required");
  if (typeof a.is_buy !== "boolean") throw new Error("is_buy is required");
  if (typeof a.reduce_only !== "boolean") throw new Error("reduce_only is required");
  if (a.price === undefined) throw new Error("price is required for limit_order");
  requireSize(a);
  return executeAction("limit_order", a, context);
}

async function stopMarketOrder(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const a = normalizeArgs(args);
  if (!a.bot_id) throw new Error("bot_id is required");
  if (!a.coin) throw new Error("coin is required");
  if (typeof a.is_buy !== "boolean") throw new Error("is_buy is required");
  if (typeof a.reduce_only !== "boolean") throw new Error("reduce_only is required");
  if (a.price === undefined) throw new Error("price is required for stop_market_order");
  requireSize(a);
  return executeAction("stop_market_order", a, context);
}

async function scaleOrder(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const a = normalizeArgs(args);
  if (!a.bot_id) throw new Error("bot_id is required");
  if (!a.coin) throw new Error("coin is required");
  if (typeof a.is_buy !== "boolean") throw new Error("is_buy is required");
  if (typeof a.reduce_only !== "boolean") throw new Error("reduce_only is required for scale_order");
  if (a.start_price === undefined) throw new Error("start_price is required for scale_order");
  if (a.end_price === undefined) throw new Error("end_price is required for scale_order");
  if (a.num_orders === undefined) throw new Error("num_orders is required for scale_order");
  requireSize(a);
  return executeAction("scale_order", a, context);
}

async function gridOrder(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const a = normalizeArgs(args);
  if (!a.bot_id) throw new Error("bot_id is required");
  if (!a.coin) throw new Error("coin is required");
  if (typeof a.is_buy !== "boolean") throw new Error("is_buy is required");
  if (a.price_start === undefined) throw new Error("price_start is required for grid_order");
  if (a.price_end === undefined) throw new Error("price_end is required for grid_order");
  if (a.num_grids === undefined) throw new Error("num_grids is required for grid_order");
  requireSize(a);
  return executeAction("grid_order", a, context);
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
  return executeAction("modify_tpsl", args, context);
}

async function cancelTpsl(
  args: Record<string, unknown>,
  context?: { apiKey?: string; userId?: string }
): Promise<string> {
  if (!args.bot_id) throw new Error("bot_id is required");
  if (!args.coin) throw new Error("coin is required");
  return executeAction("cancel_tpsl", args, context);
}

// --- Zod schema fragments (SDK inputSchema) ---

const botIdSchema = z
  .union([z.number(), z.string()])
  .describe("The bot ID to execute the action for (number or string, e.g. 640 or '640'). Sent as integer to the API.");
const coinSchema = z.string().describe("The coin symbol (e.g., 'BTC', 'ETH', 'SOL')");
const isBuySchema = z.boolean().describe("Trade direction: true for long/buy, false for short/sell");
const reduceOnlySchema = z.boolean().describe("If true, only close/reduce. If false, can open or close. Perps only.");
// Optional number fields: use number | null so LLM can send null for "not specified". Do not send 0.
const optionalNumber = (description: string) =>
  z.union([z.number(), z.null()]).optional().describe(description);
const sizeSchema = optionalNumber("Size in contracts (e.g. 0.005). Provide exactly ONE of size, size_usd, or size_pct. Use null or omit for the other two. Do not send 0.");
const sizeUsdSchema = optionalNumber("Size in USD (e.g. 11). Provide exactly ONE of size, size_usd, or size_pct. Use null or omit for the other two. Do not send 0.");
const sizePctSchema = optionalNumber("Size as fraction (e.g. 0.1 for 10%). Provide exactly ONE of size, size_usd, or size_pct. Use null or omit for the other two. Do not send 0.");
const tpslSchemas = {
  tp_pct: z.union([z.number(), z.null()]).optional().describe("Take-profit as % from entry (e.g. 0.02 for 2%). Use null or omit if user did not specify. Do not send 0."),
  sl_pct: z.union([z.number(), z.null()]).optional().describe("Stop-loss as % from entry (e.g. 0.01 for 1%). Use null or omit if user did not specify. Do not send 0."),
  tp: z.union([z.number(), z.null()]).optional().describe("Take-profit as price. Use null or omit if user did not specify. Do not send 0."),
  sl: z.union([z.number(), z.null()]).optional().describe("Stop-loss as price. Use null or omit if user did not specify. Do not send 0."),
};
const slippagePctSchema = z.union([z.number(), z.null()]).optional().describe("Max slippage % (e.g. 0.05 for 5%). Use null or omit unless user specifies. Do not send 0.");

// Optional booleans/arrays/enum: accept null so agents don't send 0 or wrong types.
const optionalBoolean = (description: string) =>
  z.union([z.boolean(), z.null()]).optional().describe(description);
const optionalStringArray = (description: string) =>
  z.union([z.array(z.string()), z.null()]).optional().describe(description);
const tpslTypeEnum = z.union([z.enum(["tpsl", "tp", "sl"]), z.null()]).optional().describe("Optional: 'tpsl' = both (default), 'tp' = take-profit only, 'sl' = stop-loss only. Use null or omit for default.");

export const katoshiTradingTools: SdkToolDefinition[] = [
  {
    name: "katoshi_open_position",
    title: "Open Position",
    description:
      "Open a new long or short position for a coin at market. You MUST provide exactly one of size, size_usd, or size_pct (e.g. size_usd: 11 for $11 USD). Do NOT provide the other size parameters. Do NOT include tp_pct, tp, sl_pct, or sl if the user did not specify take-profit or stop-loss - omit these parameters entirely (do not set them to 0 or null).",
    inputSchema: {
      bot_id: botIdSchema,
      coin: coinSchema,
      is_buy: isBuySchema,
      size: sizeSchema,
      size_usd: sizeUsdSchema,
      size_pct: sizePctSchema,
      ...tpslSchemas,
      slippage_pct: slippagePctSchema,
    },
    handler: async (args, _extra) => toContent(await openPosition(args, getRequestContext())),
  },
  {
    name: "katoshi_close_position",
    title: "Close Position",
    description: "Close an existing position (fully or partially). Optionally restrict to long or short via is_buy; if omitted, closes both.",
    inputSchema: {
      bot_id: botIdSchema,
      coin: coinSchema,
      is_buy: optionalBoolean("Optional: true = close long, false = short. Use null or omit to close both. Do not send 0."),
      size: sizeSchema,
      size_usd: sizeUsdSchema,
      size_pct: sizePctSchema,
      ...tpslSchemas,
      slippage_pct: slippagePctSchema,
    },
    handler: async (args, _extra) => toContent(await closePosition(args, getRequestContext())),
  },
  {
    name: "katoshi_market_order",
    title: "Market Order",
    description: "Place a market order (immediate execution at current market price).",
    inputSchema: {
      bot_id: botIdSchema,
      coin: coinSchema,
      is_buy: isBuySchema,
      reduce_only: reduceOnlySchema,
      size: sizeSchema,
      size_usd: sizeUsdSchema,
      size_pct: sizePctSchema,
      ...tpslSchemas,
      slippage_pct: slippagePctSchema,
    },
    handler: async (args, _extra) => toContent(await marketOrder(args, getRequestContext())),
  },
  {
    name: "katoshi_limit_order",
    title: "Limit Order",
    description: "Place a limit order at a specific price.",
    inputSchema: {
      bot_id: botIdSchema,
      coin: coinSchema,
      is_buy: isBuySchema,
      reduce_only: reduceOnlySchema,
      price: z.number().describe("Limit price for the order."),
      size: sizeSchema,
      size_usd: sizeUsdSchema,
      size_pct: sizePctSchema,
      ...tpslSchemas,
      slippage_pct: slippagePctSchema,
    },
    handler: async (args, _extra) => toContent(await limitOrder(args, getRequestContext())),
  },
  {
    name: "katoshi_stop_market_order",
    title: "Stop Market Order",
    description: "Place a stop market order that triggers a market order when price reaches the trigger level.",
    inputSchema: {
      bot_id: botIdSchema,
      coin: coinSchema,
      is_buy: isBuySchema,
      reduce_only: reduceOnlySchema,
      price: z.number().describe("Trigger price for the stop."),
      size: sizeSchema,
      size_usd: sizeUsdSchema,
      size_pct: sizePctSchema,
      ...tpslSchemas,
      slippage_pct: slippagePctSchema,
    },
    handler: async (args, _extra) => toContent(await stopMarketOrder(args, getRequestContext())),
  },
  {
    name: "katoshi_scale_order",
    title: "Scale Order (DCA)",
    description: "Place a scale (DCA) order: multiple limit orders between start_price and end_price.",
    inputSchema: {
      bot_id: botIdSchema,
      coin: coinSchema,
      is_buy: isBuySchema,
      reduce_only: reduceOnlySchema,
      start_price: z.number().describe("Price of first order (closest to current price)."),
      end_price: z.number().describe("Price of last order."),
      num_orders: z.number().describe("Number of limit orders."),
      skew: optionalNumber("Size skew between first and last order (e.g. 2 = last 2x first). Use null or omit for default 1. Do not send 0."),
      size: sizeSchema,
      size_usd: sizeUsdSchema,
      size_pct: sizePctSchema,
      ...tpslSchemas,
      slippage_pct: slippagePctSchema,
    },
    handler: async (args, _extra) => toContent(await scaleOrder(args, getRequestContext())),
  },
  {
    name: "katoshi_grid_order",
    title: "Grid Order",
    description: "Place a grid order: automated orders at multiple price levels between price_start and price_end.",
    inputSchema: {
      bot_id: botIdSchema,
      coin: coinSchema,
      is_buy: isBuySchema,
      price_start: z.number().describe("Start of grid price range."),
      price_end: z.number().describe("End of grid price range."),
      num_grids: z.number().describe("Number of grid orders to place."),
      size: sizeSchema,
      size_usd: sizeUsdSchema,
      size_pct: sizePctSchema,
      ...tpslSchemas,
      slippage_pct: slippagePctSchema,
    },
    handler: async (args, _extra) => toContent(await gridOrder(args, getRequestContext())),
  },
  {
    name: "katoshi_move_order",
    title: "Move Order",
    description: "Move an existing order to a new price.",
    inputSchema: {
      bot_id: botIdSchema,
      coin: coinSchema,
      order_id: z.string().describe("ID of the order to move."),
      price: z.number().describe("New price for the order."),
    },
    handler: async (args, _extra) => toContent(await moveOrder(args, getRequestContext())),
  },
  {
    name: "katoshi_cancel_order",
    title: "Cancel Order",
    description: "Cancel one or more resting orders for a coin. Optionally pass order_ids to cancel specific orders; otherwise cancels all resting orders for the coin.",
    inputSchema: {
      bot_id: botIdSchema,
      coin: coinSchema,
      order_ids: optionalStringArray("Optional: specific order IDs to cancel. Use null or omit to cancel all resting orders for the coin. Do not send [] or 0."),
    },
    handler: async (args, _extra) => toContent(await cancelOrder(args, getRequestContext())),
  },
  {
    name: "katoshi_close_all",
    title: "Close All",
    description: "Close all open positions. Optionally filter by coins, direction (is_buy), size_pct, or dexs.",
    inputSchema: {
      bot_id: botIdSchema,
      coins: optionalStringArray("Optional: limit to these coins (e.g. ['BTC','ETH']). Use null or omit for all. Do not send [] or 0."),
      is_buy: optionalBoolean("Optional: true = long only, false = short only. Use null or omit for both. Do not send 0."),
      size_pct: optionalNumber("Optional: close only this % of each position. Use null or omit for 100%. Do not send 0."),
      dexs: optionalStringArray("Optional: limit to these DEXs. Use null or omit for all. Do not send [] or 0."),
    },
    handler: async (args, _extra) => toContent(await closeAll(args, getRequestContext())),
  },
  {
    name: "katoshi_sell_all",
    title: "Sell All",
    description: "Sell (liquidate) all positions. Optionally filter by coins or size_pct.",
    inputSchema: {
      bot_id: botIdSchema,
      coins: optionalStringArray("Optional: limit to these coins. Use null or omit for all. Do not send [] or 0."),
      size_pct: optionalNumber("Optional: sell only this % of each position. Use null or omit for 100%. Do not send 0."),
    },
    handler: async (args, _extra) => toContent(await sellAll(args, getRequestContext())),
  },
  {
    name: "katoshi_clear_all",
    title: "Clear All",
    description: "Close all positions and cancel all orders. Optionally filter by coins or dexs.",
    inputSchema: {
      bot_id: botIdSchema,
      coins: optionalStringArray("Optional: limit to these coins. Use null or omit for all. Do not send [] or 0."),
      dexs: optionalStringArray("Optional: limit to these DEXs. Use null or omit for all. Do not send [] or 0."),
    },
    handler: async (args, _extra) => toContent(await clearAll(args, getRequestContext())),
  },
  {
    name: "katoshi_cancel_all",
    title: "Cancel All",
    description: "Cancel all resting orders. Optionally filter by coins, order_ids, or dexs.",
    inputSchema: {
      bot_id: botIdSchema,
      coins: optionalStringArray("Optional: limit to these coins. Use null or omit for all. Do not send [] or 0."),
      order_ids: optionalStringArray("Optional: cancel only these order IDs. Use null or omit for all. Do not send [] or 0."),
      dexs: optionalStringArray("Optional: limit to these DEXs. Use null or omit for all. Do not send [] or 0."),
    },
    handler: async (args, _extra) => toContent(await cancelAll(args, getRequestContext())),
  },
  {
    name: "katoshi_set_leverage",
    title: "Set Leverage",
    description: "Set leverage and margin mode (cross or isolated) for a coin.",
    inputSchema: {
      bot_id: botIdSchema,
      coin: coinSchema,
      leverage: z.number().describe("Leverage multiplier (e.g., 5 for 5x)."),
      is_cross: z.boolean().describe("true = Cross margin, false = Isolated margin."),
    },
    handler: async (args, _extra) => toContent(await setLeverage(args, getRequestContext())),
  },
  {
    name: "katoshi_adjust_margin",
    title: "Adjust Margin",
    description: "Add or remove margin for a position.",
    inputSchema: {
      bot_id: botIdSchema,
      coin: coinSchema,
      amount: z.number().describe("Amount in USD to add or remove (e.g., 5 for $5)."),
      is_add: z.boolean().describe("true = add margin, false = remove margin."),
    },
    handler: async (args, _extra) => toContent(await adjustMargin(args, getRequestContext())),
  },
  {
    name: "katoshi_start_bot",
    title: "Start Bot",
    description: "Start a trading bot.",
    inputSchema: { bot_id: botIdSchema },
    handler: async (args, _extra) => toContent(await startBot(args, getRequestContext())),
  },
  {
    name: "katoshi_stop_bot",
    title: "Stop Bot",
    description: "Stop a trading bot.",
    inputSchema: { bot_id: botIdSchema },
    handler: async (args, _extra) => toContent(await stopBot(args, getRequestContext())),
  },
  {
    name: "katoshi_modify_tpsl",
    title: "Modify TP/SL",
    description: "Modify take-profit and/or stop-loss levels for a position. Provide at least one of tp_pct, sl_pct, tp, or sl.",
    inputSchema: {
      bot_id: botIdSchema,
      coin: coinSchema,
      ...tpslSchemas,
    },
    handler: async (args, _extra) => toContent(await modifyTpsl(args, getRequestContext())),
  },
  {
    name: "katoshi_cancel_tpsl",
    title: "Cancel TP/SL",
    description: "Cancel take-profit and/or stop-loss orders for a position. Optionally restrict by type: tpsl (both), tp, or sl.",
    inputSchema: {
      bot_id: botIdSchema,
      coin: coinSchema,
      type: tpslTypeEnum,
    },
    handler: async (args, _extra) => toContent(await cancelTpsl(args, getRequestContext())),
  },
];
