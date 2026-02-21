import {
  HttpTransport,
  InfoClient,
} from "@nktkas/hyperliquid";
import { ATR, BollingerBands, EMA, MACD, OBV, RSI, SMA, VWAP } from "technicalindicators";
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
import {
  coerceArrayInput,
  coerceNumberInput,
  toContent,
  type SdkToolDefinition,
} from "./tool-common.js";
import {
  computePivots,
  formatDecimal,
  formatOpenOrders,
  formatPortfolioOverview,
  formatPerpsSummary,
  formatSpotSummary,
  formatUserFills,
  getCandleType,
  getRequiredIndicatorLookback,
  getSubscriptionSnapshot,
  parseDecimal,
  requireField,
  type CandleRow,
} from "./hyperliquid-utils.js";

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
/** Hardcap: max candles we may fetch for indicator warmup (e.g. EMA 200 + count). */
const MAX_CANDLES_FOR_INDICATORS = 500;

const COIN_HINT = "Provide coin (e.g. BTC, ETH) or spot pair (e.g. BTC/USDC).";
const USER_HINT = "Provide user (wallet address, e.g. 0x...).";
const INTERVAL_HINT = "Use one of: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d, 3d, 1w, 1M.";

const DEFAULT_PIVOT_LEFT = 10;
const DEFAULT_PIVOT_RIGHT = 5;
const PIVOT_CANDLE_COUNT = 300;
const PIVOT_MAX_RECENT = 5;

/** Default periods for indicators (standard defaults). */
const DEFAULT_RSI_PERIOD = 14;
const DEFAULT_RSI_SMA_LENGTH = 14;
const OBV_SMA_LENGTH = 14;
const DEFAULT_MACD_FAST = 12;
const DEFAULT_MACD_SLOW = 26;
const DEFAULT_MACD_SIGNAL = 9;
const DEFAULT_ATR_PERIOD = 14;
const DEFAULT_BB_PERIOD = 20;
const DEFAULT_BB_STDDEV = 2;
const DEFAULT_EMA_PERIOD = 20;
const DEFAULT_SMA_PERIOD = 20;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const coinSchema = z.string().describe("Asset symbol (e.g. BTC, ETH).");
const intRangeSchema = (min: number, max: number) =>
  z.preprocess(coerceNumberInput, z.number().int().min(min).max(max));
const numberRangeSchema = (min: number, max: number) =>
  z.preprocess(coerceNumberInput, z.number().min(min).max(max));
const coinsSchema = z.preprocess(
  coerceArrayInput,
  z
    .array(coinSchema)
    .min(1)
    .max(50)
    .describe("List of asset symbols (or dex-prefixed symbols like dex:BTC).")
);
const tradeHistoryLimitSchema = z
  .preprocess(coerceNumberInput, z.number().int().min(1).max(50))
  .nullish()
  .describe("Maximum number of most recent fills to return (1-50, default 10).");
const marketQuerySchema = z
  .string()
  .trim()
  .min(1)
  .describe("Market search query (e.g. BTC).");
const trendingSortingSchema = z
  .enum(["volume", "price_change"])
  .nullish()
  .describe("Trending sorting: volume (24h notional) or price_change (24h % change). Default: volume.");
const userSchema = z.string().transform((s) => s.toLowerCase()).describe("The user's hyperliquid wallet address (e.g. 0x...).");
const candleIntervalSchema = z.enum(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"]).describe("Candle interval (Allowed: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d, 3d, 1w, 1M).");
const candleCountSchema = intRangeSchema(1, MAX_CANDLE_COUNT).nullish();
const orderbookSigFigsSchema = z
  .preprocess(coerceNumberInput, z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]))
  .nullish()
  .describe("Optional significant figures for aggregation (2, 3, 4, 5).");
const orderbookDepthSchema = z
  .preprocess(coerceNumberInput, z.number().int().min(1).max(50))
  .nullish()
  .describe("Optional number of bid/ask levels to return per side (1-50, default 20).");

const indicatorNameSchema = z
  .enum(["rsi", "macd", "atr", "bollingerBands", "ema", "sma", "vwap", "obv"])
  .describe("Indicator: rsi, macd, atr, bollingerBands, ema, sma, vwap, obv");
const indicatorsSchema = z.preprocess(
  coerceArrayInput,
  z
    .array(indicatorNameSchema)
    .min(1)
    .max(8)
    .optional()
    .describe("Optional list of indicators to compute (rsi, macd, atr, bollingerBands, ema, sma, vwap, obv).")
);

