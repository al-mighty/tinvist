import type { Config } from "../config.js";
import type { TradingBackend } from "../backends/types.js";
import { InstrumentResolver } from "../instruments/resolve.js";
import { MarketData } from "../instruments/marketdata.js";
import { createLLM } from "../llm/factory.js";
import { fmtRub } from "../domain.js";
import type { TradeProposal } from "./types.js";

export interface ProposalResult {
  proposals: TradeProposal[];
  commentary: string;
}

const SYSTEM_PROMPT = `Ты — дисциплинированный ассистент-аналитик для торговли на Мосбирже.
Тебе дают состояние портфеля и рыночный снимок по watchlist. Твоя задача — предложить
0..N сделок в структурированном виде. Правила:
- Предлагай сделку ТОЛЬКО при явном обосновании (тренд, откат, ребалансировка, риск).
- Уважай доступный кэш: сумма покупок не должна превышать свободные деньги.
- Учитывай, что каждая сделка проходит guard-лимиты и подтверждение человеком — не гонись за объёмом.
- Если хороших идей нет — верни пустой массив proposals. Это нормально и предпочтительно.
- confidence — честная оценка 0..1. Низкая уверенность лучше выдуманной.
- Все цены и суммы в рублях. Не выдумывай данные, которых нет в снимке.`;

/**
 * Движок предложений: собирает рыночный контекст, спрашивает Claude,
 * возвращает структурированные TradeProposal. НЕ исполняет — только предлагает.
 */
export class ProposalEngine {
  constructor(
    private readonly cfg: Config,
    private readonly backend: TradingBackend,
  ) {}

  async propose(watchlist: string[], accountId: string): Promise<ProposalResult> {
    // Провайдер выбирается по LLM_PROVIDER; конструктор упадёт рано, если нет ключа.
    const llm = createLLM(this.cfg);

    const resolver = new InstrumentResolver(this.cfg);
    const market = new MarketData(this.cfg);

    // key = ticker (верхний регистр), value = справка об инструменте
    const instruments = new Map<string, Awaited<ReturnType<InstrumentResolver["resolveOne"]>>>();
    let contextText: string;

    try {
      const portfolio = await this.backend.getPortfolio(accountId);

      const lines: string[] = [];
      lines.push(`Контур: ${this.backend.kind}`);
      lines.push(`Портфель ${accountId}: итого ${fmtRub(portfolio.totalValueRub)}`);
      const cash = portfolio.positions
        .filter((p) => p.instrumentType === "currency")
        .reduce((s, p) => s + p.valueRub, 0);
      lines.push(`Свободный кэш ≈ ${fmtRub(cash)}`);
      lines.push("Позиции:");
      for (const p of portfolio.positions) {
        lines.push(`  ${p.ticker ?? p.instrumentId} [${p.instrumentType}] ${p.quantity} шт ≈ ${fmtRub(p.valueRub)}`);
      }

      lines.push("\nWatchlist:");
      for (const query of watchlist) {
        const info = await resolver.resolveOne(query);
        if (!info) {
          lines.push(`  ${query}: не найден`);
          continue;
        }
        instruments.set(info.ticker.toUpperCase(), info);
        const price = await this.backend.getLastPrice(info.uid);
        const candles = await market.dailyCandles(info.uid, 30).catch(() => null);
        const trend = candles
          ? `30д: ${candles.first}→${candles.last} (min ${candles.min}, max ${candles.max})`
          : "нет истории";
        lines.push(`  ${info.ticker} (${info.name}) лот ${info.lot}: цена ${price}; ${trend}`);
      }

      contextText = lines.join("\n");
    } finally {
      await resolver.close();
      await market.close();
    }

    // Структурированный запрос к выбранному LLM-провайдеру.
    const out = await llm.generate(
      SYSTEM_PROMPT,
      `Рыночный снимок:\n\n${contextText}\n\nПредложи сделки (или пустой список).`,
    );

    const now = new Date().toISOString();
    const proposals: TradeProposal[] = [];
    for (const d of out.proposals) {
      const info = instruments.get(d.ticker.toUpperCase());
      if (!info) continue; // модель назвала инструмент вне watchlist — игнорируем
      if (!Number.isInteger(d.lots) || d.lots <= 0) continue;
      const price = d.orderType === "limit" && d.limitPrice ? d.limitPrice : await this.backend.getLastPrice(info.uid);
      proposals.push({
        instrument: info.uid,
        instrumentName: `${info.ticker} · ${info.name}`,
        side: d.side,
        orderType: d.orderType,
        lots: d.lots,
        price,
        lotSize: info.lot,
        rationale: d.rationale,
        confidence: d.confidence,
        createdAt: now,
      });
    }

    return { proposals, commentary: out.marketCommentary };
  }
}
