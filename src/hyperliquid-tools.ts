import {
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from "@nktkas/hyperliquid";
import { ATR, BollingerBands, EMA, MACD, RSI, SMA, VWAP } from "technicalindicators";
// technicalindicators – available exports (revisit for more tools):
// Moving averages: SMA, EMA, WMA, WEMA, MACD
// Oscillators: RSI, CCI, AwesomeOscillator
// Volatility: BollingerBands, KeltnerChannels, ChandelierExit
// Directional/trend: ATR, TrueRange, ADX, PlusDM, MinusDM
// Momentum: ROC, KST, PSAR, Stochastic, WilliamsR, TRIX, StochasticRSI
// Volume: ADL, OBV, ForceIndex, VWAP, VolumeProfile, MFI
// Chart types: Renko, HeikinAshi, TypicalPrice
// Ichimoku: IchimokuCloud
// Utils: AverageGain, AverageLoss, SD, Highest, Lowest, Sum, CrossUp, CrossDown, Fibonacci
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
/** Fallback lookback when no indicators requested (keeps one fetch path). */
const DEFAULT_INDICATOR_LOOKBACK = 50;
/** Hardcap: max candles we may fetch for indicator warmup (e.g. EMA 200 + count). */
const MAX_CANDLES_FOR_INDICATORS = 500;

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
  .enum(["rsi", "macd", "atr", "bollingerBands", "ema", "sma", "vwap"])
  .describe("Indicator: rsi, macd, atr, bollingerBands, ema, sma, vwap");
const indicatorsSchema = z
  .array(indicatorNameSchema)
  .min(1)
  .max(7)
  .optional()
  .describe("Optional list of indicators to compute (rsi, macd, atr, bollingerBands, ema, sma, vwap).");

const rsiPeriodSchema = z.number().int().min(2).max(30).nullish().describe("RSI period (default 14).");
const macdFastPeriodSchema = z.number().int().min(2).max(20).nullish().describe("MACD fast period (default 12).");
const macdSlowPeriodSchema = z.number().int().min(5).max(50).nullish().describe("MACD slow period (default 26).");
const macdSignalPeriodSchema = z.number().int().min(2).max(20).nullish().describe("MACD signal period (default 9).");
const atrPeriodSchema = z.number().int().min(2).max(30).nullish().describe("ATR period (default 14).");
const bbPeriodSchema = z.number().int().min(2).max(50).nullish().describe("Bollinger Bands period (default 20).");
const bbStdDevSchema = z.number().min(1).max(3).nullish().describe("Bollinger Bands standard deviations (default 2).");
const emaPeriodSchema = z.number().int().min(2).max(200).nullish().describe("EMA period (default 20, max 200).");
const smaPeriodSchema = z.number().int().min(2).max(200).nullish().describe("SMA period (default 20, max 200).");

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

/** Classify single-candle shape from OHLC (doji, hammer, inverted_hammer, bullish, bearish). */
function getCandleType(open: number, high: number, low: number, close: number): string {
  const range = high - low;
  if (range <= 0 || !Number.isFinite(range)) return "doji";
  const body = Math.abs(close - open);
  const bodyRatio = body / range;
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const minBody = range * 0.02;

  if (bodyRatio < 0.1) return "doji";
  if (lowerWick >= 2 * body && upperWick <= Math.max(minBody, body * 0.5)) return "hammer";
  if (upperWick >= 2 * body && lowerWick <= Math.max(minBody, body * 0.5)) return "inverted_hammer";
  return close >= open ? "bullish" : "bearish";
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

/** Portfolio period snapshot from SDK (accountValueHistory, pnlHistory, vlm). */
type PortfolioPeriod = {
  accountValueHistory: [number, string][];
  pnlHistory: [number, string][];
  vlm: string;
};

/** Period metrics: PnL, ROE, and start value (for deriving spot). */
type PeriodMetrics = { pnl: number; roe: number; startValue: number };

/**
 * Derive PnL, ROE and start value for a single period from history arrays.
 * PnL = change in pnl over the period; ROE = PnL / starting equity.
 */
function periodMetrics(period: PortfolioPeriod): PeriodMetrics {
  const av = period.accountValueHistory;
  const pnl = period.pnlHistory;
  const startValue = av?.length ? parseDecimal(av[0][1]) : 0;
  const startPnl = pnl?.length ? parseDecimal(pnl[0][1]) : 0;
  const endPnl = pnl?.length ? parseDecimal(pnl[pnl.length - 1][1]) : 0;
  const periodPnl = endPnl - startPnl;
  const roe = startValue !== 0 ? periodPnl / startValue : 0;
  return { pnl: periodPnl, roe, startValue };
}

/** Account-type overview: accountValue, pnl (current + periods), roe (periods only). */
type AccountOverview = {
  accountValue: string;
  pnl: { current: string; day: string; week: string; month: string; all: string };
  roe: { day: string; week: string; month: string; all: string };
};

/**
 * Build account overview from raw periods: accountValue, pnl { current, day, week, month, all }, roe { day, week, month, all }.
 * byPeriod must have day, week, month, allTime (e.g. from API for total, or mapped perpDay→day etc. for perp).
 */
function buildAccountOverview(byPeriod: Record<string, PortfolioPeriod>): AccountOverview {
  const all = byPeriod.allTime;
  const day = byPeriod.day ? periodMetrics(byPeriod.day) : { pnl: 0, roe: 0, startValue: 0 };
  const week = byPeriod.week ? periodMetrics(byPeriod.week) : { pnl: 0, roe: 0, startValue: 0 };
  const month = byPeriod.month ? periodMetrics(byPeriod.month) : { pnl: 0, roe: 0, startValue: 0 };
  const allM = all ? periodMetrics(all) : { pnl: 0, roe: 0, startValue: 0 };

  const currentAccountValue = all?.accountValueHistory?.length
    ? parseDecimal(all.accountValueHistory[all.accountValueHistory.length - 1][1])
    : 0;
  const currentPnl = all?.pnlHistory?.length
    ? parseDecimal(all.pnlHistory[all.pnlHistory.length - 1][1])
    : 0;

  return {
    accountValue: formatDecimal(currentAccountValue),
    pnl: {
      current: formatDecimal(currentPnl),
      day: formatDecimal(day.pnl),
      week: formatDecimal(week.pnl),
      month: formatDecimal(month.pnl),
      all: formatDecimal(allM.pnl),
    },
    roe: {
      day: formatDecimal(day.roe),
      week: formatDecimal(week.roe),
      month: formatDecimal(month.roe),
      all: formatDecimal(allM.roe),
    },
  };
}

/**
 * Derive spot overview from total minus perp (account value, pnl current + by period, roe by period).
 */
function buildSpotOverview(
  totalByPeriod: Record<string, PortfolioPeriod>,
  perpByPeriod: Record<string, PortfolioPeriod>
): AccountOverview {
  const totalAll = totalByPeriod.allTime;
  const perpAll = perpByPeriod.perpAllTime;
  const currentAccountValue = (totalAll?.accountValueHistory?.length ? parseDecimal(totalAll.accountValueHistory[totalAll.accountValueHistory.length - 1][1]) : 0) -
    (perpAll?.accountValueHistory?.length ? parseDecimal(perpAll.accountValueHistory[perpAll.accountValueHistory.length - 1][1]) : 0);
  const currentPnl = (totalAll?.pnlHistory?.length ? parseDecimal(totalAll.pnlHistory[totalAll.pnlHistory.length - 1][1]) : 0) -
    (perpAll?.pnlHistory?.length ? parseDecimal(perpAll.pnlHistory[perpAll.pnlHistory.length - 1][1]) : 0);

  const keys: Array<{ total: keyof typeof totalByPeriod; perp: keyof typeof perpByPeriod }> = [
    { total: "day", perp: "perpDay" },
    { total: "week", perp: "perpWeek" },
    { total: "month", perp: "perpMonth" },
    { total: "allTime", perp: "perpAllTime" },
  ];
  const pnl: AccountOverview["pnl"] = { current: formatDecimal(currentPnl), day: "0", week: "0", month: "0", all: "0" };
  const roe: AccountOverview["roe"] = { day: "0", week: "0", month: "0", all: "0" };
  for (const { total, perp } of keys) {
    const t = totalByPeriod[total] ? periodMetrics(totalByPeriod[total]) : { pnl: 0, roe: 0, startValue: 0 };
    const p = perpByPeriod[perp] ? periodMetrics(perpByPeriod[perp]) : { pnl: 0, roe: 0, startValue: 0 };
    const spotPnl = t.pnl - p.pnl;
    const spotStartValue = t.startValue - p.startValue;
    const spotRoe = spotStartValue !== 0 ? spotPnl / spotStartValue : 0;
    const periodKey = total === "allTime" ? "all" : total;
    pnl[periodKey as keyof typeof pnl] = formatDecimal(spotPnl);
    roe[periodKey as keyof typeof roe] = formatDecimal(spotRoe);
  }

  return {
    accountValue: formatDecimal(currentAccountValue),
    pnl,
    roe,
  };
}

/**
 * Retrieve portfolio overview for a user by account type (total, perp, spot).
 * Total and perp come from the API; spot is derived as total minus perp.
 * Each type has current account value & PnL and by-period (day/week/month/all) PnL & ROE.
 * Uses the Hyperliquid SDK InfoClient portfolio.
 */
export async function getPortfolioOverview(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const user = requireField(args?.user, userSchema, "user", USER_HINT);
  try {
    const data = await infoClient.portfolio({ user });
    // data: [["day", {...}], ["week", ...], ["month", ...], ["allTime", ...], ["perpDay", ...], ["perpWeek", ...], ["perpMonth", ...], ["perpAllTime", ...]]
    const byPeriod = Object.fromEntries(data) as Record<string, PortfolioPeriod>;

    const total = buildAccountOverview(byPeriod);
    const perp = buildAccountOverview({
      day: byPeriod.perpDay,
      week: byPeriod.perpWeek,
      month: byPeriod.perpMonth,
      allTime: byPeriod.perpAllTime,
    });
    const spot = buildSpotOverview(byPeriod, byPeriod);

    const overview = {
      user,
      total,
      perp,
      spot,
    };
    return JSON.stringify(overview, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve portfolio overview: ${errorMessage}`);
  }
}


/** Default periods for indicators (standard defaults). */
const DEFAULT_RSI_PERIOD = 14;
/** Length of SMA applied to RSI (for rsiSma and crossover). */
const RSI_SMA_LENGTH = 14;
const DEFAULT_MACD_FAST = 12;
const DEFAULT_MACD_SLOW = 26;
const DEFAULT_MACD_SIGNAL = 9;
const DEFAULT_ATR_PERIOD = 14;
const DEFAULT_BB_PERIOD = 20;
const DEFAULT_BB_STDDEV = 2;
const DEFAULT_EMA_PERIOD = 20;
const DEFAULT_SMA_PERIOD = 20;

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
 * Compute required candle lookback from requested indicators and their periods.
 * Each indicator needs at least its period (MACD needs slow + signal) for warmup.
 */
function getRequiredIndicatorLookback(
  indicators: string[] | null,
  periods: {
    rsiPeriod: number;
    macdSlow: number;
    macdSignal: number;
    atrPeriod: number;
    bbPeriod: number;
    emaPeriod: number;
    smaPeriod: number;
  }
): number {
  if (!indicators?.length) return DEFAULT_INDICATOR_LOOKBACK;
  let lookback = 0;
  // RSI SMA needs rsiPeriod + RSI_SMA_LENGTH candles for RSI, then (RSI_SMA_LENGTH - 1) more for first SMA value
  if (indicators.includes("rsi"))
    lookback = Math.max(lookback, periods.rsiPeriod + RSI_SMA_LENGTH + (RSI_SMA_LENGTH - 1));
  if (indicators.includes("macd"))
    lookback = Math.max(lookback, periods.macdSlow + periods.macdSignal);
  if (indicators.includes("atr")) lookback = Math.max(lookback, periods.atrPeriod);
  if (indicators.includes("bollingerBands")) lookback = Math.max(lookback, periods.bbPeriod);
  if (indicators.includes("ema")) lookback = Math.max(lookback, periods.emaPeriod);
  if (indicators.includes("sma")) lookback = Math.max(lookback, periods.smaPeriod);
  // VWAP is cumulative per candle, no extra warmup
  if (indicators.includes("vwap")) lookback = Math.max(lookback, 1);
  return lookback || DEFAULT_INDICATOR_LOOKBACK;
}

/**
 * Fetch enough candles for count + indicator warmup (lookback from indicator periods).
 */
async function fetchCandlesForIndicators(
  coin: string,
  interval: z.infer<typeof candleIntervalSchema>,
  count: number,
  lookback: number
): Promise<CandleRow[]> {
  const fetchCount = Math.min(MAX_CANDLES_FOR_INDICATORS, count + lookback);
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

const DEFAULT_PIVOT_LEFT = 10;
const DEFAULT_PIVOT_RIGHT = 5;
const PIVOT_CANDLE_COUNT = 300;
const PIVOT_MAX_RECENT = 5;

type PivotPoint = {
  timestamp: number;
  timestampIso: string;
  barsAgo: number;
  price: number;
  pctFromCurrentClose: number;
};

/**
 * Compute pivot highs and pivot lows from OHLC arrays.
 * A pivot high at index i: high[i] is the max of high[i-left]..high[i+right].
 * A pivot low at index i: low[i] is the min of low[i-left]..low[i+right].
 * Only includes pivots that have not been cleared: no candle after the pivot bar
 * has broken the level (high >= pivot high price, or low <= pivot low price).
 * Candles are ordered oldest-first; "current" is the last candle (index n-1).
 */
function computePivots(
  raw: CandleRow[],
  left: number,
  right: number,
  currentClose: number
): { pivotHighs: PivotPoint[]; pivotLows: PivotPoint[] } {
  const n = raw.length;
  const high = raw.map((c) => parseDecimal(c.h));
  const low = raw.map((c) => parseDecimal(c.l));
  const pivotHighs: PivotPoint[] = [];
  const pivotLows: PivotPoint[] = [];

  for (let i = left; i < n - right; i++) {
    let isPivotHigh = true;
    let isPivotLow = true;
    const hi = high[i];
    const li = low[i];

    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (high[j] > hi) isPivotHigh = false;
      if (low[j] < li) isPivotLow = false;
      if (!isPivotHigh && !isPivotLow) break;
    }

    const barsAgo = n - 1 - i;
    const pctFromClose = currentClose !== 0
      ? Math.round((hi - currentClose) / currentClose * 10000) / 100
      : 0;
    const pctFromCloseLow = currentClose !== 0
      ? Math.round((li - currentClose) / currentClose * 10000) / 100
      : 0;

    // Not cleared: no candle after this pivot has broken the level (high above pivot high, low below pivot low)
    let pivotHighNotCleared = true;
    let pivotLowNotCleared = true;
    for (let j = i + 1; j < n; j++) {
      if (high[j] >= hi) pivotHighNotCleared = false;
      if (low[j] <= li) pivotLowNotCleared = false;
      if (!pivotHighNotCleared && !pivotLowNotCleared) break;
    }

    if (isPivotHigh && pivotHighNotCleared) {
      pivotHighs.push({
        timestamp: raw[i].T,
        timestampIso: new Date(raw[i].T).toISOString(),
        barsAgo,
        price: hi,
        pctFromCurrentClose: pctFromClose,
      });
    }
    if (isPivotLow && pivotLowNotCleared) {
      pivotLows.push({
        timestamp: raw[i].T,
        timestampIso: new Date(raw[i].T).toISOString(),
        barsAgo,
        price: li,
        pctFromCurrentClose: pctFromCloseLow,
      });
    }
  }

  return { pivotHighs, pivotLows };
}

/**
 * Fetch 300 candles and return up to 5 most recent pivot highs (resistance) and pivot lows (support)
 * that have not been cleared. A pivot high is cleared if any later candle's high >= its price;
 * a pivot low is cleared if any later candle's low <= its price.
 */
export async function getPivotHighsAndLows(
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
  const leftBars = DEFAULT_PIVOT_LEFT;
  const rightBars = DEFAULT_PIVOT_RIGHT;

  try {
    const raw = await fetchCandlesForIndicators(coin, interval, PIVOT_CANDLE_COUNT, 0);
    const n = raw.length;
    if (n === 0) {
      return JSON.stringify(
        { pivotHighs: [], pivotLows: [], message: "No candle data returned." },
        null,
        2
      );
    }

    const currentClose = parseDecimal(raw[n - 1].c);
    const currentHigh = parseDecimal(raw[n - 1].h);
    const currentLow = parseDecimal(raw[n - 1].l);
    const { pivotHighs, pivotLows } = computePivots(raw, leftBars, rightBars, currentClose);
    // Only pivots above current high (resistance) or below current low (support), then take 5 most recent
    const filteredHighs = pivotHighs.filter((p) => p.price > currentHigh).slice(-PIVOT_MAX_RECENT);
    const filteredLows = pivotLows.filter((p) => p.price < currentLow).slice(-PIVOT_MAX_RECENT);

    return JSON.stringify(
      {
        coin,
        interval,
        currentClose,
        currentHigh,
        currentLow,
        pivotHighs: filteredHighs,
        pivotLows: filteredLows,
      },
      null,
      2
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get pivot highs/lows for ${coin}: ${errorMessage}`);
  }
}

/**
 * Retrieve candle snapshot with optional technical indicators (RSI, MACD, ATR, Bollinger Bands).
 * Fetches enough candles for indicator warmup, computes selected indicators, returns last N candles with values.
 */
export async function getCandleSnapshotWithIndicators(
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
  const emaPeriod = Math.min(200, Math.max(2, Number(args?.emaPeriod) || DEFAULT_EMA_PERIOD));
  const smaPeriod = Math.min(200, Math.max(2, Number(args?.smaPeriod) || DEFAULT_SMA_PERIOD));

  const lookback = getRequiredIndicatorLookback(indicators ?? null, {
    rsiPeriod,
    macdSlow,
    macdSignal,
    atrPeriod,
    bbPeriod,
    emaPeriod,
    smaPeriod,
  });

  try {
    const raw = await fetchCandlesForIndicators(coin, interval, count, lookback);
    const n = raw.length;
    if (n === 0) {
      return JSON.stringify({ candles: [], message: "No candle data returned." }, null, 2);
    }

    const high = raw.map((c) => parseDecimal(c.h));
    const low = raw.map((c) => parseDecimal(c.l));
    const close = raw.map((c) => parseDecimal(c.c));
    const volume = raw.map((c) => parseDecimal(c.v));

    type IndicatorResults = {
      rsi?: (number | undefined)[];
      rsiSma?: (number | undefined)[];
      macd?: { MACD?: number; signal?: number; histogram?: number }[];
      atr?: (number | undefined)[];
      bollingerBands?: { middle: number; upper: number; lower: number; pb?: number }[];
      ema?: number[];
      sma?: number[];
      vwap?: number[];
    };
    const results: IndicatorResults = {};

    if (indicators?.includes("rsi")) {
      const rsiResult = RSI.calculate({ values: close, period: rsiPeriod });
      results.rsi = rsiResult.map((v) => (Number.isFinite(v) ? v : undefined));
      // 14-period SMA of RSI via library (for rsiSma value and RSI vs RSI-SMA crossover)
      const from = rsiPeriod; // RSI has values from this index onward
      const rsiSlice = results.rsi!.slice(from) as number[];
      const smaResult =
        rsiSlice.length >= RSI_SMA_LENGTH
          ? SMA.calculate({ period: RSI_SMA_LENGTH, values: rsiSlice })
          : [];
      const pad = from + RSI_SMA_LENGTH - 1;
      results.rsiSma = [
        ...Array.from<undefined>({ length: pad }).fill(undefined),
        ...smaResult,
      ];
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
    if (indicators?.includes("sma")) {
      results.sma = SMA.calculate({ values: close, period: smaPeriod });
    }
    if (indicators?.includes("vwap")) {
      results.vwap = VWAP.calculate({ high, low, close, volume });
    }

    /** Index into indicator result array for candle at globalIndex (results may be shorter due to warmup). */
    const idx = (arr: unknown[] | undefined, globalIndex: number) =>
      arr ? globalIndex - (n - arr.length) : -1;

    const takeLast = raw.slice(-count);
    const candles = takeLast.map((c, i) => {
      const globalIndex = n - count + i;
      const openN = parseDecimal(c.o);
      const highN = parseDecimal(c.h);
      const lowN = parseDecimal(c.l);
      const closeN = parseDecimal(c.c);
      const volumeN = parseDecimal(c.v);
      const timestampIso = new Date(c.T).toISOString();
      const barsAgo = count - 1 - i; // 0 = most recent bar in the snapshot

      const prevCandle = globalIndex > 0 ? raw[globalIndex - 1] : undefined;
      const prevClose = prevCandle != null ? parseDecimal(prevCandle.c) : null;
      const priceChange =
        prevClose != null && Number.isFinite(prevClose)
          ? closeN - prevClose
          : null;
      const priceChangePct =
        prevClose != null && Number.isFinite(prevClose) && prevClose !== 0
          ? Math.round((closeN - prevClose) / prevClose * 10000) / 100
          : null;

      const row: Record<string, unknown> = {
        timestamp: c.T,
        timestampIso,
        barsAgo,
        candleType: getCandleType(openN, highN, lowN, closeN),
        priceChange: priceChange ?? null,
        priceChangePct: priceChangePct ?? null,
        ohlcv: {
          open: openN,
          high: highN,
          low: lowN,
          close: closeN,
          volume: volumeN,
        },
      };

      const ind: Record<string, unknown> = {};
      let hasIndicators = false;

      if (results.rsi?.length) {
        const ri = idx(results.rsi, globalIndex);
        const val = ri >= 0 ? results.rsi[ri] : undefined;
        const prevRi = idx(results.rsi, globalIndex - 1);
        const prevVal = prevRi >= 0 ? results.rsi![prevRi] : undefined;
        const rsiSmaVal = results.rsiSma && ri >= 0 ? results.rsiSma[ri] : undefined;
        const prevRsiSmaRi = results.rsiSma ? idx(results.rsiSma, globalIndex - 1) : -1;
        const prevRsiSmaVal = prevRsiSmaRi >= 0 ? results.rsiSma![prevRsiSmaRi] : undefined;
        let rsiCrossover: "bullish" | "bearish" | null = null;
        if (
          prevVal != null && Number.isFinite(prevVal) &&
          prevRsiSmaVal != null && Number.isFinite(prevRsiSmaVal) &&
          val != null && Number.isFinite(val) &&
          rsiSmaVal != null && Number.isFinite(rsiSmaVal)
        ) {
          if (prevVal < prevRsiSmaVal && val > rsiSmaVal) rsiCrossover = "bullish";
          else if (prevVal > prevRsiSmaVal && val < rsiSmaVal) rsiCrossover = "bearish";
        }
        if (val != null && Number.isFinite(val)) {
          const trend: "bullish" | "bearish" | "neutral" =
            rsiSmaVal != null && Number.isFinite(rsiSmaVal)
              ? val > rsiSmaVal
                ? "bullish"
                : val < rsiSmaVal
                  ? "bearish"
                  : "neutral"
              : "neutral";
          ind.rsi = {
            value: val,
            rsiSma: rsiSmaVal != null && Number.isFinite(rsiSmaVal) ? rsiSmaVal : null,
            trend,
            crossover: rsiCrossover ?? null,
            zone: val < 30 ? "oversold" : val > 70 ? "overbought" : "neutral",
          };
          hasIndicators = true;
        }
      }
      if (results.macd?.length) {
        const ri = idx(results.macd, globalIndex);
        const m = ri >= 0 ? results.macd[ri] : undefined;
        const prevRi = idx(results.macd, globalIndex - 1);
        const prevM = prevRi >= 0 ? results.macd[prevRi] : undefined;
        const prevHist = prevM?.histogram;
        const currHist = m?.histogram;
        let crossover: "bullish" | "bearish" | null = null;
        if (
          prevHist != null &&
          Number.isFinite(prevHist) &&
          currHist != null &&
          Number.isFinite(currHist)
        ) {
          if (prevHist < 0 && currHist > 0) crossover = "bullish";
          else if (prevHist > 0 && currHist < 0) crossover = "bearish";
        }
        if (m && (m.MACD != null || m.signal != null || m.histogram != null)) {
          const h = m.histogram ?? 0;
          const trend: "bullish" | "bearish" | "neutral" =
            h > 0 ? "bullish" : h < 0 ? "bearish" : "neutral";
          ind.macd = {
            line: m.MACD ?? null,
            signal: m.signal ?? null,
            histogram: m.histogram ?? null,
            trend,
            crossover,
          };
          hasIndicators = true;
        }
      }
      if (results.atr?.length) {
        const ri = idx(results.atr, globalIndex);
        const val = ri >= 0 ? results.atr[ri] : undefined;
        if (val != null && Number.isFinite(val)) {
          ind.atr = val;
          hasIndicators = true;
        }
      }
      if (results.bollingerBands?.length) {
        const ri = idx(results.bollingerBands, globalIndex);
        const b = ri >= 0 ? results.bollingerBands[ri] : undefined;
        if (b) {
          const pb =
            b.pb != null && Number.isFinite(b.pb)
              ? b.pb
              : b.upper - b.lower !== 0
                ? (closeN - b.lower) / (b.upper - b.lower)
                : null;
          ind.bb = {
            upper: b.upper,
            middle: b.middle,
            lower: b.lower,
            percentB: pb != null ? Math.round(pb * 100) / 100 : null,
          };
          hasIndicators = true;
        }
      }
      if (results.ema?.length) {
        const ri = idx(results.ema, globalIndex);
        const val = ri >= 0 ? results.ema[ri] : undefined;
        if (val != null && Number.isFinite(val)) {
          const trend: "bullish" | "bearish" | "neutral" =
            closeN > val ? "bullish" : closeN < val ? "bearish" : "neutral";
          ind.ema = { value: val, trend };
          hasIndicators = true;
        }
      }
      if (results.sma?.length) {
        const ri = idx(results.sma, globalIndex);
        const val = ri >= 0 ? results.sma[ri] : undefined;
        if (val != null && Number.isFinite(val)) {
          const trend: "bullish" | "bearish" | "neutral" =
            closeN > val ? "bullish" : closeN < val ? "bearish" : "neutral";
          ind.sma = { value: val, trend };
          hasIndicators = true;
        }
      }
      if (results.vwap?.length) {
        const ri = idx(results.vwap, globalIndex);
        const val = ri >= 0 ? results.vwap[ri] : undefined;
        if (val != null && Number.isFinite(val)) {
          const trend: "bullish" | "bearish" | "neutral" =
            closeN > val ? "bullish" : closeN < val ? "bearish" : "neutral";
          ind.vwap = { value: val, trend };
          hasIndicators = true;
        }
      }
      if (hasIndicators) row.indicators = ind;
      return row;
    });

    const firstCandle = candles[0] as Record<string, unknown> | undefined;
    const lastCandle = candles[candles.length - 1] as Record<string, unknown> | undefined;
    const meta = indicators?.length
      ? {
          symbol: coin,
          interval,
          dataRange: {
            from: firstCandle?.timestampIso ?? null,
            to: lastCandle?.timestampIso ?? null,
            candleCount: candles.length,
          },
          indicators: {
            ...(indicators.includes("rsi") && { rsi: { period: rsiPeriod, rsiSmaLength: RSI_SMA_LENGTH } }),
            ...(indicators.includes("macd") && {
              macd: { fast: macdFast, slow: macdSlow, signal: macdSignal },
            }),
            ...(indicators.includes("atr") && { atr: { period: atrPeriod } }),
            ...(indicators.includes("bollingerBands") && {
              bb: { period: bbPeriod, stdDev: bbStdDev },
            }),
            ...(indicators.includes("ema") && { ema: { period: emaPeriod } }),
            ...(indicators.includes("sma") && { sma: { period: smaPeriod } }),
            ...(indicators.includes("vwap") && { vwap: {} }),
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
    name: "get_portfolio_overview",
    title: "Get Portfolio Overview",
    description: "Retrieve portfolio overview for a user by type (total, perp, spot): current value, PnL, and ROE for day/week/month/all.",
    inputSchema: { user: userSchema },
    handler: async (args, _extra) =>
      toContent(await getPortfolioOverview(args, getRequestContext())),
  },
  {
    name: "get_market_data",
    title: "Get Market Data",
    description: "Retrieve last N candles (OHLCV) for a coin and interval, with optional indicators: RSI, MACD, ATR, Bollinger Bands, EMA, SMA, VWAP.",
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
      smaPeriod: smaPeriodSchema,
    },
    handler: async (args, _extra) =>
      toContent(await getCandleSnapshotWithIndicators(args, getRequestContext())),
  },
  {
    name: "get_pivot_highs_and_lows",
    title: "Get Pivot Highs and Lows",
    description: "Retrieve recent uncleared pivot highs (resistance) and pivot lows (support) for a coin and interval.",
    inputSchema: {
      coin: coinSchema,
      interval: candleIntervalSchema,
    },
    handler: async (args, _extra) =>
      toContent(await getPivotHighsAndLows(args, getRequestContext())),
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