const rsiPeriodSchema = intRangeSchema(2, 30).nullish().describe("RSI period (default 14).");
const rsiSmaLengthSchema = intRangeSchema(2, 50).nullish().describe("RSI SMA length (default 14).");
const macdFastPeriodSchema = intRangeSchema(2, 20).nullish().describe("MACD fast period (default 12).");
const macdSlowPeriodSchema = intRangeSchema(5, 50).nullish().describe("MACD slow period (default 26).");
const macdSignalPeriodSchema = intRangeSchema(2, 20).nullish().describe("MACD signal period (default 9).");
const atrPeriodSchema = intRangeSchema(2, 30).nullish().describe("ATR period (default 14).");
const bbPeriodSchema = intRangeSchema(2, 50).nullish().describe("Bollinger Bands period (default 20).");
const bbStdDevSchema = numberRangeSchema(1, 3).nullish().describe("Bollinger Bands standard deviations (default 2).");
const emaPeriodSchema = intRangeSchema(2, 200).nullish().describe("EMA period (default 20, max 200).");
const smaPeriodSchema = intRangeSchema(2, 200).nullish().describe("SMA period (default 20, max 200).");

let spotPairIdMapPromise: Promise<Map<string, string>> | null = null;

async function getSpotPairIdMap(): Promise<Map<string, string>> {
  if (spotPairIdMapPromise) return spotPairIdMapPromise;
  spotPairIdMapPromise = (async () => {
    const meta = await infoClient.spotMeta();
    const tokenNameByIndex = new Map<number, string>();
    for (const token of meta.tokens) {
      tokenNameByIndex.set(token.index, token.name);
    }

    const map = new Map<string, string>();
    for (const market of meta.universe) {
      if (market.tokens.length < 2) continue;
      const base = tokenNameByIndex.get(market.tokens[0]);
      const quote = tokenNameByIndex.get(market.tokens[1]);
      if (!base || !quote) continue;
      map.set(`${base}/${quote}`.toUpperCase(), market.name);
    }
    return map;
  })();
  return spotPairIdMapPromise;
}

/**
 * Normalize coin parameter for Hyperliquid endpoints:
 * - Perps / dex-perps: keep as-is (e.g. BTC, dex:BTC).
 * - Spot pair symbols: convert BASE/QUOTE to spot pair id (e.g. BTC/USDC -> @105).
 */
async function normalizeCoinParam(rawCoin: string): Promise<string> {
  if (!rawCoin.includes("/")) return rawCoin;

  const colonIndex = rawCoin.indexOf(":");
  if (colonIndex >= 0 && colonIndex < rawCoin.indexOf("/")) {
    throw new Error(
      `Spot pair '${rawCoin}' should not include dex prefix. Use BASE/QUOTE (e.g. BTC/USDC).`
    );
  }

  const pairIdMap = await getSpotPairIdMap();
  const pairId = pairIdMap.get(rawCoin.toUpperCase());
  if (!pairId) {
    throw new Error(
      `Spot pair '${rawCoin}' not found. Use format BASE/QUOTE (e.g. BTC/USDC).`
    );
  }
  return pairId;
}

/**
 * Retrieve L2 order book snapshot for a market.
 * Uses Hyperliquid SDK InfoClient l2Book.
 */
