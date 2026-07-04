import type { Config } from "../../config.js";
import type { TradingBackend } from "../../backends/types.js";
import { InstrumentResolver } from "../../instruments/resolve.js";
import { MarketData, limitPriceFromBook, type OrderbookSnapshot } from "../../instruments/marketdata.js";
import { isHeldSecurity } from "../../domain.js";
import type { ProposalResult } from "../engine.js";
import type { TradeProposal } from "../types.js";

/**
 * RSI(14) по Уайлдеру из массива цен закрытия (старые → новые).
 * Возвращает null, если данных меньше period+1.
 */
export function computeRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  // Первое усреднение — простое среднее за первые `period` изменений.
  for (let i = 1; i <= period; i++) {
    const delta = closes[i]! - closes[i - 1]!;
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Далее — сглаживание Уайлдера.
  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i]! - closes[i - 1]!;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface RsiParams {
  strategyEnabled: boolean; // false → без новых входов (только выходы + карри)
  period: number;
  oversold: number; // RSI ниже → перепроданность → покупка
  overbought: number; // RSI выше → перекупленность → продажа
  takeProfitPct: number; // тейк-профит, % от входа
  stopLossPct: number; // стоп-лосс, % от входа
  // Дивидендный фактор
  divEnabled: boolean;
  divEntryWindowDays: number; // покупать за ≤ N дней до отсечки
  divMinYield: number; // мин. дивдоходность, %
  divSellAfterPayment: boolean; // true: держать через отсечку, продать после выплаты
}

const DEFAULTS: RsiParams = {
  strategyEnabled: true,
  period: 14,
  oversold: 30,
  overbought: 70,
  takeProfitPct: 4,
  stopLossPct: 3,
  divEnabled: true,
  divEntryWindowDays: 10,
  divMinYield: 3,
  divSellAfterPayment: true,
};

/**
 * Детерминированная стратегия: RSI mean-reversion + дивидендный фактор.
 * Без LLM — чистые правила, предсказуема и воспроизводима.
 *
 * ВХОД (позиции нет):
 *  - дивидендный: до отсечки ≤ divEntryWindowDays и доходность ≥ divMinYield → ПОКУПКА
 *  - иначе RSI ≤ oversold → ПОКУПКА
 * ВЫХОД (позиция есть), приоритет сверху вниз:
 *  - дивидендный: после выплаты (divSellAfterPayment) либо перед отсечкой (skip-gap)
 *  - RSI ≥ overbought
 *  - тейк-профит / стоп-лосс от средней цены входа
 * Иначе — держим / пропуск.
 */
export class RsiStrategy {
  private readonly p: RsiParams;

  constructor(
    private readonly cfg: Config,
    private readonly backend: TradingBackend,
    params: Partial<RsiParams> = {},
  ) {
    this.p = { ...DEFAULTS, ...params };
  }

