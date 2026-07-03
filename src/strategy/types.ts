/**
 * Общие доменные типы торгового предложения.
 *
 * TradeProposal — это намерение совершить сделку, порождённое стратегией или
 * LLM. Оно проходит guard-проверки, затем подтверждение человеком, и только
 * потом превращается в реальную заявку через MCP.
 */

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";

export interface TradeProposal {
  /** Тикер/идентификатор инструмента (FIGI или ticker — уточним по схеме MCP). */
  instrument: string;
  /** Человекочитаемое имя для логов и подтверждения. */
  instrumentName?: string;
  side: OrderSide;
  orderType: OrderType;
  /** Количество лотов. */
  lots: number;
  /** Цена за 1 инструмент, руб. Для market — ожидаемая/справочная. */
  price: number;
  /** Лотность инструмента (шт. в 1 лоте). По умолчанию 1. */
  lotSize?: number;
  /** Целевая прибыль сделки, % (тейк-профит). Нужна гейту прибыльности. */
  targetPct?: number;
  /** Алгоритм исполнения limit-заявки (стратегия ставит fak для marketable-limit). */
  timeInForce?: "day" | "fak" | "fok";
  /** Обоснование от стратегии/LLM — показывается при подтверждении. */
  rationale: string;
  /** Уверенность модели, 0..1 (если применимо). */
  confidence?: number;
  /** ISO-время генерации предложения. */
  createdAt: string;
}

/** Оценочная сумма сделки в рублях. */
export function estimatedNotional(p: TradeProposal): number {
  const lotSize = p.lotSize ?? 1;
  return p.price * p.lots * lotSize;
}

export function describeProposal(p: TradeProposal): string {
  const sideRu = p.side === "buy" ? "ПОКУПКА" : "ПРОДАЖА";
  const name = p.instrumentName ? `${p.instrumentName} (${p.instrument})` : p.instrument;
  const notional = estimatedNotional(p).toLocaleString("ru-RU", {
    maximumFractionDigits: 2,
  });
  const typeRu = p.orderType === "market" ? "по рынку" : `лимит ${p.price} ₽`;
  const conf = p.confidence != null ? ` · уверенность ${(p.confidence * 100).toFixed(0)}%` : "";
  return `${sideRu} ${name}: ${p.lots} лот. ${typeRu} ≈ ${notional} ₽${conf}`;
}