async function getOrderbook(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const rawCoin = requireField(args?.coin, coinSchema, "coin", COIN_HINT);
  const coin = await normalizeCoinParam(rawCoin);
  const nSigFigs = requireField(
    args?.nSigFigs,
    orderbookSigFigsSchema,
    "nSigFigs",
    "Use nSigFigs as one of: 2, 3, 4, 5."
  );
  const depth =
    requireField(
      args?.depth,
      orderbookDepthSchema,
      "depth",
      "Use depth between 1 and 50."
    ) ?? 20;

  try {
    const data = await infoClient.l2Book({
      coin,
      ...(nSigFigs !== undefined && nSigFigs !== null ? { nSigFigs } : {}),
    });

    if (!data) {
      return JSON.stringify(
        {
          coin: rawCoin,
          message: "Market not found.",
        },
        null,
        2
      );
    }

    const bids = data.levels[0].slice(0, depth);
    const asks = data.levels[1].slice(0, depth);

    const bestBid = bids[0]?.px ?? null;
    const bestAsk = asks[0]?.px ?? null;
    const bestBidN =
      bestBid !== null ? parseDecimal(bestBid) : null;
    const bestAskN =
      bestAsk !== null ? parseDecimal(bestAsk) : null;
    const midPxN =
      bestBidN !== null && bestAskN !== null
        ? (bestBidN + bestAskN) / 2
        : null;
    const midPx =
      midPxN !== null
        ? formatDecimal(midPxN)
        : null;
    const spread =
      data.spread ??
      (bestBidN !== null && bestAskN !== null
        ? formatDecimal(bestAskN - bestBidN)
        : null);
    const spreadN = spread !== null ? parseDecimal(spread) : null;
    const spreadPct =
      spreadN !== null && midPxN !== null && midPxN !== 0
        ? formatDecimal((spreadN / midPxN) * 100)
        : null;

    const output = {
      coin: rawCoin,
      summary: {
        bestBid,
        bestAsk,
        midPx,
        spread,
        spreadPct,
        bidLevels: bids.length,
        askLevels: asks.length,
      },
      levels: {
        bids,
        asks,
      },
    };

    return JSON.stringify(output, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve orderbook: ${errorMessage}`);
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Retrieve mid price(s) for one or more coins.
 * Uses the Hyperliquid REST info endpoint (allMids) for low latency.
 * Coin values may be "SYMBOL" or "dex:SYMBOL"; when dex-prefixed, the dex part is passed to allMids.
 * Accepts `coins` (list).
 */
async function getCoinPrice(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const requestedCoinsRaw = requireField(
    args?.coins,
    coinsSchema,
    "coins",
    "Provide non-empty coins list (e.g. ['BTC', 'ETH', 'HYPE/USDC'])."
  );

  const requestedCoins = await Promise.all(
    requestedCoinsRaw.map(async (rawCoin) => ({
      rawCoin,
      normalizedCoin: await normalizeCoinParam(rawCoin),
    }))
  );

  const byDex = new Map<string, Array<{ rawCoin: string; key: string }>>();
  for (const { rawCoin, normalizedCoin } of requestedCoins) {
    const dexColonIndex = normalizedCoin.indexOf(":");
    const dex =
      dexColonIndex >= 0 ? normalizedCoin.slice(0, dexColonIndex) : "";
    const coin =
      dexColonIndex >= 0
        ? normalizedCoin.slice(dexColonIndex + 1)
        : normalizedCoin;
    const key = coin.toUpperCase();
    const list = byDex.get(dex) ?? [];
    list.push({ rawCoin, key });
    byDex.set(dex, list);
  }

  try {
    const midsByDex = new Map<string, Record<string, string>>();
    const dexKeys = Array.from(byDex.keys());
    const dexFetchResults = await Promise.allSettled(
      dexKeys.map(async (dex) => {
        const mids = await infoClient.allMids(dex !== "" ? { dex } : undefined);
        return { dex, mids };
      })
    );
    const dexErrors = new Map<string, string>();
    for (let i = 0; i < dexFetchResults.length; i++) {
      const result = dexFetchResults[i];
      if (result.status === "fulfilled") {
        midsByDex.set(result.value.dex, result.value.mids);
        continue;
      }
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      const dex = dexKeys[i];
      dexErrors.set(dex, reason);
    }

    const resultByCoin: Record<string, string> = {};
    for (const [dex, list] of byDex) {
      const dexError = dexErrors.get(dex);
      if (dexError) {
        for (const { rawCoin } of list) {
          resultByCoin[rawCoin] = `Failed to fetch mids for dex '${dex || "hyperliquid"}': ${dexError}`;
        }
        continue;
      }

      const mids = midsByDex.get(dex) ?? {};
      for (const { rawCoin, key } of list) {
        const mid = mids[key];
        if (mid === undefined) {
          resultByCoin[rawCoin] = "Coin not found.";
          continue;
        }
        resultByCoin[rawCoin] = mid;
      }
    }
    return JSON.stringify(resultByCoin, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve mid prices: ${errorMessage}`);
  }
}

/**
 * Search all markets by query across perps (all dexs) and spot pairs.
 */
