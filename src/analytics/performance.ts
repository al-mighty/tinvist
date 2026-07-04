import type { Config } from "../config.js";
import type { MarketData } from "../instruments/marketdata.js";
import type { EquityPoint } from "./equity-history.js";

export interface Performance {
  points: number; // число снапшотов капитала
  days: number; // календарных дней в окне
  accountReturnPct: number;
  benchmarkReturnPct: number;
  alphaPct: number; // счёт − бенчмарк
  maxDrawdownPct: number;
  sharpe: number | null; // годовой; null — если мало точек
  benchmarkTicker: string;
}

/**
 * Доходность счёта против бенчмарка (индекс Мосбиржи через EQMX). Считается по
 * дневным снапшотам капитала. Допущение: без внешних вводов/выводов средств
 * внутри окна (депозит один в начале) — иначе доходность искажается.
 */
export async function computePerformance(
  cfg: Config,
  history: EquityPoint[],
  market: MarketData,
): Promise<Performance | null> {
  if (history.length < 2) return null;
  const first = history[0]!;
  const last = history[history.length - 1]!;

  const accountReturnPct = (last.equity / first.equity - 1) * 100;
  const days = Math.max(1, Math.round((Date.parse(last.date) - Date.parse(first.date)) / 86_400_000));

  // Бенчмарк за сопоставимое окно.
  let benchmarkReturnPct = 0;
  const ohlc = await market.dailyOHLC(cfg.BENCHMARK_UID, days + 5).catch(() => null);
  if (ohlc && ohlc.closes.length >= 2) {
    const c = ohlc.closes;
    benchmarkReturnPct = (c[c.length - 1]! / c[0]! - 1) * 100;
  }

  // Максимальная просадка по кривой капитала.
  let peak = history[0]!.equity;
  let maxDrawdownPct = 0;
  for (const p of history) {
    if (p.equity > peak) peak = p.equity;
    const dd = ((peak - p.equity) / peak) * 100;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  // Годовой Sharpe по дневным доходностям (нужно хотя бы ~8 точек).
  let sharpe: number | null = null;
  if (history.length >= 8) {
    const rets: number[] = [];
    for (let i = 1; i < history.length; i++) {
      rets.push(history[i]!.equity / history[i - 1]!.equity - 1);
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : null;
  }

  return {
    points: history.length,
    days,
    accountReturnPct,
    benchmarkReturnPct,
    alphaPct: accountReturnPct - benchmarkReturnPct,
    maxDrawdownPct,
    sharpe,
    benchmarkTicker: cfg.BENCHMARK_TICKER,
  };
}

/** Компактные строки для сводки. */
export function formatPerformance(p: Performance): string[] {
  const sign = (n: number) => (n >= 0 ? "+" : "");
  const lines = [
    `Доходность (${p.days}д, ${p.points} точек): счёт ${sign(p.accountReturnPct)}${p.accountReturnPct.toFixed(2)}% vs ${p.benchmarkTicker} ${sign(p.benchmarkReturnPct)}${p.benchmarkReturnPct.toFixed(2)}%`,
    `Альфа (vs рынок): ${sign(p.alphaPct)}${p.alphaPct.toFixed(2)}% · макс. просадка ${p.maxDrawdownPct.toFixed(2)}%${p.sharpe != null ? ` · Sharpe ${p.sharpe.toFixed(2)}` : ""}`,
  ];
  return lines;
}
