import { SubscriptionClient, WebSocketTransport } from "@nktkas/hyperliquid";
import type {
  CandleSnapshotResponse,
  FrontendOpenOrdersResponse,
  PortfolioResponse,
  SpotClearinghouseStateResponse,
  UserFillsResponse,
} from "@nktkas/hyperliquid";
import { z } from "zod";

const DEFAULT_WS_TIMEOUT_MS = 3_000;
const DEFAULT_WS_TIMEOUT_MESSAGE = "WebSocket subscription timeout";
const DEFAULT_INDICATOR_LOOKBACK = 50;
const RSI_SMA_LENGTH = 14;

/**
 * Validate a single field with a Zod schema and throw a normalized error.
 */
export function requireField<T>(
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
export function parseDecimal(s: string | undefined): number {
  if (s === undefined || s === "") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Format number to string with up to 6 decimal places, no trailing zeros. */
export function formatDecimal(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number(n.toFixed(6)) === n ? String(n) : n.toFixed(6);
}

/** Classify single-candle shape from OHLC values. */
export function getCandleType(
  open: number,
  high: number,
  low: number,
  close: number
): string {
  const range = high - low;
  if (range <= 0 || !Number.isFinite(range)) return "doji";
  const body = Math.abs(close - open);
  const bodyRatio = body / range;
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const minBody = range * 0.02;

  if (bodyRatio < 0.1) return "doji";
  if (
    lowerWick >= 2 * body &&
    upperWick <= Math.max(minBody, body * 0.5)
  )
    return "hammer";
  if (
    upperWick >= 2 * body &&
    lowerWick <= Math.max(minBody, body * 0.5)
  )
    return "inverted_hammer";
  return close >= open ? "bullish" : "bearish";
}

interface SubscriptionHandle {
  unsubscribe(): Promise<void>;
}

/**
 * Subscribe, wait for first event, then unsubscribe and close transport.
 */
export async function getSubscriptionSnapshot<T>(
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
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error(DEFAULT_WS_TIMEOUT_MESSAGE));
    }, DEFAULT_WS_TIMEOUT_MS);
  });

  let subscription: SubscriptionHandle | null = null;
  try {
    await Promise.race([wsTransport.ready(), timeoutPromise]);
    subscription = await Promise.race([
      subscribe(subClient, (data) => {
        if (!timedOut) resolveFirst(data);
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

export function formatPerpsSummary(event: {
  user: string;
  clearinghouseStates: [string, unknown][];
}): {
  user: string;
  positions: {
    count: number;
    totals: {
      positionValue: string;
      unrealizedPnl: string;
      returnOnEquity: string;
      marginUsed: string;
      fundingSinceOpen: string;
    };
    list: Array<{ dex: string } & Record<string, unknown>>;
  };
} {
  const positions: Array<{ dex: string } & Record<string, unknown>> = [];
  let totalPositionValue = 0;
  let totalUnrealizedPnl = 0;
  let totalMarginUsed = 0;
  let totalFundingSinceOpen = 0;

  for (const [dex, state] of event.clearinghouseStates) {
    const raw = state as {
      assetPositions?: Array<{ position?: Record<string, unknown> }>;
    };
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

  const totalReturnOnEquity =
    totalMarginUsed !== 0
      ? (totalUnrealizedPnl + totalFundingSinceOpen) / totalMarginUsed
      : 0;

  return {
    user: event.user,
    positions: {
      count: positions.length,
      totals: {
        positionValue: formatDecimal(totalPositionValue),
        unrealizedPnl: formatDecimal(totalUnrealizedPnl),
        returnOnEquity: formatDecimal(totalReturnOnEquity),
        marginUsed: formatDecimal(totalMarginUsed),
        fundingSinceOpen: formatDecimal(totalFundingSinceOpen),
      },
      list: positions,
    },
  };
}

export type PortfolioPeriod = PortfolioResponse[number][1];

type PeriodMetrics = { pnl: number; roe: number; startValue: number };

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

export type AccountOverview = {
  accountValue: string;
  pnl: { current: string; day: string; week: string; month: string; all: string };
  roe: { day: string; week: string; month: string; all: string };
};

export function buildAccountOverview(
  byPeriod: Record<string, PortfolioPeriod>
): AccountOverview {
  const all = byPeriod.allTime;
  const day = byPeriod.day
    ? periodMetrics(byPeriod.day)
    : { pnl: 0, roe: 0, startValue: 0 };
  const week = byPeriod.week
    ? periodMetrics(byPeriod.week)
    : { pnl: 0, roe: 0, startValue: 0 };
  const month = byPeriod.month
    ? periodMetrics(byPeriod.month)
    : { pnl: 0, roe: 0, startValue: 0 };
  const allM = all
    ? periodMetrics(all)
    : { pnl: 0, roe: 0, startValue: 0 };

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

export function buildSpotOverview(
  totalByPeriod: Record<string, PortfolioPeriod>,
  perpByPeriod: Record<string, PortfolioPeriod>
): AccountOverview {
  const totalAll = totalByPeriod.allTime;
  const perpAll = perpByPeriod.perpAllTime;
  const currentAccountValue =
    (totalAll?.accountValueHistory?.length
      ? parseDecimal(totalAll.accountValueHistory[totalAll.accountValueHistory.length - 1][1])
      : 0) -
    (perpAll?.accountValueHistory?.length
      ? parseDecimal(perpAll.accountValueHistory[perpAll.accountValueHistory.length - 1][1])
      : 0);
  const currentPnl =
    (totalAll?.pnlHistory?.length
      ? parseDecimal(totalAll.pnlHistory[totalAll.pnlHistory.length - 1][1])
      : 0) -
    (perpAll?.pnlHistory?.length
      ? parseDecimal(perpAll.pnlHistory[perpAll.pnlHistory.length - 1][1])
      : 0);

  const keys: Array<{
    total: keyof typeof totalByPeriod;
    perp: keyof typeof perpByPeriod;
  }> = [
    { total: "day", perp: "perpDay" },
    { total: "week", perp: "perpWeek" },
    { total: "month", perp: "perpMonth" },
    { total: "allTime", perp: "perpAllTime" },
  ];
  const pnl: AccountOverview["pnl"] = {
    current: formatDecimal(currentPnl),
    day: "0",
    week: "0",
    month: "0",
    all: "0",
  };
  const roe: AccountOverview["roe"] = {
    day: "0",
    week: "0",
    month: "0",
    all: "0",
  };
  for (const { total, perp } of keys) {
    const t = totalByPeriod[total]
      ? periodMetrics(totalByPeriod[total])
      : { pnl: 0, roe: 0, startValue: 0 };
    const p = perpByPeriod[perp]
      ? periodMetrics(perpByPeriod[perp])
      : { pnl: 0, roe: 0, startValue: 0 };
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

export type PortfolioOverview = {
  user: string;
  total: AccountOverview;
  perp: AccountOverview;
  spot: AccountOverview;
};

export function formatPortfolioOverview(
  user: string,
  data: PortfolioResponse
): PortfolioOverview {
  const byPeriod = Object.fromEntries(data) as Record<string, PortfolioPeriod>;
  const total = buildAccountOverview(byPeriod);
  const perp = buildAccountOverview({
    day: byPeriod.perpDay,
    week: byPeriod.perpWeek,
    month: byPeriod.perpMonth,
    allTime: byPeriod.perpAllTime,
  });
  const spot = buildSpotOverview(byPeriod, byPeriod);
  return { user, total, perp, spot };
}

export function formatSpotSummary(
  user: string,
  data: SpotClearinghouseStateResponse,
  options?: { nonZeroOnly?: boolean }
): {
  user: string;
  count: number;
  list: Array<{ coin: string; total: string; inOrders: string }>;
} {
  const balances = data.balances.map((b) => ({
    coin: b.coin,
    total: b.total,
    inOrders: b.hold,
  }));
  const list = options?.nonZeroOnly
    ? balances.filter(
        (b) => parseDecimal(b.total) !== 0 || parseDecimal(b.inOrders) !== 0
      )
    : balances;
  return { user, count: list.length, list };
}

export function formatOpenOrders(
  user: string,
  data: FrontendOpenOrdersResponse
): {
  user: string;
  count: number;
  list: Array<
    Pick<
      FrontendOpenOrdersResponse[number],
      "oid" | "coin" | "orderType" | "reduceOnly" | "timestamp"
    > & {
      side: "buy" | "sell";
      size: string;
      price: string;
    }
  >;
} {
  const list = data.map((order) => ({
    oid: order.oid,
    coin: order.coin,
    side: (order.side === "B" ? "buy" : "sell") as "buy" | "sell",
    size: order.sz,
    price: order.isTrigger ? order.triggerPx : order.limitPx,
    orderType: order.orderType,
    reduceOnly: order.reduceOnly,
    timestamp: order.timestamp,
  }));
  return { user, count: list.length, list };
}

export function formatUserFills(
  user: string,
  data: UserFillsResponse
): {
  user: string;
  count: number;
  list: Array<
    Pick<UserFillsResponse[number], "coin" | "px" | "sz" | "time" | "startPosition" | "dir" | "closedPnl" | "hash" | "oid" | "crossed" | "fee" | "feeToken" | "tid" | "twapId" | "cloid" | "liquidation"> & {
      side: "buy" | "sell";
    }
  >;
} {
  const list = data.map((fill) => ({
    coin: fill.coin,
    px: fill.px,
    sz: fill.sz,
    side: (fill.side === "B" ? "buy" : "sell") as "buy" | "sell",
    time: fill.time,
    startPosition: fill.startPosition,
    dir: fill.dir,
    closedPnl: fill.closedPnl,
    hash: fill.hash,
    oid: fill.oid,
    crossed: fill.crossed,
    fee: fill.fee,
    feeToken: fill.feeToken,
    tid: fill.tid,
    twapId: fill.twapId,
    ...(fill.cloid !== undefined && { cloid: fill.cloid }),
    ...(fill.liquidation !== undefined && { liquidation: fill.liquidation }),
  }));
  return { user, count: list.length, list };
}

export type CandleRow = CandleSnapshotResponse[number];

export function getRequiredIndicatorLookback(
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
  if (indicators.includes("rsi"))
    lookback = Math.max(
      lookback,
      periods.rsiPeriod + RSI_SMA_LENGTH + (RSI_SMA_LENGTH - 1)
    );
  if (indicators.includes("macd"))
    lookback = Math.max(lookback, periods.macdSlow + periods.macdSignal);
  if (indicators.includes("atr"))
    lookback = Math.max(lookback, periods.atrPeriod);
  if (indicators.includes("bollingerBands"))
    lookback = Math.max(lookback, periods.bbPeriod);
  if (indicators.includes("ema"))
    lookback = Math.max(lookback, periods.emaPeriod);
  if (indicators.includes("sma"))
    lookback = Math.max(lookback, periods.smaPeriod);
  if (indicators.includes("vwap")) lookback = Math.max(lookback, 1);
  return lookback || DEFAULT_INDICATOR_LOOKBACK;
}

export type PivotPoint = {
  timestamp: number;
  timestampIso: string;
  barsAgo: number;
  price: number;
  pctFromCurrentClose: number;
};

export function computePivots(
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
    const pctFromClose =
      currentClose !== 0
        ? Math.round(((hi - currentClose) / currentClose) * 10000) / 100
        : 0;
    const pctFromCloseLow =
      currentClose !== 0
        ? Math.round(((li - currentClose) / currentClose) * 10000) / 100
        : 0;

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
