import { describe, it } from "node:test";
import {
  getAccountOverview,
  getPerpsAccountSummary,
  getCandleSnapshotWithIndicators,
  getPivotHighsAndLows,
  getPortfolioOverview,
} from "./hyperliquid-tools.js";

const TEST_USER = "0x8f7a6e7ebedc853ec55ef87866428c5708aecce7";

describe("getPerpsAccountSummary", () => {
  it("returns same response as tool would to an agent", async () => {
    const result = await getPerpsAccountSummary({ user: TEST_USER });
    console.log(result);
  });
});

describe("getPivotHighsAndLows", () => {
  it("returns pivot highs and lows for HYPE 30m", async () => {
    const result = await getPivotHighsAndLows({
      coin: "HYPE",
      interval: "30m",
    });
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
    console.log(result);
  });
});

describe("getPortfolioOverview", () => {
  it("returns same response as tool would to an agent", async () => {
    const result = await getPortfolioOverview({ user: TEST_USER });
    console.log(result);
  });
});

describe("getAccountOverview", () => {
  it("returns compact account overview for an agent", async () => {
    const result = await getAccountOverview({ user: TEST_USER });
    console.log(result);
  });
});
