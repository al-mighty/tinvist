import type { Config } from "../config.js";
import type { TradingBackend } from "../backends/types.js";
import { InstrumentResolver } from "../instruments/resolve.js";
import { MarketData } from "../instruments/marketdata.js";
import { AuditLog } from "../audit/log.js";
import { EquityState } from "../safety/equity-state.js";
import { EquityHistory } from "../analytics/equity-history.js";
import { computePerformance, formatPerformance } from "../analytics/performance.js";
import { fmtRub, isHeldSecurity } from "../domain.js";

/**
 * Сводка состояния счёта: капитал, кэш, позиции с нереализ. и реализ. P&L,
 * просадка от пика, активность за день, доходность vs бенчмарк (индекс Мосбиржи).
 */
export async function buildStatusReport(
  cfg: Config,
  backend: TradingBackend,
  accountId: string,
): Promise<string> {
  const resolver = new InstrumentResolver(cfg);
  const market = new MarketData(cfg);
  const lines: string[] = [];
  try {
    const p = await backend.getPortfolio(accountId);
    lines.push(`📊 tinvist · ${backend.kind} · счёт ${accountId}`);
    lines.push(`Капитал: ${fmtRub(p.totalValueRub)}  |  кэш: ${fmtRub(p.cashRub)}`);

    const held = p.positions.filter(isHeldSecurity);
    let totalUnreal = 0;
    if (held.length === 0) {
      lines.push("Позиций нет.");
    } else {
      lines.push("Позиции:");
      for (const pos of held) {
        const info = await resolver.byUid(pos.instrumentId).catch(() => null);
        const ticker =
          pos.instrumentId === cfg.CARRY_UID
            ? `${cfg.CARRY_TICKER} (карри)`
            : info?.ticker || pos.ticker || pos.instrumentId.slice(0, 8);
        // getLastPrice может вернуть 0 при закрытом рынке — тогда берём среднюю
        // цену входа (позиция «флэт»), иначе получим ложные −100%.
        const rawLast = await backend.getLastPrice(pos.instrumentId).catch(() => 0);
        const last = rawLast > 0 ? rawLast : pos.avgPrice;
        const unreal = (last - pos.avgPrice) * pos.quantity;
        const unrealPct = pos.avgPrice > 0 ? (last / pos.avgPrice - 1) * 100 : 0;
        totalUnreal += unreal;
        const sign = unreal >= 0 ? "+" : "";
        lines.push(
          `• ${ticker}: ${pos.quantity} шт, вход ${pos.avgPrice}, тек ${last} → ${sign}${unreal.toFixed(2)}₽ (${sign}${unrealPct.toFixed(2)}%)`,
        );
      }
      const sign = totalUnreal >= 0 ? "+" : "";
      lines.push(`Нереализ. P&L: ${sign}${totalUnreal.toFixed(2)}₽`);
    }

    const { peak, drawdownPct } = await new EquityState().observe(accountId, p.totalValueRub);
    lines.push(`Пик капитала: ${fmtRub(peak)}  |  просадка: ${drawdownPct.toFixed(1)}%`);

    const audit = new AuditLog();
    const t = await audit.tradesToday();
    lines.push(`Сегодня сделок: ${t.buys} покупок, ${t.sells} продаж (оборот ${fmtRub(t.turnoverRub)})`);
    const rp = await audit.realizedPnl();
    const rs = rp.today >= 0 ? "+" : "";
    const rt = rp.total >= 0 ? "+" : "";
    lines.push(`Реализ. P&L: сегодня ${rs}${rp.today.toFixed(2)}₽, всего ${rt}${rp.total.toFixed(2)}₽`);

    // Аналитика vs бенчмарк: снапшот капитала за сегодня + доходность.
    const history = new EquityHistory();
    await history.snapshot(accountId, p.totalValueRub, Date.now());
    const perf = await computePerformance(cfg, await history.load(accountId), market).catch(() => null);
    if (perf) lines.push(...formatPerformance(perf));
    else lines.push("Доходность vs бенчмарк: копится история (нужно ≥2 дня снапшотов).");
  } finally {
    await resolver.close();
    await market.close();
  }
  return lines.join("\n");
}
