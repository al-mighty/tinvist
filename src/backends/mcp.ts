import type { Config } from "../config.js";
import {
  parseMoney,
  type Account,
  type CreateOrderRequest,
  type OrderResult,
  type Portfolio,
  type Position,
} from "../domain.js";
import { TInvestMcp, extractResult } from "../mcp/client.js";
import { withRetry } from "../util/retry.js";
import type { TradingBackend } from "./types.js";

/**
 * Боевой контур через T-Bank Invest MCP. Использует prod-токен.
 * Все денежные поля MCP приходят как { value: "decimal" } — парсим через
 * универсальный parseMoney.
 */
export class McpBackend implements TradingBackend {
  readonly kind = "prod" as const;
  private readonly mcp: TInvestMcp;

  constructor(cfg: Config) {
    if (!cfg.TINVEST_TOKEN_PROD) {
      throw new Error("MCP backend требует TINVEST_TOKEN_PROD");
    }
    this.mcp = new TInvestMcp(cfg.TINVEST_MCP_URL, cfg.TINVEST_TOKEN_PROD);
  }

  connect(): Promise<void> {
    return withRetry(() => this.mcp.connect(), { label: "mcp.connect" });
  }
  close(): Promise<void> {
    return this.mcp.close();
  }

  /** Чтение с ретраем транзиентных сбоев (идемпотентно). */
  private async callRead(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return withRetry(async () => extractResult(await this.mcp.callTool(name, args)), { label: name });
  }

  /** Вызов без ретрая — для операций, которые нельзя повторять (создание заявки). */
  private async callOnce(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return extractResult(await this.mcp.callTool(name, args));
  }

  async listAccounts(): Promise<Account[]> {
    const res = await this.callRead("invest_list_broker_accounts", { status: "ACCOUNT_STATUS_OPEN" });
    const accounts = (res?.accounts ?? []) as any[];
    return accounts.map((a) => ({
      id: String(a.id),
      name: a.name ?? "",
      type: a.type ?? "",
      accessLevel: a.accessLevel ?? "",
    }));
  }

  async getPortfolio(accountId: string): Promise<Portfolio> {
    const res = await this.callRead("invest_get_portfolio", {
      accountId,
      responseView: ["FULL"],
    });
    const positions: Position[] = ((res?.positions ?? []) as any[]).map((p) => {
      const qty = parseMoney(p.quantity);
      // prod не всегда отдаёт currentPrice — фолбэк на среднюю цену входа.
      const price = parseMoney(p.currentPrice) || parseMoney(p.averagePositionPrice);
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
    const res = await this.callRead("invest_get_orderbook", { instrumentId, depth: 1 });
    // В стакане последняя цена — lastPrice; при отсутствии берём лучшую заявку.
    const last = parseMoney(res?.lastPrice);
    if (last > 0) return last;
    const bid = parseMoney(res?.bids?.[0]?.price);
    const ask = parseMoney(res?.asks?.[0]?.price);
    if (bid && ask) return (bid + ask) / 2;
    return bid || ask || 0;
  }

  async createOrder(req: CreateOrderRequest): Promise<OrderResult> {
    const args: Record<string, unknown> = {
      accountId: req.accountId,
      instrumentId: req.instrumentId,
      quantity: req.lots,
      direction: req.side === "buy" ? "ORDER_DIRECTION_BUY" : "ORDER_DIRECTION_SELL",
      orderType:
        req.orderType === "market"
          ? "ORDER_TYPE_MARKET"
          : req.orderType === "bestprice"
            ? "ORDER_TYPE_BESTPRICE"
            : "ORDER_TYPE_LIMIT",
      confirmMarginTrade: false,
    };
    if (req.orderType === "limit" && req.price != null) {
      args.price = { value: String(req.price) };
      args.priceType = "PRICE_TYPE_CURRENCY";
    }
    const res = await this.callOnce("invest_create_order", args);
    return {
      orderId: String(res?.orderId ?? res?.orderRequestId ?? ""),
      status: String(res?.executionReportStatus ?? res?.status ?? "UNKNOWN"),
      executedRub: res?.executedOrderPrice ? parseMoney(res.executedOrderPrice) : undefined,
      raw: res,
    };
  }
}
