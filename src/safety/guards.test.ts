import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGuards, type PortfolioContext } from "./guards.js";
import type { Config } from "../config.js";
import type { TradeProposal } from "../strategy/types.js";

const cfg = {
  MAX_ORDER_RUB: 1000,
  MAX_DAILY_TURNOVER_RUB: 5000,
  MAX_POSITION_SHARE: 0.4,
  MAX_DRAWDOWN_PCT: 10,
  EQUITY_FLOOR_RUB: 0,
  MAX_TOTAL_EXPOSURE_PCT: 0.6,
  MAX_OPEN_POSITIONS: 2,
  COMMISSION_PCT: 0.04,
  SLIPPAGE_PCT: 0.1,
  MIN_NET_EDGE_RATIO: 1.5,
} as unknown as Config;

const ctx: PortfolioContext = {
  totalValueRub: 5000,
  currentPositionRub: 0,
  todayTurnoverRub: 0,
  investedRub: 0,
  openPositions: 0,
  drawdownPct: 0,
};

const buy = (o: Partial<TradeProposal> = {}): TradeProposal =>
  ({
    instrument: "X",
    side: "buy",
    orderType: "limit",
    lots: 1,
    price: 100,
    lotSize: 1,
    targetPct: 4,
    rationale: "t",
    createdAt: "",
    ...o,
  }) as TradeProposal;

test("нормальная покупка проходит", () => {
  assert.equal(checkGuards(buy(), ctx, cfg).ok, true);
});

test("карри минует все спекулятивные лимиты", () => {
  const v = checkGuards(buy({ kind: "carry", price: 100, lots: 100 /* 10000 ₽ */ }), ctx, cfg);
  assert.equal(v.ok, true);
});

test("превышение MAX_ORDER_RUB блокирует", () => {
  const v = checkGuards(buy({ lots: 20 /* 2000 ₽ */ }), ctx, cfg);
  assert.equal(v.ok, false);
  assert.match(v.violations.join(" "), /MAX_ORDER_RUB/);
});

test("kill-switch по просадке блокирует покупку", () => {
  const v = checkGuards(buy(), { ...ctx, drawdownPct: 12 }, cfg);
  assert.equal(v.ok, false);
  assert.match(v.violations.join(" "), /Просадк/);
});

test("лимит экспозиции блокирует покупку", () => {
  const v = checkGuards(buy(), { ...ctx, investedRub: 3500 /* +100 = 72% > 60% */ }, cfg);
  assert.equal(v.ok, false);
  assert.match(v.violations.join(" "), /кспозици/);
});

test("гейт прибыльности: низкая цель блокирует", () => {
  // round-trip = 2*0.04+0.1 = 0.18; required = 0.18*1.5 = 0.27
  const v = checkGuards(buy({ targetPct: 0.1 }), ctx, cfg);
  assert.equal(v.ok, false);
  assert.match(v.violations.join(" "), /купаемость/);
});

test("нет цели → предупреждение, не блок", () => {
  const v = checkGuards(buy({ targetPct: undefined }), ctx, cfg);
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => /окупаемость/i.test(w)));
});

test("продажа минует долевые/капитал-лимиты (даже при просадке)", () => {
  const v = checkGuards(buy({ side: "sell", targetPct: undefined }), { ...ctx, drawdownPct: 20 }, cfg);
  assert.equal(v.ok, true);
});
