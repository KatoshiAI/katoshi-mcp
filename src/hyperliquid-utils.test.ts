import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coerceArrayInput, coerceNumberInput } from "./tool-common.js";
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

describe("coerceArrayInput", () => {
  it("keeps arrays and nullish values as-is", () => {
    assert.deepEqual(coerceArrayInput([1, 2]), [1, 2]);
    assert.equal(coerceArrayInput(null), null);
    assert.equal(coerceArrayInput(undefined), undefined);
  });

  it("coerces JSON-stringified arrays", () => {
    assert.deepEqual(coerceArrayInput("[1,2,3]"), [1, 2, 3]);
    assert.deepEqual(coerceArrayInput('["BTC","ETH"]'), ["BTC", "ETH"]);
  });

  it("coerces comma-separated and single strings", () => {
    assert.deepEqual(coerceArrayInput("BTC, ETH"), ["BTC", "ETH"]);
    assert.deepEqual(coerceArrayInput("HYPE"), ["HYPE"]);
  });

  it("works with zod preprocess for int arrays", () => {
    const schema = z.preprocess(
      coerceArrayInput,
      z.array(z.preprocess(coerceNumberInput, z.number().int())).min(1)
    );
    assert.deepEqual(schema.parse("[326437847986]"), [326437847986]);
    assert.deepEqual(schema.parse("326437847986"), [326437847986]);
    assert.throws(() => schema.parse("abc"));
  });
});
