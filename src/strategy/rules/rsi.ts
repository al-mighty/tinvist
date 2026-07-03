import type { Config } from "../../config.js";
import type { TradingBackend } from "../../backends/types.js";
import { InstrumentResolver } from "../../instruments/resolve.js";
import { MarketData } from "../../instruments/marketdata.js";
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
      const cash = portfolio.positions
        .filter((p) => p.instrumentType === "currency")
        .reduce((s, p) => s + p.valueRub, 0);
      let cashLeft = cash;

      const heldShares = portfolio.positions.filter(
        (p) => p.instrumentType === "share" && p.quantity > 0,
      );
      const heldUids = new Set(heldShares.map((p) => p.instrumentId));

      // ── ВЫХОДЫ: управляем открытыми позициями (RSI≥70 / тейк / стоп) ──
      for (const pos of heldShares) {
        const info = await resolver.resolveOne(pos.ticker || pos.instrumentId);
        if (!info) {
          notes.push(`${pos.ticker ?? pos.instrumentId}: не найден для выхода`);
          continue;
        }
        const lots = Math.floor(pos.quantity / info.lot);
        if (lots < 1) continue;

        const price = await this.backend.getLastPrice(info.uid);
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
          proposals.push({
            instrument: info.uid,
            instrumentName: `${info.ticker} · ${info.name}`,
            side: "sell",
            orderType: "market",
            lots,
            price,
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
      for (const query of watchlist) {
        const info = await resolver.resolveOne(query);
        if (!info) {
          notes.push(`${query}: не найден`);
          continue;
        }
        if (heldUids.has(info.uid)) continue; // уже в портфеле — управляется выходами

        const price = await this.backend.getLastPrice(info.uid);
        const notional = price * info.lot;

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
          orderType: "market",
          lots: 1,
          price,
          lotSize: info.lot,
          confidence,
          rationale,
          createdAt: now,
        });
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

  /** Чем дальше RSI за порог, тем выше уверенность (0.5..0.9). */
  private confidence(rsi: number, side: "buy" | "sell"): number {
    const dist = side === "buy" ? this.p.oversold - rsi : rsi - this.p.overbought;
    return Math.max(0.5, Math.min(0.9, 0.5 + dist / 100));
  }
}