async function searchMarkets(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const query = requireField(
    args?.query,
    marketQuerySchema,
    "query",
    "Provide a non-empty market query (e.g. BTC)."
  );
  const queryUpper = query.toUpperCase();

  try {
    const allPerpMetas = await infoClient.allPerpMetas();
    const perpMatches = new Set<string>();
    for (let i = 0; i < allPerpMetas.length; i++) {
      const meta = allPerpMetas[i];
      for (const asset of meta.universe) {
        if (asset.isDelisted === true) continue;
        if (!asset.name.toUpperCase().includes(queryUpper)) continue;
        perpMatches.add(asset.name);
      }
    }

    const spotMeta = await infoClient.spotMeta();
    const tokenByIndex = new Map<number, string>();
    for (const token of spotMeta.tokens) tokenByIndex.set(token.index, token.name);

    const spotMatches = new Set<string>();
    for (const market of spotMeta.universe) {
      if (market.tokens.length < 2) continue;
      const base = tokenByIndex.get(market.tokens[0]);
      const quote = tokenByIndex.get(market.tokens[1]);
      if (!base || !quote) continue;
      const pair = `${base}/${quote}`;
      if (!pair.toUpperCase().includes(queryUpper)) continue;
      spotMatches.add(pair);
    }

    return JSON.stringify(
      {
        query,
        perps: {
          count: perpMatches.size,
          list: Array.from(perpMatches).sort(),
        },
        spot: {
          count: spotMatches.size,
          list: Array.from(spotMatches).sort(),
        },
      },
      null,
      2
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to search markets for '${query}': ${errorMessage}`);
  }
}

type PerpContextRow = {
  coin: string;
  volume24hNotional: string;
  volume24hBase: string;
  price24hChangePct: string;
  prevDayPx: string;
  midPx: string;
  markPx: string;
  funding: string;
  openInterest: string;
  premium: string;
};

type SpotContextRow = {
  coin: string;
  volume24hNotional: string;
  volume24hBase: string;
  price24hChangePct: string;
  prevDayPx: string;
  midPx: string;
  markPx: string;
};

function computePrice24hChangePct(
  prevDayPx: string,
  refPx: string
): string {
  const prev = parseDecimal(prevDayPx);
  const ref = parseDecimal(refPx);
  const pct = prev !== 0 ? ((ref - prev) / prev) * 100 : 0;
  return formatDecimal(pct);
}

async function fetchPerpContextRows(): Promise<PerpContextRow[]> {
  const perpCtxEvent = await getSubscriptionSnapshot<{
    ctxs: Array<
      [string, Array<{
        prevDayPx: string;
        dayNtlVlm: string;
        markPx: string;
        midPx: string | null;
        funding: string;
        openInterest: string;
        premium: string | null;
        dayBaseVlm: string;
      }>]
    >;
  }>((client, onData) => client.allDexsAssetCtxs(onData));

  const perpDexs = perpCtxEvent.ctxs.map(([dex]) => dex);
  const perpMetaResults = await Promise.all(
    perpDexs.map(async (dex) => ({
      dex,
      meta: await infoClient.meta(dex ? { dex } : undefined),
    }))
  );
  const perpMetaByDex = new Map(perpMetaResults.map((x) => [x.dex, x.meta]));

  return perpCtxEvent.ctxs.flatMap(([dex, ctxs]) => {
    const meta = perpMetaByDex.get(dex);
    if (!meta) return [];
    return ctxs.flatMap((ctx, i) => {
      const asset = meta.universe[i];
      if (!asset || asset.isDelisted === true) return [];
      const coin =
        dex && !asset.name.includes(":") ? `${dex}:${asset.name}` : asset.name;
      const refPx = ctx.midPx ?? ctx.markPx;
      return [{
        coin,
        volume24hNotional: ctx.dayNtlVlm,
        volume24hBase: ctx.dayBaseVlm,
        price24hChangePct: computePrice24hChangePct(ctx.prevDayPx, refPx),
        prevDayPx: ctx.prevDayPx,
        midPx: refPx,
        markPx: ctx.markPx,
        funding: ctx.funding,
        openInterest: ctx.openInterest,
        premium: ctx.premium ?? "0",
      }];
    });
  });
}

async function fetchSpotContextRows(): Promise<SpotContextRow[]> {
  const [spotMeta, spotCtxs] = await infoClient.spotMetaAndAssetCtxs();
  const tokenNameByIndex = new Map<number, string>();
  for (const token of spotMeta.tokens) tokenNameByIndex.set(token.index, token.name);

  return spotMeta.universe.flatMap((market, i) => {
    if (market.tokens.length < 2) return [];
    const base = tokenNameByIndex.get(market.tokens[0]);
    const quote = tokenNameByIndex.get(market.tokens[1]);
    if (!base || !quote) return [];
    const ctx = spotCtxs[market.index] ?? spotCtxs[i];
    if (!ctx) return [];
    const refPx = ctx.midPx ?? ctx.markPx;
    return [{
      coin: `${base}/${quote}`,
      volume24hNotional: ctx.dayNtlVlm,
      volume24hBase: ctx.dayBaseVlm,
      price24hChangePct: computePrice24hChangePct(ctx.prevDayPx, refPx),
      prevDayPx: ctx.prevDayPx,
      midPx: refPx,
      markPx: ctx.markPx,
    }];
  });
}

async function fetchAllMarketContextRows(): Promise<{
  perps: PerpContextRow[];
  spot: SpotContextRow[];
}> {
  const [perps, spot] = await Promise.all([
    fetchPerpContextRows(),
    fetchSpotContextRows(),
  ]);
  return { perps, spot };
}

async function buildRequestedCoinMatchers(rawCoins: string[]): Promise<{
  raw: Set<string>;
  normalized: Set<string>;
}> {
  const normalized = await Promise.all(
    rawCoins.map(async (coin) => normalizeCoinParam(coin))
  );
  return {
    raw: new Set(rawCoins.map((c) => c.toUpperCase())),
    normalized: new Set(normalized.map((c) => c.toUpperCase())),
  };
}

/**
 * Retrieve trending markets grouped by perps and spot.
 * - perps: from allDexsAssetCtxs WebSocket snapshot + per-dex meta symbol mapping
 * - spot: from spotMetaAndAssetCtxs
*/
async function getTrendingCoins(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const sorting = requireField(
    args?.sorting,
    trendingSortingSchema,
    "sorting",
    "Use sorting: volume or price_change."
  ) ?? "volume";
  const count = 10;

  try {
    const { perps, spot } = await fetchAllMarketContextRows();

    const score = (row: { volume24hNotional: string; price24hChangePct: string }) =>
      sorting === "price_change"
        ? parseDecimal(row.price24hChangePct)
        : parseDecimal(row.volume24hNotional);

    const sortedPerps = [...perps].sort((a, b) => score(b) - score(a)).slice(0, count);
    const sortedSpot = [...spot].sort((a, b) => score(b) - score(a)).slice(0, count);

    return JSON.stringify(
      {
        sorting,
        count,
        perps: {
          count: sortedPerps.length,
          list: sortedPerps,
        },
        spot: {
          count: sortedSpot.length,
          list: sortedSpot,
        },
      },
      null,
      2
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve trending coins: ${errorMessage}`);
  }
}

