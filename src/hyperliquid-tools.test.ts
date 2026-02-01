import { describe, it } from "node:test";
import assert from "node:assert";
import { getPerpsAccountSummary } from "./hyperliquid-tools.js";

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
