import { describe, it } from "node:test";
import assert from "node:assert";
import {
  getPerpsAccountSummary,
  getCandleSnapshotWithIndicators,
  getPivotHighsAndLows,
  getPortfolioOverview,
} from "./hyperliquid-tools.js";

const TEST_USER = "0x8f7a6e7ebedc853ec55ef87866428c5708aecce7";

describe("getPerpsAccountSummary", () => {
  it("returns same response as tool would to an agent", async () => {
    const result = await getPerpsAccountSummary({ user: TEST_USER });
    assert.strictEqual(typeof result, "string");
    assert(result.length > 0);
    // Same response the agent receives
    console.log(result);
  });
});

describe("getPivotHighsAndLows", () => {
  it("returns pivot highs and lows for HYPE 30m", async () => {
    const result = await getPivotHighsAndLows({
      coin: "HYPE",
      interval: "30m",
    });
    assert.strictEqual(typeof result, "string");
    assert(result.length > 0);
    const parsed = JSON.parse(result);
    assert.ok(Array.isArray(parsed.pivotHighs));
    assert.ok(Array.isArray(parsed.pivotLows));
    assert.strictEqual(parsed.coin, "HYPE");
    assert.strictEqual(parsed.interval, "30m");
    assert(typeof parsed.currentClose === "number");
    assert(parsed.candlesAnalyzed > 0);
    if (parsed.pivotHighs.length > 0) {
      const p = parsed.pivotHighs[0];
      assert("timestamp" in p && "timestampIso" in p && "barsAgo" in p && "price" in p && "pctFromCurrentClose" in p);
    }
    if (parsed.pivotLows.length > 0) {
      const p = parsed.pivotLows[0];
      assert("timestamp" in p && "timestampIso" in p && "barsAgo" in p && "price" in p && "pctFromCurrentClose" in p);
    }
    console.log(result);
  });
});

describe("get_market_data (getCandleSnapshotWithIndicators)", () => {
  it("returns same response as tool would to an agent", async () => {
    const result = await getCandleSnapshotWithIndicators({
      coin: "HYPE",
      interval: "30m",
      count: 15,
      indicators: ["macd"],
    });
    assert.strictEqual(typeof result, "string");
    assert(result.length > 0);
    console.log(result);
  });
});

describe("getPortfolioOverview", () => {
  it("returns same response as tool would to an agent", async () => {
    const result = await getPortfolioOverview({ user: TEST_USER });
    assert.strictEqual(typeof result, "string");
    assert(result.length > 0);
    console.log(result);
  });
});
