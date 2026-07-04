import type { Config } from "../config.js";
import { estimatedNotional, type TradeProposal } from "../strategy/types.js";

/**
 * Контекст портфеля, нужный для проверки долевых лимитов. Заполняется из
 * read-команд MCP (портфель) перед проверкой. Держим guard-слой чистым и
 * тестируемым: он не ходит в сеть сам, а получает уже собранные цифры.
 */
export interface PortfolioContext {
  /** Полная стоимость портфеля (позиции + кэш), руб. */
  totalValueRub: number;
  /** Текущая стоимость позиции по этому инструменту, руб. */
  currentPositionRub: number;
  /** Суммарный оборот заявок за сегодня (до этой сделки), руб. */
  todayTurnoverRub: number;
  /** Стоимость всех неденежных позиций (экспозиция), руб. */
  investedRub: number;
  /** Число открытых неденежных позиций. */
  openPositions: number;
  /** Просадка от пика капитала, % (0 — на пике/выше). */
  drawdownPct: number;
}

export interface GuardVerdict {
  ok: boolean;
  violations: string[];
  /** Предупреждения, не блокирующие сделку. */
  warnings: string[];
}

/**
 * Жёсткие проверки перед любой заявкой. Отрабатывают ДО обращения к брокеру.
 * При `ok=false` сделка не должна исполняться даже после подтверждения.
 */
export function checkGuards(
  proposal: TradeProposal,
  ctx: PortfolioContext,
  cfg: Config,
): GuardVerdict {
  const violations: string[] = [];
  const warnings: string[] = [];

  // Карри (парковка кэша в фонд ликвидности) — cash-equivalent, не риск-сделка:
  // спекулятивные лимиты не применяем (отправка всё равно под DRY_RUN/подтверждением).
  if (proposal.kind === "carry") {
    return { ok: true, violations, warnings: ["Парковка кэша в фонд ликвидности (карри)."] };
  }

  const notional = estimatedNotional(proposal);

  // 1. Лимит на размер одной сделки.
  if (notional > cfg.MAX_ORDER_RUB) {
    violations.push(
      `Сумма сделки ${fmt(notional)} ₽ превышает лимит MAX_ORDER_RUB=${fmt(cfg.MAX_ORDER_RUB)} ₽`,
    );
  }

  // 2. Дневной оборот.
  const projectedTurnover = ctx.todayTurnoverRub + notional;
  if (projectedTurnover > cfg.MAX_DAILY_TURNOVER_RUB) {
    violations.push(
      `Дневной оборот достигнет ${fmt(projectedTurnover)} ₽ при лимите ` +
        `MAX_DAILY_TURNOVER_RUB=${fmt(cfg.MAX_DAILY_TURNOVER_RUB)} ₽`,
    );
  }

  // Долевые и капитал-сберегающие лимиты — только для ПОКУПКИ
  // (продажа снижает риск и всегда разрешена).
  if (proposal.side === "buy") {
    if (ctx.totalValueRub > 0) {
      const projectedPositionRub = ctx.currentPositionRub + notional;
      const projectedShare = projectedPositionRub / (ctx.totalValueRub + notional);
      if (projectedShare > cfg.MAX_POSITION_SHARE) {
        violations.push(
          `Доля инструмента достигнет ${(projectedShare * 100).toFixed(1)}% при лимите ` +
            `MAX_POSITION_SHARE=${(cfg.MAX_POSITION_SHARE * 100).toFixed(0)}%`,
        );
      }
    }

    // Drawdown kill-switch: просадка от пика → стоп новых покупок.
    if (cfg.MAX_DRAWDOWN_PCT > 0 && ctx.drawdownPct >= cfg.MAX_DRAWDOWN_PCT) {
      violations.push(
        `Просадка ${ctx.drawdownPct.toFixed(1)}% ≥ MAX_DRAWDOWN_PCT=${cfg.MAX_DRAWDOWN_PCT}% — ` +
          `новые покупки остановлены (защита капитала).`,
      );
    }

    // Пол капитала: ниже границы не покупаем.
    if (cfg.EQUITY_FLOOR_RUB > 0 && ctx.totalValueRub <= cfg.EQUITY_FLOOR_RUB) {
      violations.push(
        `Капитал ${fmt(ctx.totalValueRub)} ₽ ≤ EQUITY_FLOOR_RUB=${fmt(cfg.EQUITY_FLOOR_RUB)} ₽ — покупки запрещены.`,
      );
    }

    // Лимит экспозиции: держим денежную подушку.
    if (ctx.totalValueRub > 0) {
      const projectedExposure = (ctx.investedRub + notional) / ctx.totalValueRub;
      if (projectedExposure > cfg.MAX_TOTAL_EXPOSURE_PCT) {
        violations.push(
          `Экспозиция достигнет ${(projectedExposure * 100).toFixed(0)}% при лимите ` +
            `MAX_TOTAL_EXPOSURE_PCT=${(cfg.MAX_TOTAL_EXPOSURE_PCT * 100).toFixed(0)}% (нужна подушка кэша).`,
        );
      }
    }

    // Лимит числа открытых позиций (новая позиция по этому инструменту).
    if (cfg.MAX_OPEN_POSITIONS > 0 && ctx.currentPositionRub === 0 && ctx.openPositions >= cfg.MAX_OPEN_POSITIONS) {
      violations.push(
        `Уже открыто ${ctx.openPositions} позиций при лимите MAX_OPEN_POSITIONS=${cfg.MAX_OPEN_POSITIONS}.`,
      );
    }

    // Гейт прибыльности: цель сделки должна покрывать издержки round-trip с запасом.
    const roundTripPct = 2 * cfg.COMMISSION_PCT + cfg.SLIPPAGE_PCT;
    if (proposal.targetPct != null) {
      const required = roundTripPct * cfg.MIN_NET_EDGE_RATIO;
      if (proposal.targetPct < required) {
        violations.push(
          `Окупаемость: цель ${proposal.targetPct}% < издержки ${roundTripPct.toFixed(2)}% × ${cfg.MIN_NET_EDGE_RATIO} = ${required.toFixed(2)}% — сделка не окупает комиссию.`,
        );
      }
    } else {
      warnings.push(
        `Цель сделки не задана — окупаемость по комиссии не проверена (round-trip ≈ ${roundTripPct.toFixed(2)}%).`,
      );
    }
  }

  // Мягкие сигналы — не блокируют, но подсвечиваются человеку.
  if (proposal.orderType === "market") {
    warnings.push("Рыночная заявка: реальная цена исполнения может отличаться от оценочной.");
  }
  if (proposal.confidence != null && proposal.confidence < 0.5) {
    warnings.push(`Низкая уверенность модели: ${(proposal.confidence * 100).toFixed(0)}%.`);
  }

  return { ok: violations.length === 0, violations, warnings };
}

function fmt(n: number): string {
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}
