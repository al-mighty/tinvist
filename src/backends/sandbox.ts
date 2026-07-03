import type { Config } from "../config.js";
import {
  parseMoney,
  type Account,
  type CreateOrderRequest,
  type OrderResult,
  type Portfolio,
  type Position,
} from "../domain.js";
import { withRetry } from "../util/retry.js";
import type { TradingBackend } from "./types.js";

const NS = "tinkoff.public.invest.api.contract.v1";

/**
 * Песочница через T-Invest REST. MCP песочницу не поддерживает, поэтому для
 * безопасной отладки исполнения ходим напрямую в SandboxService (счёт, портфель,
 * заявки) и MarketDataService (котировки). Деньги ненастоящие.
 *
 * REST-формат денег — { units: string, nano: int }.
 */
export class SandboxBackend implements TradingBackend {
  readonly kind = "sandbox" as const;
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(cfg: Config) {
    if (!cfg.TINVEST_TOKEN_SANDBOX) {
      throw new Error("Sandbox backend требует TINVEST_TOKEN_SANDBOX");
    }
    this.baseUrl = cfg.TINVEST_REST_URL;
    this.token = cfg.TINVEST_TOKEN_SANDBOX;
  }

  async connect(): Promise<void> {
    // REST не требует установки соединения.
  }
  async close(): Promise<void> {}

  private async rpc(service: string, method: string, body: unknown): Promise<any> {
    const url = `${this.baseUrl}/${NS}.${service}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`REST ${service}/${method}: не удалось разобрать ответ: ${text.slice(0, 200)}`);
    }
    if (!res.ok || (json && typeof json.code === "number" && json.code !== 0)) {
      throw new Error(`REST ${service}/${method} ошибка: ${JSON.stringify(json)}`);
    }
    return json;
  }

  /** Чтение с ретраем транзиентных сбоев (идемпотентно). */
  private rpcRead(service: string, method: string, body: unknown): Promise<any> {
    return withRetry(() => this.rpc(service, method, body), { label: `${service}/${method}` });
  }

  async listAccounts(): Promise<Account[]> {
    const res = await this.rpcRead("SandboxService", "GetSandboxAccounts", {});
    return ((res?.accounts ?? []) as any[]).map((a) => ({
      id: String(a.id),
      name: a.name ?? "",
      type: a.type ?? "",
      accessLevel: a.accessLevel ?? "",
    }));
  }

  async getPortfolio(accountId: string): Promise<Portfolio> {
    const res = await this.rpcRead("SandboxService", "GetSandboxPortfolio", { accountId });
    const positions: Position[] = ((res?.positions ?? []) as any[]).map((p) => {
      const qty = parseMoney(p.quantity);
      const price = parseMoney(p.currentPrice);
      return {
        instrumentId: p.instrumentUid ?? p.figi ?? "",
        instrumentType: p.instrumentType ?? "",
        ticker: p.ticker,
        quantity: qty,
        currentPrice: price,
        avgPrice: parseMoney(p.averagePositionPrice),
        valueRub: qty * price,
      };
    });
    return {
      accountId,
      totalValueRub: parseMoney(res?.totalAmountPortfolio),
      cashRub: parseMoney(res?.totalAmountCurrencies),
      positions,
    };
  }

  async getLastPrice(instrumentId: string): Promise<number> {
    const res = await this.rpcRead("MarketDataService", "GetOrderBook", { instrumentId, depth: 1 });
    const last = parseMoney(res?.lastPrice);
    if (last > 0) return last;
    const bid = parseMoney(res?.bids?.[0]?.price);
    const ask = parseMoney(res?.asks?.[0]?.price);
    if (bid && ask) return (bid + ask) / 2;
    return bid || ask || 0;
  }

  async createOrder(req: CreateOrderRequest): Promise<OrderResult> {
    const body: Record<string, unknown> = {
      accountId: req.accountId,
      instrumentId: req.instrumentId,
      quantity: String(req.lots),
      direction: req.side === "buy" ? "ORDER_DIRECTION_BUY" : "ORDER_DIRECTION_SELL",
      orderType:
        req.orderType === "market"
          ? "ORDER_TYPE_MARKET"
          : req.orderType === "bestprice"
            ? "ORDER_TYPE_BESTPRICE"
            : "ORDER_TYPE_LIMIT",
    };
    if (req.orderType === "limit" && req.price != null) {
      body.price = toQuotation(req.price);
    }
    // REST SandboxService поддерживает orderId как ключ идемпотентности.
    if (req.idempotencyKey) body.orderId = req.idempotencyKey;
    const res = await this.rpc("SandboxService", "PostSandboxOrder", body);
    return {
      orderId: String(res?.orderId ?? ""),
      status: String(res?.executionReportStatus ?? "UNKNOWN"),
      executedRub: res?.executedOrderPrice ? parseMoney(res.executedOrderPrice) : undefined,
      raw: res,
    };
  }
}

/** Десятичная цена → Quotation { units, nano }. */
function toQuotation(price: number): { units: string; nano: number } {
  const units = Math.trunc(price);
  const nano = Math.round((price - units) * 1e9);
  return { units: String(units), nano };
}