/**
 * Retrieve asset context rows for a specified list of coins/pairs.
 * Accepts perps (e.g. BTC, dex:BTC) and spot pairs (e.g. HYPE/USDC).
 */
async function getAssetContext(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const coins = requireField(
    args?.coins,
    coinsSchema,
    "coins",
    "Provide coins list (e.g. ['BTC', 'hyna:BTC', 'HYPE/USDC'])."
  );

  try {
    const matcher = await buildRequestedCoinMatchers(coins);
    const { perps, spot } = await fetchAllMarketContextRows();

    const perpsFiltered = perps.filter((row) => {
      const key = row.coin.toUpperCase();
      return matcher.raw.has(key) || matcher.normalized.has(key);
    });

    const spotFiltered = spot.filter((row) => {
      const key = row.coin.toUpperCase();
      return matcher.raw.has(key) || matcher.normalized.has(key);
    });

    return JSON.stringify(
      {
        requestedCoins: coins,
        perps: {
          count: perpsFiltered.length,
          list: perpsFiltered,
        },
        spot: {
          count: spotFiltered.length,
          list: spotFiltered,
        },
      },
      null,
      2
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve asset context: ${errorMessage}`);
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
    return JSON.stringify(formatOpenOrders(user, data), null, 2);
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
async function getTradeHistory(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const user = requireField(args?.user, userSchema, "user", USER_HINT);
  const coinRaw =
    args?.coin === undefined || args?.coin === null
      ? undefined
      : requireField(args?.coin, coinSchema, "coin", COIN_HINT);
  const coin = coinRaw ? await normalizeCoinParam(coinRaw) : undefined;
  const limit =
    requireField(
      args?.limit,
      tradeHistoryLimitSchema,
      "limit",
      "Provide limit between 1 and 50."
    ) ?? 10;
  try {
    const data = await infoClient.userFills({ user, aggregateByTime: true });
    const filtered = coinRaw
      ? data.filter((fill) => {
          const fillCoin = fill.coin.toUpperCase();
          return (
            fillCoin === coinRaw.toUpperCase() ||
            (coin !== undefined && fillCoin === coin.toUpperCase())
          );
        })
      : data;
    const sorted = [...filtered].sort((a, b) => b.time - a.time);
    const limited = sorted.slice(0, limit);
    return JSON.stringify(formatUserFills(user, limited), null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve user fills: ${errorMessage}`);
  }
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
    return JSON.stringify(formatSpotSummary(user, data), null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve spot account summary: ${errorMessage}`);
  }
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
    return JSON.stringify(formatPortfolioOverview(user, data), null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve portfolio overview: ${errorMessage}`);
  }
}

/**
 * Retrieve a compact account overview for agent context:
 * - portfolio snapshot (same structure as get_portfolio_overview)
 * - open positions (concise)
 * - open orders (concise)
 * - spot balances (non-zero only)
 *
 * All API calls are executed in parallel for speed.
 */
