import {
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from "@nktkas/hyperliquid";
import { ATR, BollingerBands, EMA, MACD, RSI } from "technicalindicators";
import { z } from "zod";
import { getRequestContext } from "./request-context.js";
import { toContent, type SdkToolDefinition } from "./tool-common.js";

/**
 * Hyperliquid API tools
 * Documentation: https://api.hyperliquid.xyz/info
 * SDK: https://github.com/nktkas/hyperliquid
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const transport = new HttpTransport();
const infoClient = new InfoClient({ transport });

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

const DEFAULT_CANDLE_COUNT = 10;
const MAX_CANDLE_COUNT = 30;
/** When computing indicators we fetch extra candles for lookback (e.g. MACD needs ~35). */
const INDICATOR_LOOKBACK = 50;
const MAX_CANDLES_FOR_INDICATORS = 100;

const DEFAULT_WS_TIMEOUT_MS = 3_000;
const DEFAULT_WS_TIMEOUT_MESSAGE = "WebSocket subscription timeout";

const COIN_HINT = "Provide coin (e.g. BTC, ETH).";
const USER_HINT = "Provide user (wallet address, e.g. 0x...).";
const INTERVAL_HINT = "Use one of: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d, 3d, 1w, 1M.";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const coinSchema = z.string().describe("Asset symbol (e.g. BTC, ETH).");
const userSchema = z.string().transform((s) => s.toLowerCase()).describe("The user's hyperliquid wallet address (e.g. 0x...).");
const candleIntervalSchema = z.enum(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"]).describe("Candle interval (Allowed: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d, 3d, 1w, 1M).");
const candleCountSchema = z.number().int().min(1).max(MAX_CANDLE_COUNT).nullish();

const indicatorNameSchema = z
  .enum(["rsi", "macd", "atr", "bollingerBands", "ema"])
  .describe("Indicator: rsi, macd, atr, bollingerBands, ema");
const indicatorsSchema = z
  .array(indicatorNameSchema)
  .min(1)
  .max(5)
  .optional()
  .describe("Optional list of indicators to compute (rsi, macd, atr, bollingerBands, ema).");

const rsiPeriodSchema = z.number().int().min(2).max(30).nullish().describe("RSI period (default 14).");
const macdFastPeriodSchema = z.number().int().min(2).max(20).nullish().describe("MACD fast period (default 12).");
const macdSlowPeriodSchema = z.number().int().min(5).max(50).nullish().describe("MACD slow period (default 26).");
const macdSignalPeriodSchema = z.number().int().min(2).max(20).nullish().describe("MACD signal period (default 9).");
const atrPeriodSchema = z.number().int().min(2).max(30).nullish().describe("ATR period (default 14).");
const bbPeriodSchema = z.number().int().min(2).max(50).nullish().describe("Bollinger Bands period (default 20).");
const bbStdDevSchema = z.number().min(1).max(3).nullish().describe("Bollinger Bands standard deviations (default 2).");
const emaPeriodSchema = z.number().int().min(2).max(100).nullish().describe("EMA period (default 20).");

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

/**
 * Validate a single field with a Zod schema and throw in the same format as katoshi-tools:
 * "Invalid or missing {fieldName}: {schema error}. {hint}"
 */
function requireField<T>(
  value: unknown,
  schema: z.ZodType<T>,
  fieldName: string,
  hint: string
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Invalid or missing ${fieldName}: ${parsed.error.message}. ${hint}`
    );
  }
  return parsed.data;
}

/** Parse decimal string from API to number. */
function parseDecimal(s: string | undefined): number {
  if (s === undefined || s === "") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Format number to string with up to 6 decimal places, no trailing zeros. */
function formatDecimal(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number(n.toFixed(6)) === n ? String(n) : n.toFixed(6);
}

/** Handle returned by SDK subscription methods (e.g. allMids, assetCtxs). */
interface SubscriptionHandle {
  unsubscribe(): Promise<void>;
}

/**
 * Create a WebSocket transport and subscription client, subscribe via the given
 * function, wait for the first event, then unsubscribe and close the transport.
 * Use for tools that need a single snapshot from a Hyperliquid SDK subscription
 * (e.g. allMids, assetCtxs) instead of a long-lived stream.
 */
async function getSubscriptionSnapshot<T>(
  subscribe: (
    client: SubscriptionClient,
    onData: (data: T) => void
  ) => Promise<SubscriptionHandle>
): Promise<T> {
  const wsTransport = new WebSocketTransport({
    timeout: DEFAULT_WS_TIMEOUT_MS,
  });
  const subClient = new SubscriptionClient({ transport: wsTransport });

  let resolveFirst: (data: T) => void;
  const firstDataPromise = new Promise<T>((resolve) => {
    resolveFirst = resolve;
  });

  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => {
        timedOut = true;
        reject(new Error(DEFAULT_WS_TIMEOUT_MESSAGE));
      },
      DEFAULT_WS_TIMEOUT_MS
    );
  });

  let subscription: SubscriptionHandle | null = null;
  try {
    await Promise.race([wsTransport.ready(), timeoutPromise]);
    subscription = await Promise.race([
      subscribe(subClient, (data) => {
        if (timedOut) return;
        resolveFirst(data);
      }),
      timeoutPromise,
    ]);
    return await Promise.race([firstDataPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
    if (subscription) await subscription.unsubscribe().catch(() => {});
    await wsTransport.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Retrieve mid price for a single coin.
 * Uses the Hyperliquid SDK WebSocket (SubscriptionClient allMids) via
 * getSubscriptionSnapshot: subscribe, wait for the first event, unsubscribe,
 * then return the requested coin's mid.
 * Note: If the book is empty, the last trade price will be used as a fallback.
 */
async function getCoinPrice(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const coin = requireField(args?.coin, coinSchema, "coin", COIN_HINT);
  try {
    const event = await getSubscriptionSnapshot<{ mids: Record<string, string> }>(
      (client, onData) => client.allMids({ dex: "ALL_DEXS" }, onData)
    );
    const mids = event.mids;
    const mid = mids[coin] ?? mids[coin.toUpperCase()];
    if (mid === undefined) {
      const available = Object.keys(mids).slice(0, 10).join(", ");
      throw new Error(
        `Coin '${coin}' not found. Available coins include: ${available}...`
      );
    }
    return JSON.stringify({ [coin]: mid }, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve mid for ${coin}: ${errorMessage}`);
  }
}

