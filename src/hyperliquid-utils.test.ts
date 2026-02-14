import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coerceNumberInput } from "./tool-common.js";
import { z } from "zod";

describe("coerceNumberInput", () => {
  it("keeps finite numbers", () => {
    assert.equal(coerceNumberInput(12), 12);
    assert.equal(coerceNumberInput(0.25), 0.25);
  });

  it("coerces numeric strings", () => {
    assert.equal(coerceNumberInput("10"), 10);
    assert.equal(coerceNumberInput(" 2.5 "), 2.5);
  });

  it("does not coerce invalid values", () => {
    assert.equal(coerceNumberInput(""), "");
    assert.equal(coerceNumberInput("abc"), "abc");
    assert.equal(coerceNumberInput(null), null);
    assert.equal(coerceNumberInput(undefined), undefined);
  });

  it("works with zod preprocess for number-like input", () => {
    const schema = z.preprocess(coerceNumberInput, z.number().int().min(1).max(50));
    assert.equal(schema.parse("10"), 10);
    assert.equal(schema.parse(7), 7);
    assert.throws(() => schema.parse("abc"));
  });
});
