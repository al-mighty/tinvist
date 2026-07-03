import { TInvestMcp, extractResult } from "../mcp/client.js";
import { withRetry } from "../util/retry.js";
import type { Config } from "../config.js";

export interface InstrumentInfo {
  uid: string;
  ticker: string;
  classCode: string;
  name: string;
  lot: number;
  kind: string;
}

/**
 * Справочник инструментов через MCP invest_find_instrument. Reference-данные
 * едины для обоих контуров (UID/лот одинаковы в prod и sandbox), поэтому резолв
 * всегда идёт через MCP с prod-токеном — даже когда активна песочница.
 */
export class InstrumentResolver {
  private readonly mcp: TInvestMcp;
  private connected = false;

  constructor(cfg: Config) {
    if (!cfg.TINVEST_TOKEN_PROD) {
      throw new Error("Резолв инструментов требует TINVEST_TOKEN_PROD (справочник через MCP).");
    }
    this.mcp = new TInvestMcp(cfg.TINVEST_MCP_URL, cfg.TINVEST_TOKEN_PROD);
  }

  private async ensure(): Promise<void> {
    if (!this.connected) {
      await withRetry(() => this.mcp.connect(), { label: "resolver.connect" });
      this.connected = true;
    }
  }

  async close(): Promise<void> {
    if (this.connected) await this.mcp.close();
  }

  async find(query: string, kind?: string): Promise<InstrumentInfo[]> {
    await this.ensure();
    const args: Record<string, unknown> = {
      query,
      // instrumentKind обязателен для find_instrument. По умолчанию — акции.
      instrumentKind: kind ?? "INSTRUMENT_TYPE_SHARE",
      apiTradeAvailableFlag: true,
      responseView: ["FULL"],
    };
    const res = (await withRetry(
      async () => extractResult(await this.mcp.callTool("invest_find_instrument", args)),
      { label: "invest_find_instrument" },
    )) as any;
    return ((res?.instruments ?? []) as any[]).map((i) => ({
      uid: i.uid ?? "",
      ticker: i.ticker ?? "",
      classCode: i.classCode ?? "",
      name: i.name ?? "",
      lot: typeof i.lot === "number" ? i.lot : Number(i.lot ?? 1),
      kind: i.instrumentKind ?? "",
    }));
  }

  /** Первый торгуемый через API инструмент по запросу, либо null. */
  async resolveOne(query: string, kind?: string): Promise<InstrumentInfo | null> {
    const list = await this.find(query, kind);
    return list[0] ?? null;
  }

  /**
   * Резолв акции по UID через invest_get_share (find_instrument по UID не ищет).
   * Нужен для сопровождения позиций: prod-портфель отдаёт только instrumentUid,
   * без ticker/lot/type. null — если это не акция / не найдено.
   */
  async byUid(uid: string): Promise<InstrumentInfo | null> {
    await this.ensure();
    try {
      const res = (await withRetry(
        async () =>
          extractResult(
            await this.mcp.callTool("invest_get_share", {
              id: uid,
              idType: "INSTRUMENT_ID_TYPE_UID",
              responseView: ["FULL"],
            }),
          ),
        { label: "invest_get_share" },
      )) as any;
      const i = res?.instrument ?? res;
      if (!i?.uid) return null;
      return {
        uid: i.uid,
        ticker: i.ticker ?? "",
        classCode: i.classCode ?? "",
        name: i.name ?? "",
        lot: typeof i.lot === "number" ? i.lot : Number(i.lot ?? 1),
        kind: "INSTRUMENT_TYPE_SHARE",
      };
    } catch {
      return null; // не акция или не найдено
    }
  }
}
