// zodOutputFormat (Anthropic SDK) типизирован под zod v4 — используем v4-subpath
// повсеместно, чтобы одна и та же схема работала и для Anthropic, и для GigaChat.
import { z } from "zod/v4";

/**
 * Единый контракт структурированного ответа LLM-движка. Оба провайдера
 * обязаны вернуть данные в этом виде.
 */
export const LlmOutputSchema = z.object({
  marketCommentary: z.string().describe("Краткий обзор рынка и логики решений, 2-4 предложения."),
  proposals: z
    .array(
      z.object({
        ticker: z.string().describe("Тикер инструмента из watchlist."),
        side: z.enum(["buy", "sell"]),
        orderType: z.enum(["market", "limit"]),
        lots: z.number().int().describe("Количество лотов, целое > 0."),
        // market-заявки часто приходят без limitPrice — дефолт null.
        limitPrice: z.number().nullable().default(null).describe("Цена для limit-заявки, иначе null."),
        confidence: z.number().describe("Уверенность 0..1."),
        rationale: z.string().describe("Обоснование сделки."),
      }),
    )
    .describe("Предложения сделок. Пустой массив — если хороших идей нет."),
});

export type LlmOutput = z.infer<typeof LlmOutputSchema>;
