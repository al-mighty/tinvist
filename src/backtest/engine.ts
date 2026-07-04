import type { Config } from "../config.js";
import { InstrumentResolver } from "../instruments/resolve.js";
import { MarketData } from "../instruments/marketdata.js";
import { computeRSI } from "../strategy/rules/rsi.js";

export interface BacktestResult {
  ticker: string;
  bars: number;
  trades: number;
  wins: number;
  winRatePct: number;
  netPnlRub: number; // реализованный, net комиссии (1 лот на сделку)
  grossPnlRub: number;
  commissionRub: number;
  maxDrawdownRub: number;
  buyHoldPnlRub: number; // купил 1 лот в начале, держал (net 2 комиссии)
  openPosition: boolean;
  note?: string;
}

/**
 * Бэктест RSI mean-reversion на дневных свечах. Правила и издержки — как в
 * live: RSI(period), вход RSI≤oversold, выход RSI≥overbought / тейк / стоп,
 * комиссия COMMISSION_PCT за сторону. Решение на закрытии дня, ИСПОЛНЕНИЕ по
 * открытию следующего дня (без заглядывания в будущее). 1 лот на сделку.
 * Дивидендный фактор НЕ моделируется (нужны историч. даты отсечек).
 */
export async function backtestTicker(
  cfg: Config,
  resolver: InstrumentResolver,
  market: MarketData,
  query: string,
  days: number,
): Promise<BacktestResult | null> {
  const info = await resolver.resolveOne(query);
  if (!info) return null;
  const ohlc = await market.dailyOHLC(info.uid, days).catch(() => null);
  if (!ohlc || ohlc.closes.length < cfg.RSI_PERIOD + 5) {
    return {
      ticker: info.ticker || query,
      bars: ohlc?.closes.length ?? 0,
      trades: 0,
      wins: 0,
      winRatePct: 0,
      netPnlRub: 0,
      grossPnlRub: 0,
      commissionRub: 0,
      maxDrawdownRub: 0,
      buyHoldPnlRub: 0,
      openPosition: false,
      note: "недостаточно истории",
    };
  }

  const { opens, closes } = ohlc;
  const lot = info.lot;
  const comm = cfg.COMMISSION_PCT / 100;
  const tp = cfg.RSI_TP_PCT / 100;
  const sl = cfg.RSI_SL_PCT / 100;

  let inPos = false;
  let entryPrice = 0;
  let entryComm = 0;
  let trades = 0;
  let wins = 0;
  let netPnl = 0;
  let grossPnl = 0;
  let commTotal = 0;
  let equity = 0; // кривая реализованного P&L
  let peakEquity = 0;
  let maxDD = 0;

  // i — бар решения; исполняем по opens[i+1].
  for (let i = cfg.RSI_PERIOD; i < closes.length - 1; i++) {
    const rsi = computeRSI(closes.slice(0, i + 1), cfg.RSI_PERIOD);
    if (rsi == null) continue;
    const fill = opens[i + 1]!; // цена исполнения — открытие следующего дня

    if (!inPos) {
      if (rsi <= cfg.RSI_OVERSOLD) {
        inPos = true;
        entryPrice = fill;
        entryComm = fill * lot * comm;
      }
    } else {
      const hitTp = fill >= entryPrice * (1 + tp);
      const hitSl = fill <= entryPrice * (1 - sl);
      if (rsi >= cfg.RSI_OVERBOUGHT || hitTp || hitSl) {
        const exitComm = fill * lot * comm;
        const gross = (fill - entryPrice) * lot;
        const net = gross - entryComm - exitComm;
        trades++;
        if (net > 0) wins++;
        grossPnl += gross;
        commTotal += entryComm + exitComm;
        netPnl += net;
        equity += net;
        peakEquity = Math.max(peakEquity, equity);
        maxDD = Math.max(maxDD, peakEquity - equity);
        inPos = false;
      }
    }
  }

  // Buy&hold: 1 лот с первого открытия до последнего закрытия, net 2 комиссии.
  const bhEntry = opens[cfg.RSI_PERIOD]!;
  const bhExit = closes[closes.length - 1]!;
  const buyHoldPnl = (bhExit - bhEntry) * lot - bhEntry * lot * comm - bhExit * lot * comm;

  return {
    ticker: info.ticker || query,
    bars: closes.length,
    trades,
    wins,
    winRatePct: trades ? (wins / trades) * 100 : 0,
    netPnlRub: netPnl,
    grossPnlRub: grossPnl,
    commissionRub: commTotal,
    maxDrawdownRub: maxDD,
    buyHoldPnlRub: buyHoldPnl,
    openPosition: inPos,
  };
}

export async function runBacktest(
  cfg: Config,
  watchlist: string[],
  days: number,
): Promise<BacktestResult[]> {
  const resolver = new InstrumentResolver(cfg);
  const market = new MarketData(cfg);
  const results: BacktestResult[] = [];
  try {
    for (const q of watchlist) {
      const r = await backtestTicker(cfg, resolver, market, q, days);
      if (r) results.push(r);
    }
  } finally {
    await resolver.close();
    await market.close();
  }
  return results;
}
