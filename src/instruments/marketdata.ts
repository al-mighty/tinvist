import type { Config } from "../config.js";
import { parseMoney } from "../domain.js";
import { TInvestMcp, extractResult } from "../mcp/client.js";
import { withRetry } from "../util/retry.js";

export interface UpcomingDividend {
  amount: number; // дивиденд на акцию, руб
  yieldPct: number; // доходность, %
  lastBuyDate: Date; // отсечка (последний день покупки)
  paymentDate: Date;
  daysToCutoff: number; // дней до отсечки (≥0)
  daysToPayment: number;
}

export interface OrderbookLevel {
  price: number;
  qty: number; // штук
}

export interface OrderbookSnapshot {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  bestBid: number;
  bestAsk: number;
  mid: number;
  spreadPct: number;
}

/**
 * Marketable-limit цена = крайний уровень стакана в пределах кэпа проскальзывания.
 * Лимит — это ПОТОЛОК цены, а не цена исполнения: заявка зальётся по лучшим
 * ценам, но не хуже кэпа. Ставим на край кэпа (для buy выше ask, для sell ниже
 * bid) — чтобы заявка оставалась маркетабельной при микро-движениях и всё же
 * ограничивала проскальзывание. Цена берётся из реального стакана → тик-валидна.
 */
export function limitPriceFromBook(
  side: "buy" | "sell",
  book: OrderbookSnapshot,
  capPct: number,
): number {
  if (side === "buy") {
    const cap = book.bestAsk * (1 + capPct / 100);
    let px = book.bestAsk;
    for (const lvl of book.asks) {
      if (lvl.price > cap) break;
      px = lvl.price; // самый высокий ask в пределах кэпа
    }
    return px;
  }
  const cap = book.bestBid * (1 - capPct / 100);
  let px = book.bestBid;
  for (const lvl of book.bids) {
    if (lvl.price < cap) break;
    px = lvl.price; // самый низкий bid в пределах кэпа
  }
  return px;
}

export interface CandleSnapshot {
  /** Цены закрытия дневных свечей, старые → новые. */
  closes: number[];
  first: number;
  last: number;
  min: number;
  max: number;
}

/**
 * Рыночные данные через MCP (prod). Котировки и свечи — это биржевые данные,
 * единые для обоих контуров, поэтому берём их через MCP с prod-токеном
 * независимо от активного backend.
 */
export class MarketData {
  private readonly mcp: TInvestMcp;
  private connected = false;

  constructor(cfg: Config) {
    if (!cfg.TINVEST_TOKEN_PROD) {
      throw new Error("MarketData требует TINVEST_TOKEN_PROD (биржевые данные через MCP).");
    }
    this.mcp = new TInvestMcp(cfg.TINVEST_MCP_URL, cfg.TINVEST_TOKEN_PROD);
  }

  private async ensure(): Promise<void> {
    if (!this.connected) {
      await withRetry(() => this.mcp.connect(), { label: "marketdata.connect" });
      this.connected = true;
    }
  }

  async close(): Promise<void> {
    if (this.connected) await this.mcp.close();
  }

  /**
   * Ближайшая предстоящая дивидендная выплата по акции (UID): та, чья отсечка
   * (lastBuyDate) ещё не прошла. null — если таких нет.
   */
  async upcomingDividend(instrumentId: string, now: Date): Promise<UpcomingDividend | null> {
    await this.ensure();
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const to = new Date(now.getTime() + 200 * 24 * 60 * 60 * 1000);
    const res = (await withRetry(
      async () =>
        extractResult(
          await this.mcp.callTool("invest_get_share_dividends", {
            instrumentId,
            from: from.toISOString(),
            to: to.toISOString(),
          }),
        ),
      { label: "invest_get_share_dividends" },
    )) as any;

    const items = (res?.dividends ?? []) as any[];
    const day = 24 * 60 * 60 * 1000;
    let best: UpcomingDividend | null = null;
    for (const d of items) {
      if (!d.lastBuyDate || !d.paymentDate) continue;
      const lastBuy = new Date(d.lastBuyDate);
      const payment = new Date(d.paymentDate);
      const daysToCutoff = Math.ceil((lastBuy.getTime() - now.getTime()) / day);
      // Интересуют только будущие отсечки (ещё можно купить и попасть в реестр).
      if (daysToCutoff < 0) continue;
      const cand: UpcomingDividend = {
        amount: parseMoney(d.dividendNet),
        yieldPct: parseMoney(d.yieldValue),
        lastBuyDate: lastBuy,
        paymentDate: payment,
        daysToCutoff,
        daysToPayment: Math.ceil((payment.getTime() - now.getTime()) / day),
      };
      if (!best || cand.daysToCutoff < best.daysToCutoff) best = cand;
    }
    return best;
  }

