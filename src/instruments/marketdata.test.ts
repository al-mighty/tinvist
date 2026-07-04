import { test } from "node:test";
import assert from "node:assert/strict";
import { limitPriceFromBook, type OrderbookSnapshot } from "./marketdata.js";

const book = (bids: number[], asks: number[]): OrderbookSnapshot => ({
  bids: bids.map((price) => ({ price, quantity: 1 })) as any,
  asks: asks.map((price) => ({ price, quantity: 1 })) as any,
  bestBid: bids[0]!,
  bestAsk: asks[0]!,
  mid: (bids[0]! + asks[0]!) / 2,
  spreadPct: 0,
});

test("buy: берём самый высокий ask в пределах кэпа", () => {
  // bestAsk 100, кэп 0.3% → 100.3; уровни 100, 100.2, 101 → 100.2
  const px = limitPriceFromBook("buy", book([99.9], [100, 100.2, 101]), 0.3);
  assert.equal(px, 100.2);
});

test("buy: если все выше кэпа — остаётся bestAsk", () => {
  const px = limitPriceFromBook("buy", book([99], [100, 101, 102]), 0.3);
  assert.equal(px, 100);
});

test("sell: берём самый низкий bid в пределах кэпа", () => {
  // bestBid 100, кэп 0.3% → 99.7; уровни 100, 99.8, 99 → 99.8
  const px = limitPriceFromBook("sell", book([100, 99.8, 99], [100.1]), 0.3);
  assert.equal(px, 99.8);
});
