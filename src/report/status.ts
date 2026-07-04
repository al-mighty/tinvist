import type { Config } from "../config.js";
import type { TradingBackend } from "../backends/types.js";
import { InstrumentResolver } from "../instruments/resolve.js";
import { AuditLog } from "../audit/log.js";
import { EquityState } from "../safety/equity-state.js";
import { fmtRub, isHeldSecurity } from "../domain.js";

/**
 * Сводка состояния счёта: капитал, кэш, позиции с нереализованным P&L
 * (относительно средней цены входа), просадка от пика, активность за день.
 * Реализованный P&L не считаем — позиции обычно открыты; смотрим unrealized.
 */
export async function buildStatusReport(
  cfg: Config,
  backend: TradingBackend,
  accountId: string,
): Promise<string> {
  const resolver = new InstrumentResolver(cfg);
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
        const ticker = info?.ticker || pos.ticker || pos.instrumentId.slice(0, 8);
        const last = await backend.getLastPrice(pos.instrumentId).catch(() => pos.avgPrice);
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

    const t = await new AuditLog().tradesToday();
    lines.push(`Сегодня сделок: ${t.buys} покупок, ${t.sells} продаж (оборот ${fmtRub(t.turnoverRub)})`);
  } finally {
    await resolver.close();
  }
  return lines.join("\n");
}