  /**
   * Недавняя дивидендная выплата (отсечка уже прошла) в пределах `lookbackDays`.
   * Нужна для правила «продать после выплаты». null — если нет.
   */
  async recentDividend(
    instrumentId: string,
    now: Date,
    lookbackDays = 45,
  ): Promise<UpcomingDividend | null> {
    await this.ensure();
    const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const to = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const res = (await withRetry(
      async () =>
        extractResult(
          await this.mcp.callTool("invest_get_share_dividends", {
            instrumentId,
            from: from.toISOString(),
            to: to.toISOString(),
          }),
        ),
      { label: "invest_get_share_dividends" },
    )) as any;

    const items = (res?.dividends ?? []) as any[];
    const day = 24 * 60 * 60 * 1000;
    let best: UpcomingDividend | null = null;
    for (const d of items) {
      if (!d.lastBuyDate || !d.paymentDate) continue;
      const lastBuy = new Date(d.lastBuyDate);
      const daysToCutoff = Math.ceil((lastBuy.getTime() - now.getTime()) / day);
      if (daysToCutoff > 0) continue; // только прошедшие отсечки
      const cand: UpcomingDividend = {
        amount: parseMoney(d.dividendNet),
        yieldPct: parseMoney(d.yieldValue),
        lastBuyDate: lastBuy,
        paymentDate: new Date(d.paymentDate),
        daysToCutoff,
        daysToPayment: Math.ceil((new Date(d.paymentDate).getTime() - now.getTime()) / day),
      };
      // самая свежая прошедшая отсечка (ближе к нулю)
      if (!best || cand.daysToCutoff > best.daysToCutoff) best = cand;
    }
    return best;
  }

  /** Стакан: лучшие уровни, спред. null — если пустой. */
  async orderbook(instrumentId: string, depth = 20): Promise<OrderbookSnapshot | null> {
    await this.ensure();
    const res = (await withRetry(
      async () =>
        extractResult(await this.mcp.callTool("invest_get_orderbook", { instrumentId, depth })),
      { label: "invest_get_orderbook" },
    )) as any;

    const parse = (arr: any[]) =>
      (arr ?? [])
        .map((x) => ({ price: parseMoney(x.price), qty: Number(x.quantity ?? 0) }))
        .filter((l) => l.price > 0 && l.qty > 0);
    const bids = parse(res?.bids);
    const asks = parse(res?.asks);
    if (bids.length === 0 || asks.length === 0) return null;

    const bestBid = bids[0]!.price;
    const bestAsk = asks[0]!.price;
    const mid = (bestBid + bestAsk) / 2;
    const spreadPct = mid > 0 ? ((bestAsk - bestBid) / mid) * 100 : Infinity;
    return { bids, asks, bestBid, bestAsk, mid, spreadPct };
  }

  /**
   * Внутридневной размах, % — (max high − min low)/last по 5-мин свечам за
   * последние `hours` ч. Прокси аномальной волатильности (флэшкрэш/каскад).
   * null — если нет данных.
   */
  async intradayRangePct(instrumentId: string, hours = 1): Promise<number | null> {
    await this.ensure();
    const to = new Date();
    const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
    const res = (await withRetry(
      async () =>
        extractResult(
          await this.mcp.callTool("invest_get_candles", {
            instrumentId,
            interval: "CANDLE_INTERVAL_5_MIN",
            from: from.toISOString(),
            to: to.toISOString(),
            limit: hours * 12 + 2,
          }),
        ),
      { label: "invest_get_candles(5m)" },
    )) as any;

    const candles = (res?.candles ?? []) as any[];
    if (candles.length === 0) return null;
    let maxHigh = -Infinity;
    let minLow = Infinity;
    let last = 0;
    for (const c of candles) {
      const hi = parseMoney(c.high);
      const lo = parseMoney(c.low);
      if (hi > 0) maxHigh = Math.max(maxHigh, hi);
      if (lo > 0) minLow = Math.min(minLow, lo);
      const cl = parseMoney(c.close);
      if (cl > 0) last = cl;
    }
    if (last <= 0 || !isFinite(maxHigh) || !isFinite(minLow)) return null;
    return ((maxHigh - minLow) / last) * 100;
  }

  /** Дневные свечи за последние `days` дней. */
  async dailyCandles(instrumentId: string, days = 30): Promise<CandleSnapshot | null> {
    await this.ensure();
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    const res = (await withRetry(
      async () =>
        extractResult(
          await this.mcp.callTool("invest_get_candles", {
            instrumentId,
            interval: "CANDLE_INTERVAL_DAY",
            from: from.toISOString(),
            to: to.toISOString(),
            limit: days,
          }),
        ),
      { label: "invest_get_candles" },
    )) as any;

    const candles = (res?.candles ?? []) as any[];
    const closes = candles.map((c) => parseMoney(c.close)).filter((n) => n > 0);
    if (closes.length === 0) return null;
    return {
      closes,
      first: closes[0]!,
      last: closes[closes.length - 1]!,
      min: Math.min(...closes),
      max: Math.max(...closes),
    };
  }
}
