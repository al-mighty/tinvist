import type { Account, CreateOrderRequest, OrderResult, Portfolio } from "../domain.js";

/**
 * Абстракция торгового контура. Две реализации:
 *  - MCP (prod)      — реальный счёт через T-Bank Invest MCP;
 *  - REST Sandbox    — песочница через T-Invest REST SandboxService.
 *
 * Логика выше пишется против этого интерфейса и не знает, какой контур
 * активен. Это позволяет отлаживать исполнение в песочнице и переключаться
 * на боевой контур сменой одной переменной BACKEND.
 */
export interface TradingBackend {
  readonly kind: "sandbox" | "prod";

  connect(): Promise<void>;
  close(): Promise<void>;

  listAccounts(): Promise<Account[]>;
  getPortfolio(accountId: string): Promise<Portfolio>;
  /** Последняя цена инструмента (UID) в валюте инструмента. */
  getLastPrice(instrumentId: string): Promise<number>;

  /**
   * Отправить заявку брокеру. Вызывать ТОЛЬКО после guard-проверок и
   * подтверждения человеком. В песочнице деньги ненастоящие; в prod — реальные.
   */
  createOrder(req: CreateOrderRequest): Promise<OrderResult>;
}
