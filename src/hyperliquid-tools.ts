import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { z } from "zod";
import { getRequestContext } from "./request-context.js";
import { toContent, type SdkToolDefinition } from "./tool-registry.js";

/**
 * Hyperliquid API tools
 * Documentation: https://api.hyperliquid.xyz/info
 * SDK: https://github.com/nktkas/hyperliquid
 */

const transport = new HttpTransport();
const infoClient = new InfoClient({ transport });

/**
 * Retrieve mids for all coins
 * Uses the Hyperliquid SDK InfoClient
 * Note: If the book is empty, the last trade price will be used as a fallback
 */
async function getAllMids(
  _args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  try {
    const data = await infoClient.allMids();
    return JSON.stringify(data, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve mids: ${errorMessage}`);
  }
}

const userSchema = z
  .string()
  .describe("The user's hyperliquid wallet address (e.g. 0x...).");

const candleIntervalSchema = z
  .enum(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"])
  .describe("Candle interval (Allowed: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d, 3d, 1w, 1M).");

/**
 * Retrieve open orders for a user
 * Uses the Hyperliquid SDK InfoClient
 */
async function getOpenOrders(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const parsed = userSchema.safeParse(args?.user);
  if (!parsed.success) {
    throw new Error(
      `Invalid or missing user address: ${parsed.error.message}. Provide user (wallet address, e.g. 0x...).`
    );
  }
  const user = parsed.data;
  try {
    const data = await infoClient.frontendOpenOrders({ user });
    return JSON.stringify(data, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve open orders: ${errorMessage}`);
  }
}

/**
 * Retrieve user fills (trade history) for a user
 * Uses the Hyperliquid SDK InfoClient userFills (always aggregated by time)
 */
async function getUserFills(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const userParsed = userSchema.safeParse(args?.user);
  if (!userParsed.success) {
    throw new Error(
      `Invalid or missing user address: ${userParsed.error.message}. Provide user (wallet address, e.g. 0x...).`
    );
  }
  const user = userParsed.data;
  try {
    const data = await infoClient.userFills({ user, aggregateByTime: true });
    return JSON.stringify(data, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve user fills: ${errorMessage}`);
  }
}

/**
 * Retrieve perps account summary (clearinghouse state) for a user
 * Uses the Hyperliquid SDK InfoClient clearinghouseState
 */
async function getPerpsAccountSummary(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const userParsed = userSchema.safeParse(args?.user);
  if (!userParsed.success) {
    throw new Error(
      `Invalid or missing user address: ${userParsed.error.message}. Provide user (wallet address, e.g. 0x...).`
    );
  }
  const user = userParsed.data;
  const dex = typeof args?.dex === "string" ? args.dex : undefined;
  try {
    const data = await infoClient.clearinghouseState({
      user,
      ...(dex !== undefined && { dex }),
    });
    return JSON.stringify(data, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve perps account summary: ${errorMessage}`);
  }
}

/**
 * Retrieve spot account summary (spot clearinghouse state) for a user
 * Uses the Hyperliquid SDK InfoClient spotClearinghouseState
 */
async function getSpotAccountSummary(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const userParsed = userSchema.safeParse(args?.user);
  if (!userParsed.success) {
    throw new Error(
      `Invalid or missing user address: ${userParsed.error.message}. Provide user (wallet address, e.g. 0x...).`
    );
  }
  const user = userParsed.data;
  try {
    const data = await infoClient.spotClearinghouseState({ user });
    const transformed = {
      balances: data.balances.map((b) => ({
        coin: b.coin,
        total: b.total,
        inOrders: b.hold,
      })),
      ...(data.evmEscrows !== undefined && { evmEscrows: data.evmEscrows }),
    };
    return JSON.stringify(transformed, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve spot account summary: ${errorMessage}`);
  }
}

const CANDLE_COUNT = 50;

/** Duration of one candle in ms per interval (matches SDK picklist). */
const INTERVAL_MS: Record<z.infer<typeof candleIntervalSchema>, number> = {
  "1m": 60 * 1000,
  "3m": 3 * 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "2h": 2 * 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "8h": 8 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1M": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Retrieve candle snapshot for a coin and interval
 * Uses the Hyperliquid SDK InfoClient candleSnapshot
 * Fetches the last 50 candles (startTime/endTime derived from interval).
 */
async function getCandleSnapshot(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const coinParsed = z.string().safeParse(args?.coin);
  if (!coinParsed.success) {
    throw new Error(
      `Invalid or missing coin: ${coinParsed.error.message}. Provide coin (e.g. BTC, ETH).`
    );
  }
  const intervalParsed = candleIntervalSchema.safeParse(args?.interval);
  if (!intervalParsed.success) {
    throw new Error(
      `Invalid or missing interval: ${intervalParsed.error.message}. Use one of: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d, 3d, 1w, 1M.`
    );
  }
  const coin = coinParsed.data;
  const interval = intervalParsed.data;
  const endTime = Date.now();
  const rangeMs = CANDLE_COUNT * INTERVAL_MS[interval];
  const startTime = endTime - rangeMs;
  try {
    const data = await infoClient.candleSnapshot({
      coin,
      interval,
      startTime,
      endTime,
    });
    return JSON.stringify(data, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve candle snapshot: ${errorMessage}`);
  }
}

