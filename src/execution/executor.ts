import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { TradingBackend } from "../backends/types.js";
import type { Approver } from "../approval/types.js";
import { AuditLog } from "../audit/log.js";
import { checkGuards, type PortfolioContext } from "../safety/guards.js";
import { EquityState } from "../safety/equity-state.js";
import { CURRENCY_UIDS } from "../domain.js";
import {
  estimatedNotional,
  describeProposal,
  type TradeProposal,
} from "../strategy/types.js";
import type { OrderResult } from "../domain.js";

export interface ExecutionOutcome {
  status: "blocked" | "rejected" | "dry-run" | "executed" | "error";
  message: string;
  order?: OrderResult;
}

/**
 * Оркестратор жизненного цикла сделки. Единственное место, откуда заявка
 * может уйти брокеру. Порядок жёсткий:
 *   портфель → guard-лимиты → аудит → подтверждение → отправка/dry-run → аудит.
 *
 * Реальная отправка на PROD требует снятия всех предохранителей
 * (см. shouldSend). Песочница безопасна и отправляет при DRY_RUN=false.
 */
export class Executor {
  constructor(
    private readonly backend: TradingBackend,
    private readonly cfg: Config,
    private readonly approver: Approver,
    private readonly audit: AuditLog = new AuditLog(),
  ) {}

  async execute(proposal: TradeProposal, accountId: string): Promise<ExecutionOutcome> {
    const notional = estimatedNotional(proposal);
    await this.audit.record("proposal", { proposal, accountId, backend: this.backend.kind });

    // 1. Контекст портфеля для долевых лимитов.
    const ctx = await this.buildPortfolioContext(proposal, accountId);

    // 2. Guard-лимиты.
    const guard = checkGuards(proposal, ctx, this.cfg);
    await this.audit.record("guard", { verdict: guard, notionalRub: notional });

    const { send, reason } = shouldSend(this.cfg, this.backend);

    if (!guard.ok) {
      return { status: "blocked", message: `Заблокировано лимитами: ${guard.violations.join("; ")}` };
    }

    // 3. Подтверждение человеком.
    const approved = await this.approver.requestApproval({
      proposal,
      guard,
      backendKind: this.backend.kind,
      willSend: send,
      sendMode: reason,
    });
    await this.audit.record("approval", { approved, proposal: describeProposal(proposal) });

    if (!approved) {
      return { status: "rejected", message: "Отклонено человеком." };
    }

    // 4. Отправка или dry-run.
    const dedupKey = `${accountId}:${proposal.instrument}:${proposal.side}:${proposal.lots}`;
    if (!send) {
      await this.audit.record("execute", { sent: false, mode: reason, notionalRub: notional, dedupKey });
      return { status: "dry-run", message: `DRY-RUN (${reason}): заявка не отправлена.` };
    }

    // Идемпотентность: не отправлять идентичную заявку повторно в коротком окне
    // (защита от дублей при рестарте/повторе; MCP не даёт broker-ключа).
    if (await this.audit.recentlySent(dedupKey, this.cfg.DEDUP_WINDOW_SEC)) {
      await this.audit.record("execute", { sent: false, mode: "dedup-blocked", notionalRub: notional, dedupKey });
      return {
        status: "blocked",
        message: `Дубль: идентичная заявка уже отправлена за последние ${this.cfg.DEDUP_WINDOW_SEC}с (idempotency).`,
      };
    }

    const idempotencyKey = randomUUID();
    try {
      const order = await this.backend.createOrder({
        accountId,
        instrumentId: proposal.instrument,
        lots: proposal.lots,
        side: proposal.side,
        orderType: proposal.orderType,
        price: proposal.orderType === "limit" ? proposal.price : undefined,
        timeInForce: proposal.timeInForce,
        idempotencyKey,
      });
      await this.audit.record("execute", { sent: true, mode: reason, notionalRub: notional, dedupKey, idempotencyKey });
      await this.audit.record("result", { order });
      return { status: "executed", message: `Отправлено (${reason}): ${order.status}`, order };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.audit.record("error", { stage: "createOrder", message });
      return { status: "error", message: `Ошибка отправки: ${message}` };
    }
  }

  private async buildPortfolioContext(
    proposal: TradeProposal,
    accountId: string,
  ): Promise<PortfolioContext> {
    let totalValueRub = 0;
    let currentPositionRub = 0;
    let investedRub = 0;
    let openPositions = 0;
    let drawdownPct = 0;
    try {
      const portfolio = await this.backend.getPortfolio(accountId);
      totalValueRub = portfolio.totalValueRub;
      // Фонд ликвидности (карри) = cash-equivalent, не считаем риск-экспозицией.
      const carryPos = portfolio.positions.find((p) => p.instrumentId === this.cfg.CARRY_UID);
      const carryValue = carryPos ? carryPos.valueRub : 0;
      // Инвестировано (риск) = всё минус кэш минус карри.
      investedRub = Math.max(0, totalValueRub - portfolio.cashRub - carryValue);
      // Реальные риск-позиции — не валюта, не карри.
      const nonCash = portfolio.positions.filter(
        (p) =>
          p.instrumentType !== "currency" &&
          p.quantity > 0 &&
          p.instrumentId !== this.cfg.CARRY_UID &&
          !CURRENCY_UIDS.has(p.instrumentId),
      );
      openPositions = nonCash.length;
      const pos = portfolio.positions.find(
        (p) => p.instrumentId === proposal.instrument || p.ticker === proposal.instrument,
      );
      currentPositionRub = pos?.valueRub ?? 0;

      // Обновляем пик капитала и считаем просадку (для kill-switch).
      if (totalValueRub > 0) {
        const { drawdownPct: dd } = await new EquityState().observe(accountId, totalValueRub);
        drawdownPct = dd;
      }
    } catch {
      // Если портфель недоступен — долевые/капитал-лимиты не сработают,
      // но абсолютные лимиты (сумма, оборот) остаются в силе.
    }
    const todayTurnoverRub = await this.audit.todayTurnoverRub();
    return { totalValueRub, currentPositionRub, todayTurnoverRub, investedRub, openPositions, drawdownPct };
  }
}

/**
 * Решение об отправке. Реальные деньги задействуются только на PROD при снятых
 * предохранителях. Песочница безопасна — отправляет при DRY_RUN=false.
 */
export function shouldSend(
  cfg: Config,
  backend: TradingBackend,
): { send: boolean; reason: string } {
  if (cfg.DRY_RUN) return { send: false, reason: "DRY_RUN=true" };
  if (backend.kind === "prod" && !cfg.ALLOW_REAL_TRADING) {
    return { send: false, reason: "ALLOW_REAL_TRADING=false" };
  }
  return {
    send: true,
    reason: backend.kind === "sandbox" ? "sandbox (ненастоящие деньги)" : "PROD — РЕАЛЬНЫЕ ДЕНЬГИ",
  };
}
