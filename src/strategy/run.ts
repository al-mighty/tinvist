import type { Config } from "../config.js";
import type { TradingBackend } from "../backends/types.js";
import { Executor } from "../execution/executor.js";
import { createApprover } from "../approval/factory.js";
import { RsiStrategy } from "./rules/rsi.js";
import { describeProposal } from "./types.js";

/**
 * Один цикл RSI+дивидендной стратегии: сформировать предложения и провести
 * каждое через конвейер (guard → подтверждение → исполнение). Используется
 * и командой `rsi`, и планировщиком `loop`.
 */
export async function runRsiCycle(
  cfg: Config,
  backend: TradingBackend,
  accountId: string,
  watchlist: string[],
): Promise<void> {
  const strategy = new RsiStrategy(cfg, backend, {
    strategyEnabled: cfg.STRATEGY_ENABLED,
    period: cfg.RSI_PERIOD,
    oversold: cfg.RSI_OVERSOLD,
    overbought: cfg.RSI_OVERBOUGHT,
    takeProfitPct: cfg.RSI_TP_PCT,
    stopLossPct: cfg.RSI_SL_PCT,
    divEnabled: cfg.DIV_ENABLED,
    divEntryWindowDays: cfg.DIV_ENTRY_WINDOW_DAYS,
    divMinYield: cfg.DIV_MIN_YIELD,
    divSellAfterPayment: cfg.DIV_SELL_AFTER_PAYMENT,
  });

  const { proposals, commentary } = await strategy.propose(watchlist, accountId);
  console.log(`\n${commentary}`);
  if (proposals.length === 0) {
    console.log("Сигналов нет — стратегия не торгует.");
    return;
  }
  console.log(`Предложено сделок: ${proposals.length}`);
  for (const p of proposals) console.log(`  • ${describeProposal(p)}`);

  const executor = new Executor(backend, cfg, createApprover(cfg));
  for (const proposal of proposals) {
    const outcome = await executor.execute(proposal, accountId);
    console.log(`[${outcome.status}] ${outcome.message}`);
    if (outcome.order) console.log(`orderId: ${outcome.order.orderId}  status: ${outcome.order.status}`);
  }
}
