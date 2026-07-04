/**
 * Унифицированная доменная модель, не зависящая от контура (MCP prod / REST
 * sandbox). Backend'ы приводят свои сырые ответы к этим типам, а вся логика
 * выше (стратегия, guard, подтверждение) работает уже с ними.
 */

/** Известные валютные UID (кэш) — исключаем из «удерживаемых бумаг». */
export const CURRENCY_UIDS = new Set<string>([
  "a92e2e25-a698-45cc-a781-167cf465257c", // RUB (RUB000UTSTOM)
]);

/** Реальная удерживаемая бумага (не кэш, не валюта). */
export function isHeldSecurity(p: { instrumentType: string; quantity: number; instrumentId: string }): boolean {
  return p.quantity > 0 && p.instrumentType !== "currency" && !CURRENCY_UIDS.has(p.instrumentId);
}

export interface Account {
  id: string;
  name: string;
  type: string;
  accessLevel: string;
}

export interface Position {
  instrumentId: string; // UID инструмента
  instrumentType: string; // share | bond | etf | currency | future | ...
  ticker?: string;
  /** Количество в штуках. */
  quantity: number;
  /** Текущая цена за единицу (в валюте инструмента). */
  currentPrice: number;
  /** Средняя цена входа за единицу (для тейк/стоп). 0 — если недоступна. */
  avgPrice: number;
  /** Текущая стоимость позиции, руб. */
  valueRub: number;
}

export interface Portfolio {
  accountId: string;
  totalValueRub: number;
  /** Свободный кэш (из totalAmountCurrencies) — надёжнее, чем сумма позиций. */
  cashRub: number;
  positions: Position[];
}

export interface CreateOrderRequest {
  accountId: string;
  instrumentId: string; // UID или ticker_classCode
  /** Количество лотов. */
  lots: number;
  side: "buy" | "sell";
  orderType: "market" | "limit" | "bestprice";
  /** Цена за единицу (для limit), в валюте инструмента. */
  price?: number;
  /** Алгоритм исполнения limit-заявки. */
  timeInForce?: "day" | "fak" | "fok";
  /** Ключ идемпотентности (broker order_id, где поддерживается). */
  idempotencyKey?: string;
}

export interface OrderResult {
  orderId: string;
  status: string;
  /** Исполненная сумма (если доступна), руб. */
  executedRub?: number;
  raw: unknown;
}

// ─── Парсеры денежных форматов T-Invest ────────────────────────────

/** REST-формат Quotation/MoneyValue: { units: string|number, nano: number }. */
export function fromUnitsNano(v: unknown): number {
  if (v == null || typeof v !== "object") return 0;
  const o = v as { units?: string | number; nano?: number };
  const units = typeof o.units === "string" ? Number(o.units) : (o.units ?? 0);
  const nano = o.nano ?? 0;
  return units + nano / 1e9;
}

/** MCP-формат: { value: "decimal-string" }. */
export function fromValueString(v: unknown): number {
  if (v == null || typeof v !== "object") return 0;
  const o = v as { value?: string | number };
  if (o.value == null) return 0;
  return typeof o.value === "string" ? Number(o.value) : o.value;
}

/**
 * Универсальный разбор денег/количеств T-Invest: понимает и MCP-формат
 * ({value}), и REST-формат ({units,nano}), и голое число. Backend'ы могут
 * использовать его, не завися от конкретного контура.
 */
export function parseMoney(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("value" in o) return fromValueString(o);
    if ("units" in o || "nano" in o) return fromUnitsNano(o);
  }
  return 0;
}

export function fmtRub(n: number): string {
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " ₽";
}
