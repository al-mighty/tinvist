import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoney, fromUnitsNano, fromValueString } from "./domain.js";
import { estimatedNotional } from "./strategy/types.js";
import type { TradeProposal } from "./strategy/types.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

test("fromUnitsNano собирает units+nano", () => {
  assert.equal(r2(fromUnitsNano({ units: "97", nano: 60000000 })), 97.06);
  assert.equal(r2(fromUnitsNano({ units: 20, nano: 160000000 })), 20.16);
  assert.equal(fromUnitsNano({ units: 0, nano: 0 }), 0);
});

test("fromValueString парсит decimal-строку", () => {
  assert.equal(fromValueString({ value: "97.06" }), 97.06);
  assert.equal(fromValueString({ value: "2.0306" }), 2.0306);
});

test("parseMoney понимает оба формата и мусор", () => {
  assert.equal(parseMoney({ units: "5", nano: 500000000 }), 5.5);
  assert.equal(parseMoney({ value: "12.34" }), 12.34);
  assert.equal(parseMoney(null), 0);
  assert.equal(parseMoney(undefined), 0);
});

test("estimatedNotional = price × lots × lotSize", () => {
  const p = { price: 100, lots: 3, lotSize: 10 } as TradeProposal;
  assert.equal(estimatedNotional(p), 3000);
  const p2 = { price: 20.16, lots: 1 } as TradeProposal; // lotSize по умолчанию 1
  assert.equal(Math.round(estimatedNotional(p2) * 100) / 100, 20.16);
});