/**
 * Get leverage, max trade size, available margin, and mark price for a user's position in a coin.
 * Uses the Hyperliquid SDK InfoClient activeAssetData
 */
async function getCoinLeverageAndLimits(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const userParsed = userSchema.safeParse(args?.user);
  if (!userParsed.success) {
    throw new Error(
      `Invalid or missing user address: ${userParsed.error.message}. Provide user (wallet address, e.g. 0x...).`
    );
  }
  const coinParsed = z.string().safeParse(args?.coin);
  if (!coinParsed.success) {
    throw new Error(
      `Invalid or missing coin: ${coinParsed.error.message}. Provide coin (e.g. BTC, ETH, APT).`
    );
  }
  const user = userParsed.data;
  const coin = coinParsed.data;
  try {
    const data = await infoClient.activeAssetData({ user, coin });
    const coinKey = coin.toLowerCase();
    const transformed = {
      user: data.user,
      coin: data.coin,
      leverage: data.leverage,
      [`max_${coinKey}_trade_size_short`]: data.maxTradeSzs[0],
      [`max_${coinKey}_trade_size_long`]: data.maxTradeSzs[1],
      available_usdc_short: data.availableToTrade[0],
      available_usdc_long: data.availableToTrade[1],
      mark_price: data.markPx,
    };
    return JSON.stringify(transformed, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve coin leverage and limits: ${errorMessage}`);
  }
}

export const hyperliquidApiTools: SdkToolDefinition[] = [
  {
    name: "get_all_mids",
    title: "Get All Mids",
    description:
      "Retrieve mid prices for all coins.",
    inputSchema: {},
    handler: async (args, _extra) => toContent(await getAllMids(args, getRequestContext())),
  },
  {
    name: "get_open_orders",
    title: "Get Open Orders",
    description:
      "Retrieve open orders for a user.",
    inputSchema: { user: userSchema },
    handler: async (args, _extra) => toContent(await getOpenOrders(args, getRequestContext())),
  },
  {
    name: "get_user_fills",
    title: "Get User Fills",
    description:
      "Retrieve user fills (trade history) for a user.",
    inputSchema: { user: userSchema },
    handler: async (args, _extra) => toContent(await getUserFills(args, getRequestContext())),
  },
  {
    name: "get_perps_account_summary",
    title: "Get Perps Account Summary",
    description:
      "Retrieve perpetuals account summary for a user: margin summary, positions, withdrawable, etc.",
    inputSchema: {
      user: userSchema,
      dex: z.string().optional().describe("DEX name; omit or use empty string for main hyperliquid dex."),
    },
    handler: async (args, _extra) =>
      toContent(await getPerpsAccountSummary(args, getRequestContext())),
  },
  {
    name: "get_spot_account_summary",
    title: "Get Spot Account Summary",
    description:
      "Retrieve spot account summary for a user: token balances, holds, escrows, etc.",
    inputSchema: { user: userSchema },
    handler: async (args, _extra) =>
      toContent(await getSpotAccountSummary(args, getRequestContext())),
  },
  {
    name: "get_candle_snapshot",
    title: "Get Candle Snapshot",
    description:
      "Retrieve the last 50 candlesticks (OHLCV) for a coin.",
    inputSchema: {
      coin: z.string().describe("Asset symbol (e.g. BTC, ETH)."),
      interval: candleIntervalSchema,
    },
    handler: async (args, _extra) =>
      toContent(await getCandleSnapshot(args, getRequestContext())),
  },
  {
    name: "get_coin_leverage_and_limits",
    title: "Get Coin Leverage and Limits",
    description:
      "Retrieve a user's current leverage, max trade size, available margin, and mark price for a coin.",
    inputSchema: {
      user: userSchema,
      coin: z.string().describe("Asset symbol (e.g. BTC, ETH, APT)."),
    },
    handler: async (args, _extra) =>
      toContent(await getCoinLeverageAndLimits(args, getRequestContext())),
  },
];