/**
 * Retrieve open orders for a user
 * Uses the Hyperliquid SDK InfoClient
 */
async function getOpenOrders(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const user = requireField(args?.user, userSchema, "user", USER_HINT);
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
  const user = requireField(args?.user, userSchema, "user", USER_HINT);
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
 * Merge clearinghouse states into a single positions array and totals.
 * Reduces noise by dropping per-DEX margin summaries and aggregating position stats.
 */
function formatPerpsSummary(event: {
  user: string;
  clearinghouseStates: [string, unknown][];
}): {
  user: string;
  positions: Array<{ dex: string } & Record<string, unknown>>;
  totals: {
    positionValue: string;
    unrealizedPnl: string;
    returnOnEquity: string;
    marginUsed: string;
    fundingSinceOpen: string;
  };
} {
  const positions: Array<{ dex: string } & Record<string, unknown>> = [];
  let totalPositionValue = 0;
  let totalUnrealizedPnl = 0;
  let totalMarginUsed = 0;
  let totalFundingSinceOpen = 0;

  for (const [dex, state] of event.clearinghouseStates) {
    const raw = state as { assetPositions?: Array<{ position?: Record<string, unknown> }> };
    const list = raw?.assetPositions ?? [];
    for (const ap of list) {
      const pos = ap?.position as Record<string, unknown> | undefined;
      if (!pos) continue;
      const cumFunding = pos.cumFunding as { sinceOpen?: string } | undefined;
      const positionValue = String(pos.positionValue ?? "0");
      const unrealizedPnl = String(pos.unrealizedPnl ?? "0");
      const marginUsed = String(pos.marginUsed ?? "0");
      const fundingSinceOpen = String(cumFunding?.sinceOpen ?? "0");

      positions.push({
        dex: dex || "hyperliquid",
        ...pos,
      });

      totalPositionValue += parseDecimal(positionValue);
      totalUnrealizedPnl += parseDecimal(unrealizedPnl);
      totalMarginUsed += parseDecimal(marginUsed);
      totalFundingSinceOpen += parseDecimal(fundingSinceOpen);
    }
  }

  // Portfolio RoE = (total unrealized PnL + total funding since open) / total margin used
  const totalReturnOnEquity =
    totalMarginUsed !== 0
      ? (totalUnrealizedPnl + totalFundingSinceOpen) / totalMarginUsed
      : 0;

  return {
    user: event.user,
    positions,
    totals: {
      positionValue: formatDecimal(totalPositionValue),
      unrealizedPnl: formatDecimal(totalUnrealizedPnl),
      returnOnEquity: formatDecimal(totalReturnOnEquity),
      marginUsed: formatDecimal(totalMarginUsed),
      fundingSinceOpen: formatDecimal(totalFundingSinceOpen),
    },
  };
}

/**
 * Retrieve perps account summary (clearinghouse state) for a user across all DEXs.
 * Uses the Hyperliquid SDK WebSocket (SubscriptionClient allDexsClearinghouseState) via
 * getSubscriptionSnapshot: subscribe, wait for the first event, unsubscribe, then return.
 * Returns merged positions from all DEXs plus aggregated totals.
 */
export async function getPerpsAccountSummary(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const user = requireField(args?.user, userSchema, "user", USER_HINT);
  try {
    const event = await getSubscriptionSnapshot<{
      user: string;
      clearinghouseStates: [string, unknown][];
    }>((client, onData) => client.allDexsClearinghouseState({ user }, onData));
    const formatted = formatPerpsSummary(event);
    return JSON.stringify(formatted, null, 2);
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
  const user = requireField(args?.user, userSchema, "user", USER_HINT);
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


/**
 * Retrieve candle snapshot for a coin and interval
 * Uses the Hyperliquid SDK InfoClient candleSnapshot
 * Fetches the last N candles (default 10, max 30); time range derived from interval.
 */
async function getCandleSnapshot(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const coin = requireField(args?.coin, coinSchema, "coin", COIN_HINT);
  const interval = requireField(
    args?.interval,
    candleIntervalSchema,
    "interval",
    INTERVAL_HINT
  );
  const countParsed = candleCountSchema.safeParse(args?.count);
  const count = countParsed.success
    ? Math.min(MAX_CANDLE_COUNT, Math.max(1, countParsed.data ?? DEFAULT_CANDLE_COUNT))
    : DEFAULT_CANDLE_COUNT;
  const endTime = Date.now();
  const rangeMs = count * INTERVAL_MS[interval];
  const startTime = endTime - rangeMs;
  try {
    const data = await infoClient.candleSnapshot({
      coin,
      interval,
      startTime,
      endTime,
    });
    // Transform to descriptive keys and add ISO timestamps for AI readability
    const raw = Array.isArray(data) ? data : [data];
    const transformed = raw
      .map(
        (c: { T: number; o: string; h: string; l: string; c: string; v: string; s: string; i: string }) => ({
          symbol: c.s,
          interval: c.i,
          closeTime: c.T,
          closeTimeIso: new Date(c.T).toISOString(),
          open: c.o,
          high: c.h,
          low: c.l,
          close: c.c,
          volume: c.v,
        })
      )
      .slice(-count);
    return JSON.stringify(transformed, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve candle snapshot: ${errorMessage}`);
  }
}

/** Default periods for indicators (standard defaults). */
const DEFAULT_RSI_PERIOD = 14;
const DEFAULT_MACD_FAST = 12;
const DEFAULT_MACD_SLOW = 26;
const DEFAULT_MACD_SIGNAL = 9;
const DEFAULT_ATR_PERIOD = 14;
const DEFAULT_BB_PERIOD = 20;
const DEFAULT_BB_STDDEV = 2;
const DEFAULT_EMA_PERIOD = 20;

type CandleRow = {
  T: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  s?: string;
  i?: string;
};

/**
 * Fetch more candles when indicators are requested (need lookback for warmup).
 */
async function fetchCandlesForIndicators(
  coin: string,
  interval: z.infer<typeof candleIntervalSchema>,
  count: number
): Promise<CandleRow[]> {
  const fetchCount = Math.min(MAX_CANDLES_FOR_INDICATORS, count + INDICATOR_LOOKBACK);
  const endTime = Date.now();
  const rangeMs = fetchCount * INTERVAL_MS[interval];
  const startTime = endTime - rangeMs;
  const data = await infoClient.candleSnapshot({
    coin,
    interval,
    startTime,
    endTime,
  });
  const raw = Array.isArray(data) ? data : [data];
  return raw as CandleRow[];
}

/**
 * Retrieve candle snapshot with optional technical indicators (RSI, MACD, ATR, Bollinger Bands).
 * Fetches enough candles for indicator warmup, computes selected indicators, returns last N candles with values.
 */
async function getCandleSnapshotWithIndicators(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const coin = requireField(args?.coin, coinSchema, "coin", COIN_HINT);
  const interval = requireField(
    args?.interval,
    candleIntervalSchema,
    "interval",
    INTERVAL_HINT
  );
  const countParsed = candleCountSchema.safeParse(args?.count);
  const count = countParsed.success
    ? Math.min(MAX_CANDLE_COUNT, Math.max(1, countParsed.data ?? DEFAULT_CANDLE_COUNT))
    : DEFAULT_CANDLE_COUNT;
  const indicatorsParsed = indicatorsSchema.safeParse(args?.indicators);
  const indicators = indicatorsParsed.success && indicatorsParsed.data?.length
    ? indicatorsParsed.data
    : null;

  const rsiPeriod = Math.min(30, Math.max(2, Number(args?.rsiPeriod) || DEFAULT_RSI_PERIOD));
  const macdFast = Math.min(20, Math.max(2, Number(args?.macdFastPeriod) || DEFAULT_MACD_FAST));
  const macdSlow = Math.min(50, Math.max(5, Number(args?.macdSlowPeriod) || DEFAULT_MACD_SLOW));
  const macdSignal = Math.min(20, Math.max(2, Number(args?.macdSignalPeriod) || DEFAULT_MACD_SIGNAL));
  const atrPeriod = Math.min(30, Math.max(2, Number(args?.atrPeriod) || DEFAULT_ATR_PERIOD));
  const bbPeriod = Math.min(50, Math.max(2, Number(args?.bbPeriod) || DEFAULT_BB_PERIOD));
  const bbStdDev = Math.min(3, Math.max(1, Number(args?.bbStdDev) || DEFAULT_BB_STDDEV));
  const emaPeriod = Math.min(100, Math.max(2, Number(args?.emaPeriod) || DEFAULT_EMA_PERIOD));

  try {
    const raw = await fetchCandlesForIndicators(coin, interval, count);
    const n = raw.length;
    if (n === 0) {
      return JSON.stringify({ candles: [], message: "No candle data returned." }, null, 2);
    }

    const high = raw.map((c) => parseDecimal(c.h));
    const low = raw.map((c) => parseDecimal(c.l));
    const close = raw.map((c) => parseDecimal(c.c));

    type IndicatorResults = {
      rsi?: (number | undefined)[];
      macd?: { MACD?: number; signal?: number; histogram?: number }[];
      atr?: (number | undefined)[];
      bollingerBands?: { middle: number; upper: number; lower: number; pb?: number }[];
      ema?: number[];
    };
    const results: IndicatorResults = {};

    if (indicators?.includes("rsi")) {
      const rsiResult = RSI.calculate({ values: close, period: rsiPeriod });
      results.rsi = rsiResult.map((v) => (Number.isFinite(v) ? v : undefined));
    }
    if (indicators?.includes("macd")) {
      const macdResult = MACD.calculate({
        values: close,
        fastPeriod: macdFast,
        slowPeriod: macdSlow,
        signalPeriod: macdSignal,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      });
      results.macd = macdResult;
    }
    if (indicators?.includes("atr")) {
      const atrResult = ATR.calculate({ high, low, close, period: atrPeriod });
      results.atr = atrResult.map((v) => (Number.isFinite(v) ? v : undefined));
    }
    if (indicators?.includes("bollingerBands")) {
      const bbResult = BollingerBands.calculate({
        values: close,
        period: bbPeriod,
        stdDev: bbStdDev,
      });
      results.bollingerBands = bbResult;
    }
    if (indicators?.includes("ema")) {
      results.ema = EMA.calculate({ values: close, period: emaPeriod });
    }

    /** Index into indicator result array for candle at globalIndex (results may be shorter due to warmup). */
    const idx = (arr: unknown[] | undefined, globalIndex: number) =>
      arr ? globalIndex - (n - arr.length) : -1;

    const takeLast = raw.slice(-count);
    const candles = takeLast.map((c, i) => {
      const globalIndex = n - count + i;
      const row: Record<string, unknown> = {
        symbol: c.s,
        interval: c.i,
        closeTime: c.T,
        closeTimeIso: new Date(c.T).toISOString(),
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
        volume: c.v,
      };
      if (results.rsi?.length) {
        const ri = idx(results.rsi, globalIndex);
        const val = ri >= 0 ? results.rsi[ri] : undefined;
        row.rsi = val != null ? formatDecimal(val) : null;
      }
      if (results.macd?.length) {
        const ri = idx(results.macd, globalIndex);
        const m = ri >= 0 ? results.macd[ri] : undefined;
        row.macd = m
          ? {
              macd: m.MACD != null ? formatDecimal(m.MACD) : null,
              signal: m.signal != null ? formatDecimal(m.signal) : null,
              histogram: m.histogram != null ? formatDecimal(m.histogram) : null,
            }
          : null;
      }
      if (results.atr?.length) {
        const ri = idx(results.atr, globalIndex);
        const val = ri >= 0 ? results.atr[ri] : undefined;
        row.atr = val != null ? formatDecimal(val) : null;
      }
      if (results.bollingerBands?.length) {
        const ri = idx(results.bollingerBands, globalIndex);
        const b = ri >= 0 ? results.bollingerBands[ri] : undefined;
        row.bollingerBands = b
          ? {
              middle: formatDecimal(b.middle),
              upper: formatDecimal(b.upper),
              lower: formatDecimal(b.lower),
              pb: b.pb != null ? formatDecimal(b.pb) : undefined,
            }
          : null;
      }
      if (results.ema?.length) {
        const ri = idx(results.ema, globalIndex);
        const val = ri >= 0 ? results.ema[ri] : undefined;
        row.ema = val != null ? formatDecimal(val) : null;
      }
      return row;
    });

    const meta = indicators?.length
      ? {
          indicators,
          params: {
            rsiPeriod: indicators.includes("rsi") ? rsiPeriod : undefined,
            macdFast: indicators.includes("macd") ? macdFast : undefined,
            macdSlow: indicators.includes("macd") ? macdSlow : undefined,
            macdSignal: indicators.includes("macd") ? macdSignal : undefined,
            atrPeriod: indicators.includes("atr") ? atrPeriod : undefined,
            bbPeriod: indicators.includes("bollingerBands") ? bbPeriod : undefined,
            bbStdDev: indicators.includes("bollingerBands") ? bbStdDev : undefined,
            emaPeriod: indicators.includes("ema") ? emaPeriod : undefined,
          },
        }
      : undefined;

    return JSON.stringify(
      meta ? { meta, candles } : { candles },
      null,
      2
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to retrieve candle snapshot with indicators: ${errorMessage}`
    );
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
  const user = requireField(args?.user, userSchema, "user", USER_HINT);
  const coin = requireField(args?.coin, coinSchema, "coin", COIN_HINT);
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


// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------
export const hyperliquidApiTools: SdkToolDefinition[] = [
  {
    name: "get_coin_price",
    title: "Get Coin Price",
    description: "Retrieve the mid price for a single coin (e.g. BTC, ETH).",
    inputSchema: { coin: coinSchema },
    handler: async (args, _extra) => toContent(await getCoinPrice(args, getRequestContext())),
  },
  {
    name: "get_open_orders",
    title: "Get Open Orders",
    description: "Retrieve open orders for a user.",
    inputSchema: { user: userSchema },
    handler: async (args, _extra) => toContent(await getOpenOrders(args, getRequestContext())),
  },
  {
    name: "get_user_fills",
    title: "Get User Fills",
    description: "Retrieve user fills (trade history) for a user.",
    inputSchema: { user: userSchema },
    handler: async (args, _extra) => toContent(await getUserFills(args, getRequestContext())),
  },
  {
    name: "get_perps_account_summary",
    title: "Get Perps Account Summary",
    description: "Retrieve perpetuals account positions for a user.",
    inputSchema: { user: userSchema },
    handler: async (args, _extra) =>
      toContent(await getPerpsAccountSummary(args, getRequestContext())),
  },
  {
    name: "get_spot_account_summary",
    title: "Get Spot Account Summary",
    description: "Retrieve spot account balances for a user.",
    inputSchema: { user: userSchema },
    handler: async (args, _extra) =>
      toContent(await getSpotAccountSummary(args, getRequestContext())),
  },
  {
    name: "get_candle_snapshot",
    title: "Get Candle Snapshot",
    description: "Retrieve the last N candlesticks (OHLCV) for a coin. Default 10, max 30.",
    inputSchema: {
      coin: coinSchema,
      interval: candleIntervalSchema,
      count: candleCountSchema.describe(
        `Optional number of candles to return (allowed: 1 to ${MAX_CANDLE_COUNT}, default: ${DEFAULT_CANDLE_COUNT}).`
      ),
    },
    handler: async (args, _extra) =>
      toContent(await getCandleSnapshot(args, getRequestContext())),
  },
  {
    name: "get_candle_snapshot_with_indicators",
    title: "Get Candle Snapshot with Indicators",
    description: "Retrieve the last N candles with optional indicators: RSI, MACD, ATR, Bollinger Bands, EMA.",
    inputSchema: {
      coin: coinSchema,
      interval: candleIntervalSchema,
      count: candleCountSchema.describe(
        `Optional number of candles to return (1 to ${MAX_CANDLE_COUNT}, default: ${DEFAULT_CANDLE_COUNT}).`
      ),
      indicators: indicatorsSchema,
      rsiPeriod: rsiPeriodSchema,
      macdFastPeriod: macdFastPeriodSchema,
      macdSlowPeriod: macdSlowPeriodSchema,
      macdSignalPeriod: macdSignalPeriodSchema,
      atrPeriod: atrPeriodSchema,
      bbPeriod: bbPeriodSchema,
      bbStdDev: bbStdDevSchema,
      emaPeriod: emaPeriodSchema,
    },
    handler: async (args, _extra) =>
      toContent(await getCandleSnapshotWithIndicators(args, getRequestContext())),
  },
  {
    name: "get_coin_leverage_and_limits",
    title: "Get Coin Leverage and Limits",
    description: "Retrieve a user's current leverage, max trade size, available margin, and mark price for a coin.",
    inputSchema: {
      user: userSchema,
      coin: coinSchema,
    },
    handler: async (args, _extra) =>
      toContent(await getCoinLeverageAndLimits(args, getRequestContext())),
  },
];
