import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRSI } from "./rsi.js";

test("монотонный рост → RSI 100", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  assert.equal(computeRSI(closes, 14), 100);
});

test("монотонное падение → RSI 0", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
  assert.equal(computeRSI(closes, 14), 0);
});

test("мало данных → null", () => {
  assert.equal(computeRSI([1, 2, 3, 4, 5], 14), null);
});

test("смешанный ряд → RSI в (0,100)", () => {
  const closes = [44, 44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  const rsi = computeRSI(closes, 14);
  assert.ok(rsi != null && rsi > 50 && rsi < 100, `rsi=${rsi}`);
});
