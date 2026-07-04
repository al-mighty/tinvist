import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { EquityHistory } from "./equity-history.js";
import { computePerformance } from "./performance.js";
import type { Config } from "../config.js";
import type { EquityPoint } from "./equity-history.js";

const cfg = { BENCHMARK_UID: "u", BENCHMARK_TICKER: "EQMX" } as unknown as Config;
// Стаб рыночных данных: бенчмарк +1% за окно.
const market = { dailyOHLC: async () => ({ closes: [100, 101] }) } as any;

test("computePerformance: доходность, бенчмарк и альфа", async () => {
  const history: EquityPoint[] = [
    { accountId: "a", date: "2026-06-01", equity: 5000 },
    { accountId: "a", date: "2026-06-11", equity: 5100 },
  ];
  const perf = await computePerformance(cfg, history, market);
  assert.ok(perf);
  assert.equal(Math.round(perf!.accountReturnPct * 100) / 100, 2); // +2%
  assert.equal(Math.round(perf!.benchmarkReturnPct * 100) / 100, 1); // +1%
  assert.equal(Math.round(perf!.alphaPct * 100) / 100, 1); // альфа +1%
  assert.equal(perf!.days, 10);
});

test("computePerformance: <2 точек → null", async () => {
  const perf = await computePerformance(cfg, [{ accountId: "a", date: "2026-06-01", equity: 5000 }], market);
  assert.equal(perf, null);
});

test("EquityHistory: дедуп по дате, накопление по дням", async () => {
  const path = join(tmpdir(), `eq-hist-test-${process.pid}.jsonl`);
  await rm(path, { force: true });
  const h = new EquityHistory(path);
  const day1 = Date.parse("2026-06-01T12:00:00Z");
  const day2 = Date.parse("2026-06-02T12:00:00Z");
  await h.snapshot("a", 5000, day1);
  await h.snapshot("a", 5090, day1); // тот же день → не добавится
  assert.equal((await h.load("a")).length, 1);
  await h.snapshot("a", 5100, day2); // новый день → добавится
  const pts = await h.load("a");
  assert.equal(pts.length, 2);
  assert.equal(pts[1]!.equity, 5100);
  await rm(path, { force: true });
});