export async function getAccountOverview(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const user = requireField(args?.user, userSchema, "user", USER_HINT);
  try {
    const [perpsEvent, openOrdersData, spotState, portfolioData] = await Promise.all([
      getSubscriptionSnapshot<{
        user: string;
        clearinghouseStates: [string, unknown][];
      }>((client, onData) => client.allDexsClearinghouseState({ user }, onData)),
      infoClient.frontendOpenOrders({ user }),
      infoClient.spotClearinghouseState({ user }),
      infoClient.portfolio({ user }),
    ]);

    const perpsSummary = formatPerpsSummary(perpsEvent);
    const portfolio = formatPortfolioOverview(user, portfolioData);
    const openOrders = formatOpenOrders(user, openOrdersData);
    const spotSummary = formatSpotSummary(user, spotState, { nonZeroOnly: true });

    const overview = {
      portfolio,
      perpsSummary,
      spotSummary,
      openOrders,
    };

    return JSON.stringify(overview, null, 2);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve account overview: ${errorMessage}`);
  }
}

/**
 * Get leverage, max trade size, available-to-trade (long/short), and mark price for a user's coin context.
 * Uses the Hyperliquid SDK InfoClient activeAssetData.
 */
async function getActiveAssetData(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const user = requireField(args?.user, userSchema, "user", USER_HINT);
  const rawCoin = requireField(args?.coin, coinSchema, "coin", COIN_HINT);
  const coin = await normalizeCoinParam(rawCoin);
  try {
    const data = await infoClient.activeAssetData({ user, coin });
    const coinKey = rawCoin.toLowerCase().replace("/", "_");
    const transformed = {
      user: data.user,
      coin: rawCoin,
      resolvedCoin: coin,
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

/**
 * Fetch 300 candles and return up to 5 most recent pivot highs (resistance) and pivot lows (support)
 * that have not been cleared. A pivot high is cleared if any later candle's high >= its price;
 * a pivot low is cleared if any later candle's low <= its price.
 */
export async function getPivotHighsAndLows(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const rawCoin = requireField(args?.coin, coinSchema, "coin", COIN_HINT);
  const coin = await normalizeCoinParam(rawCoin);
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
        requestedCoin: rawCoin,
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
 * Retrieve candle snapshot with optional technical indicators (RSI, MACD, ATR, Bollinger Bands, EMA, SMA, VWAP, OBV).
 * Fetches enough candles for indicator warmup, computes selected indicators, returns last N candles with values.
 */
export async function getCandleSnapshotWithIndicators(
  args: Record<string, unknown>,
  _context?: { apiKey?: string; userId?: string }
): Promise<string> {
  const rawCoin = requireField(args?.coin, coinSchema, "coin", COIN_HINT);
  const coin = await normalizeCoinParam(rawCoin);
  const interval = requireField(
    args?.interval,
    candleIntervalSchema,
    "interval",
    INTERVAL_HINT
  );
  const count = requireField(
    args?.count,
    candleCountSchema,
    "count",
    `Use count between 1 and ${MAX_CANDLE_COUNT}.`
  ) ?? DEFAULT_CANDLE_COUNT;
  const indicators = requireField(
    args?.indicators,
    indicatorsSchema,
    "indicators",
    "Use indicators from: rsi, macd, atr, bollingerBands, ema, sma, vwap, obv."
  ) ?? null;

  const rsiPeriod = requireField(
    args?.rsiPeriod,
    rsiPeriodSchema,
    "rsiPeriod",
    "Use rsiPeriod between 2 and 30."
  ) ?? DEFAULT_RSI_PERIOD;
  const rsiSmaLength = requireField(
    args?.rsiSmaLength,
    rsiSmaLengthSchema,
    "rsiSmaLength",
    "Use rsiSmaLength between 2 and 50."
  ) ?? DEFAULT_RSI_SMA_LENGTH;
  const macdFast = requireField(
    args?.macdFastPeriod,
    macdFastPeriodSchema,
    "macdFastPeriod",
    "Use macdFastPeriod between 2 and 20."
  ) ?? DEFAULT_MACD_FAST;
  const macdSlow = requireField(
    args?.macdSlowPeriod,
    macdSlowPeriodSchema,
    "macdSlowPeriod",
    "Use macdSlowPeriod between 5 and 50."
  ) ?? DEFAULT_MACD_SLOW;
  const macdSignal = requireField(
    args?.macdSignalPeriod,
    macdSignalPeriodSchema,
    "macdSignalPeriod",
    "Use macdSignalPeriod between 2 and 20."
  ) ?? DEFAULT_MACD_SIGNAL;
  const atrPeriod = requireField(
    args?.atrPeriod,
    atrPeriodSchema,
    "atrPeriod",
    "Use atrPeriod between 2 and 30."
  ) ?? DEFAULT_ATR_PERIOD;
  const bbPeriod = requireField(
    args?.bbPeriod,
    bbPeriodSchema,
    "bbPeriod",
    "Use bbPeriod between 2 and 50."
  ) ?? DEFAULT_BB_PERIOD;
  const bbStdDev = requireField(
    args?.bbStdDev,
    bbStdDevSchema,
    "bbStdDev",
    "Use bbStdDev between 1 and 3."
  ) ?? DEFAULT_BB_STDDEV;
  const emaPeriod = requireField(
    args?.emaPeriod,
    emaPeriodSchema,
    "emaPeriod",
    "Use emaPeriod between 2 and 200."
  ) ?? DEFAULT_EMA_PERIOD;
  const smaPeriod = requireField(
    args?.smaPeriod,
    smaPeriodSchema,
    "smaPeriod",
    "Use smaPeriod between 2 and 200."
  ) ?? DEFAULT_SMA_PERIOD;

  const lookback = getRequiredIndicatorLookback(indicators ?? null, {
    rsiPeriod,
    rsiSmaLength,
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
      obv?: (number | undefined)[];
      obvSma?: (number | undefined)[];
    };
    const results: IndicatorResults = {};

    if (indicators?.includes("rsi")) {
      const rsiResult = RSI.calculate({ values: close, period: rsiPeriod });
      results.rsi = rsiResult.map((v) => (Number.isFinite(v) ? v : undefined));
      // SMA of RSI via library (for rsiSma value and RSI vs RSI-SMA crossover)
      const from = rsiPeriod; // RSI has values from this index onward
      const rsiSlice = results.rsi!.slice(from) as number[];
      const smaResult =
        rsiSlice.length >= rsiSmaLength
          ? SMA.calculate({ period: rsiSmaLength, values: rsiSlice })
          : [];
      const pad = from + rsiSmaLength - 1;
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
    if (indicators?.includes("obv")) {
      const obvResult = OBV.calculate({ close, volume });
      results.obv = obvResult.map((v) => (Number.isFinite(v) ? v : undefined));
      const obvSlice = results.obv as number[];
      const obvSmaResult =
        obvSlice.length >= OBV_SMA_LENGTH
          ? SMA.calculate({ period: OBV_SMA_LENGTH, values: obvSlice })
          : [];
      const pad = OBV_SMA_LENGTH - 1;
      results.obvSma = [
        ...Array.from<undefined>({ length: pad }).fill(undefined),
        ...obvSmaResult,
      ];
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
      if (results.obv?.length) {
        const ri = idx(results.obv, globalIndex);
        const val = ri >= 0 ? results.obv[ri] : undefined;
        const obvSmaVal = results.obvSma && ri >= 0 ? results.obvSma[ri] : undefined;
        const prevRi = idx(results.obv, globalIndex - 1);
        const prevVal = prevRi >= 0 ? results.obv[prevRi] : undefined;
        const prevObvSmaRi = results.obvSma ? idx(results.obvSma, globalIndex - 1) : -1;
        const prevObvSmaVal = prevObvSmaRi >= 0 ? results.obvSma![prevObvSmaRi] : undefined;
        if (val != null && Number.isFinite(val)) {
          let obvCrossover: "bullish" | "bearish" | null = null;
          if (
            prevVal != null && Number.isFinite(prevVal) &&
            prevObvSmaVal != null && Number.isFinite(prevObvSmaVal) &&
            obvSmaVal != null && Number.isFinite(obvSmaVal)
          ) {
            if (prevVal < prevObvSmaVal && val > obvSmaVal) obvCrossover = "bullish";
            else if (prevVal > prevObvSmaVal && val < obvSmaVal) obvCrossover = "bearish";
          }
          const trend: "bullish" | "bearish" | "neutral" =
            obvSmaVal != null && Number.isFinite(obvSmaVal)
              ? val > obvSmaVal
                ? "bullish"
                : val < obvSmaVal
                  ? "bearish"
                  : "neutral"
              : "neutral";
          ind.obv = {
            value: val,
            obvSma: obvSmaVal != null && Number.isFinite(obvSmaVal) ? obvSmaVal : null,
            trend,
            crossover: obvCrossover ?? null,
          };
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
          requestedCoin: rawCoin,
          interval,
          dataRange: {
            from: firstCandle?.timestampIso ?? null,
            to: lastCandle?.timestampIso ?? null,
            candleCount: candles.length,
          },
          indicators: {
            ...(indicators.includes("rsi") && { rsi: { period: rsiPeriod, rsiSmaLength } }),
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
            ...(indicators.includes("obv") && { obv: { obvSmaLength: OBV_SMA_LENGTH } }),
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


// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------
export const hyperliquidApiTools: SdkToolDefinition[] = [
  {
    name: "get_open_orders",
    title: "Get Open Orders",
    description: "Retrieve a user's open orders.",
    inputSchema: { user: userSchema },
    handler: async (args, _extra) => toContent(await getOpenOrders(args, getRequestContext())),
  },
  {
    name: "get_trade_history",
    title: "Get Trade History",
    description: "Retrieve a user's most recent trade history, with optional coin filter and result limit.",
    inputSchema: {
      user: userSchema,
      coin: coinSchema.optional(),
      limit: tradeHistoryLimitSchema,
    },
    handler: async (args, _extra) => toContent(await getTradeHistory(args, getRequestContext())),
  },
  {
    name: "get_perps_account_summary",
    title: "Get Perps Account Summary",
    description: "Retrieve a user's perpetuals account positions.",
    inputSchema: { user: userSchema },
    handler: async (args, _extra) =>
      toContent(await getPerpsAccountSummary(args, getRequestContext())),
  },
  {
    name: "get_spot_account_summary",
    title: "Get Spot Account Summary",
    description: "Retrieve a user's spot account balances.",
    inputSchema: { user: userSchema },
    handler: async (args, _extra) =>
      toContent(await getSpotAccountSummary(args, getRequestContext())),
  },
  {
    name: "get_portfolio_overview",
    title: "Get Portfolio Overview",
    description: "Retrieve a user's portfolio overview (total, perp, spot): current value, PnL, and ROE for day/week/month/all.",
    inputSchema: { user: userSchema },
    handler: async (args, _extra) =>
      toContent(await getPortfolioOverview(args, getRequestContext())),
  },
  {
    name: "get_account_overview",
    title: "Get Account Overview",
    description: "Retrieve a user's full account overview: portfolio overview, perps account summary, spot account summary, and open orders.",
    inputSchema: { user: userSchema },
    handler: async (args, _extra) =>
      toContent(await getAccountOverview(args, getRequestContext())),
  },
  {
    name: "get_active_asset_data",
    title: "Get Active Asset Data",
    description: "Retrieve a user's current leverage, max trade size, available-to-trade, and mark price for a coin.",
    inputSchema: {
      user: userSchema,
      coin: coinSchema,
    },
    handler: async (args, _extra) =>
      toContent(await getActiveAssetData(args, getRequestContext())),
  },
  {
    name: "get_coin_price",
    title: "Get Coin Price(s)",
    description: "Retrieve market prices for one or more coins.",
    inputSchema: {
      coins: coinsSchema,
    },
    handler: async (args, _extra) => toContent(await getCoinPrice(args, getRequestContext())),
  },
  {
    name: "get_orderbook",
    title: "Get Orderbook",
    description: "Retrieve orderbook snapshot (bids/asks) for a coin.",
    inputSchema: {
      coin: coinSchema,
      nSigFigs: orderbookSigFigsSchema,
      depth: orderbookDepthSchema,
    },
    handler: async (args, _extra) =>
      toContent(await getOrderbook(args, getRequestContext())),
  },
  {
    name: "search_markets",
    title: "Search Markets",
    description: "Search available markets by query across perps and spot pairs.",
    inputSchema: {
      query: marketQuerySchema,
    },
    handler: async (args, _extra) =>
      toContent(await searchMarkets(args, getRequestContext())),
  },
  {
    name: "get_trending_coins",
    title: "Get Trending Coins",
    description: "Retrieve top 10 trending perps and spot markets by volume or price_change.",
    inputSchema: {
      sorting: trendingSortingSchema,
    },
    handler: async (args, _extra) =>
      toContent(await getTrendingCoins(args, getRequestContext())),
  },
  {
    name: "get_asset_context",
    title: "Get Asset Context",
    description: "Retrieve market context for specified coins: includes 24h notional/base volume, 24h price change %, and other market context fields.",
    inputSchema: {
      coins: coinsSchema,
    },
    handler: async (args, _extra) =>
      toContent(await getAssetContext(args, getRequestContext())),
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
    name: "get_market_data",
    title: "Get Market Data",
    description: "Retrieve last N candles (OHLCV) for a coin and interval, with optional indicators: RSI, MACD, ATR, Bollinger Bands, EMA, SMA, VWAP, OBV.",
    inputSchema: {
      coin: coinSchema,
      interval: candleIntervalSchema,
      count: candleCountSchema.describe(
        `Optional number of candles to return (1 to ${MAX_CANDLE_COUNT}, default: ${DEFAULT_CANDLE_COUNT}).`
      ),
      indicators: indicatorsSchema,
      rsiPeriod: rsiPeriodSchema,
      rsiSmaLength: rsiSmaLengthSchema,
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
];