  async propose(watchlist: string[], accountId: string): Promise<ProposalResult> {
    const resolver = new InstrumentResolver(this.cfg);
    const market = new MarketData(this.cfg);
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const proposals: TradeProposal[] = [];
    const notes: string[] = [];

    try {
      const portfolio = await this.backend.getPortfolio(accountId);
      let cashLeft = portfolio.cashRub;

      // Валюта/кэш: prod отдаёт валютную позицию без instrumentType, поэтому
      // исключаем и по типу, и по известным валютным UID.
      // Карри-фонд (LQDT) — не спекулятивная позиция, стратегией не сопровождается.
      const heldShares = portfolio.positions.filter(
        (p) => isHeldSecurity(p) && p.instrumentId !== this.cfg.CARRY_UID,
      );
      const heldUids = new Set(heldShares.map((p) => p.instrumentId));

      // ── ВЫХОДЫ: управляем открытыми позициями (RSI≥70 / тейк / стоп) ──
      for (const pos of heldShares) {
        // prod-позиции без ticker/lot → резолвим по UID (invest_get_share).
        const info =
          (await resolver.byUid(pos.instrumentId)) ??
          (pos.ticker ? await resolver.resolveOne(pos.ticker) : null);
        if (!info) {
          notes.push(`${pos.ticker || pos.instrumentId}: не резолвится (не акция?) — пропуск выхода`);
          continue;
        }
        const lots = Math.floor(pos.quantity / info.lot);
        if (lots < 1) continue;

        if (!(await market.isTradeable(info.uid))) {
          notes.push(`${info.ticker}: торги закрыты — выход отложен`);
          continue;
        }

        const book = await market.orderbook(info.uid).catch(() => null);
        const price = book ? book.mid : await this.backend.getLastPrice(info.uid);
        const candles = await market.dailyCandles(info.uid, 45).catch(() => null);
        const rsi = candles ? computeRSI(candles.closes, this.p.period) : null;
        const rsiStr = rsi != null ? rsi.toFixed(1) : "n/a";

        const tpPrice = pos.avgPrice > 0 ? pos.avgPrice * (1 + this.p.takeProfitPct / 100) : Infinity;
        const slPrice = pos.avgPrice > 0 ? pos.avgPrice * (1 - this.p.stopLossPct / 100) : 0;

        let reason: string | null = null;
        // Дивидендный выход имеет приоритет.
        if (this.p.divEnabled) {
          if (this.p.divSellAfterPayment) {
            const rd = await market.recentDividend(info.uid, nowDate).catch(() => null);
            if (rd && rd.daysToPayment <= 0) {
              reason = `Продажа после выплаты дивиденда ${rd.amount}₽ (отсечка прошла ${-rd.daysToCutoff} дн назад).`;
            }
          } else {
            const ud = await market.upcomingDividend(info.uid, nowDate).catch(() => null);
            if (ud && ud.daysToCutoff <= 1) {
              reason = `Продажа перед отсечкой (${ud.daysToCutoff} дн) — избегаем дивидендного гэпа.`;
            }
          }
        }
        if (reason) {
          // дивидендный выход выбран
        } else if (rsi != null && rsi >= this.p.overbought) {
          reason = `RSI(${this.p.period})=${rsiStr} ≥ ${this.p.overbought} — перекупленность, фиксируем.`;
        } else if (price >= tpPrice) {
          reason = `Тейк-профит: цена ${price} ≥ ${tpPrice.toFixed(2)} (+${this.p.takeProfitPct}% от входа ${pos.avgPrice}).`;
        } else if (price <= slPrice) {
          reason = `Стоп-лосс: цена ${price} ≤ ${slPrice.toFixed(2)} (−${this.p.stopLossPct}% от входа ${pos.avgPrice}).`;
        }

        if (reason) {
          const exec = this.orderExec("sell", book, price);
          proposals.push({
            instrument: info.uid,
            instrumentName: `${info.ticker} · ${info.name}`,
            side: "sell",
            orderType: exec.orderType,
            lots,
            price: exec.price,
            timeInForce: exec.timeInForce,
            lotSize: info.lot,
            confidence: 0.8,
            rationale: reason,
            createdAt: now,
          });
        } else {
          notes.push(`${info.ticker}: держим (RSI ${rsiStr}, цена ${price}, вход ${pos.avgPrice || "?"})`);
        }
      }

      // ── ВХОДЫ: дивидендный фактор ИЛИ RSI≤30, если позиции ещё нет ──
      // Режим «только карри» (STRATEGY_ENABLED=false): новых входов нет,
      // но выходы выше и карри ниже продолжают работать.
      if (!this.p.strategyEnabled) notes.push("режим «только карри»: спекулятивные входы отключены");
      for (const query of this.p.strategyEnabled ? watchlist : []) {
        const info = await resolver.resolveOne(query);
        if (!info) {
          notes.push(`${query}: не найден`);
          continue;
        }
        if (heldUids.has(info.uid)) continue; // уже в портфеле — управляется выходами

        if (!(await market.isTradeable(info.uid))) {
          notes.push(`${info.ticker}: торги закрыты — пропуск`);
          continue;
        }

        // Фильтр ликвидности: не входим в широкий спред (дорогое проскальзывание).
        const book = await market.orderbook(info.uid).catch(() => null);
        if (!book) {
          notes.push(`${info.ticker}: нет стакана — пропуск`);
          continue;
        }
        if (book.spreadPct > this.cfg.MAX_SPREAD_PCT) {
          notes.push(`${info.ticker}: спред ${book.spreadPct.toFixed(2)}% > ${this.cfg.MAX_SPREAD_PCT}% — неликвидно, пропуск`);
          continue;
        }

        // Circuit breaker: не входим в аномальное движение (флэшкрэш/каскад).
        if (this.cfg.VOLATILITY_ENABLED) {
          const range = await market.intradayRangePct(info.uid).catch(() => null);
          if (range != null && range > this.cfg.MAX_INTRADAY_RANGE_PCT) {
            notes.push(`${info.ticker}: волатильность ${range.toFixed(1)}% > ${this.cfg.MAX_INTRADAY_RANGE_PCT}% — circuit breaker, пропуск`);
            continue;
          }
        }

        let rationale: string | null = null;
        let confidence = 0.6;

        // 1) Дивидендный вход: близко к отсечке и доходность выше порога.
        if (this.p.divEnabled) {
          const ud = await market.upcomingDividend(info.uid, nowDate).catch(() => null);
          if (
            ud &&
            ud.daysToCutoff > 0 &&
            ud.daysToCutoff <= this.p.divEntryWindowDays &&
            ud.yieldPct >= this.p.divMinYield
          ) {
            rationale = `Дивиденд ${ud.amount}₽ (доходность ${ud.yieldPct.toFixed(1)}%), отсечка через ${ud.daysToCutoff} дн — покупка под дивиденд.`;
            confidence = Math.max(0.6, Math.min(0.9, 0.5 + ud.yieldPct / 40));
          }
        }

        // 2) Иначе RSI mean-reversion.
        if (!rationale) {
          const candles = await market.dailyCandles(info.uid, 45).catch(() => null);
          const rsi = candles ? computeRSI(candles.closes, this.p.period) : null;
          if (rsi == null) {
            notes.push(`${info.ticker}: недостаточно истории для RSI`);
            continue;
          }
          const rsiStr = rsi.toFixed(1);
          if (rsi > this.p.oversold) {
            notes.push(`${info.ticker}: RSI ${rsiStr} — нет сетапа`);
            continue;
          }
          rationale = `RSI(${this.p.period})=${rsiStr} ≤ ${this.p.oversold} — перепроданность. Ориентиры: тейк +${this.p.takeProfitPct}%, стоп −${this.p.stopLossPct}%.`;
          confidence = this.confidence(rsi, "buy");
        }

        const exec = this.orderExec("buy", book, book.mid);
        const notional = exec.price * info.lot;
        if (notional > this.cfg.MAX_ORDER_RUB) {
          notes.push(`${info.ticker}: сигнал, но лот ${notional.toFixed(0)}₽ > лимита`);
          continue;
        }
        if (notional > cashLeft) {
          notes.push(`${info.ticker}: сигнал, но не хватает кэша`);
          continue;
        }
        cashLeft -= notional;
        proposals.push({
          instrument: info.uid,
          instrumentName: `${info.ticker} · ${info.name}`,
          side: "buy",
          orderType: exec.orderType,
          lots: 1,
          price: exec.price,
          timeInForce: exec.timeInForce,
          lotSize: info.lot,
          confidence,
          targetPct: this.p.takeProfitPct,
          rationale,
          createdAt: now,
        });
      }

      // ── КАРРИ: паркуем избыточный кэш (сверх резерва) в фонд ликвидности ──
      if (this.cfg.CARRY_ENABLED && (await market.isTradeable(this.cfg.CARRY_UID).catch(() => false))) {
        const excess = cashLeft - this.cfg.CASH_RESERVE_RUB;
        const book = await market.orderbook(this.cfg.CARRY_UID).catch(() => null);
        const price = book ? book.bestAsk : await this.backend.getLastPrice(this.cfg.CARRY_UID).catch(() => 0);
        if (price > 0 && excess >= price) {
          const lots = Math.floor(excess / price); // лот фонда = 1
          const exec = this.orderExec("buy", book, price);
          proposals.push({
            instrument: this.cfg.CARRY_UID,
            instrumentName: `${this.cfg.CARRY_TICKER} · фонд ликвидности`,
            side: "buy",
            orderType: exec.orderType,
            lots,
            price: exec.price,
            timeInForce: exec.timeInForce,
            lotSize: 1,
            kind: "carry",
            confidence: 1,
            rationale: `Парковка кэша: ${lots} лот ${this.cfg.CARRY_TICKER} ≈ ${(lots * price).toFixed(0)}₽ (ежедневный карри по ставке).`,
            createdAt: now,
          });
        } else if (excess > 0) {
          notes.push(`карри: избыток ${excess.toFixed(0)}₽ < цены лота ${this.cfg.CARRY_TICKER}`);
        }
      }
    } finally {
      await resolver.close();
      await market.close();
    }

    const commentary =
      `RSI(${this.p.oversold}/${this.p.overbought})` +
      (this.p.divEnabled ? ` + дивиденды (окно ${this.p.divEntryWindowDays}д, доходность ≥${this.p.divMinYield}%)` : "") +
      ". " +
      (proposals.length ? `Сигналов: ${proposals.length}. ` : "Сигналов нет. ") +
      notes.join("; ");

    return { proposals, commentary };
  }

  /**
   * Тип/цена/TIF заявки. При USE_LIMIT_ORDERS — marketable-limit по стакану в
   * пределах кэпа проскальзывания + FILL_AND_KILL (не оставляет висящих заявок).
   * Иначе — рыночная по референсной цене.
   */
  private orderExec(
    side: "buy" | "sell",
    book: OrderbookSnapshot | null,
    refPrice: number,
  ): { orderType: "market" | "limit"; price: number; timeInForce?: "day" | "fak" | "fok" } {
    if (this.cfg.USE_LIMIT_ORDERS && book) {
      const price = limitPriceFromBook(side, book, this.cfg.LIMIT_SLIPPAGE_CAP_PCT);
      return { orderType: "limit", price, timeInForce: "fak" };
    }
    return { orderType: "market", price: refPrice };
  }

  /** Чем дальше RSI за порог, тем выше уверенность (0.5..0.9). */
  private confidence(rsi: number, side: "buy" | "sell"): number {
    const dist = side === "buy" ? this.p.oversold - rsi : rsi - this.p.overbought;
    return Math.max(0.5, Math.min(0.9, 0.5 + dist / 100));
  }
}
