import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { describeProposal } from "../strategy/types.js";
import { withRetry } from "../util/retry.js";
import type { Approver, ApprovalRequest } from "./types.js";

/**
 * Подтверждение сделки через Telegram inline-кнопки.
 *
 * Отправляет карточку предложения в чат аппрувера и long-polling'ом ждёт
 * нажатия «Подтвердить»/«Отклонить». По истечении таймаута — безопасный
 * отказ (сделка не исполняется). Работает на чистом Bot API через getUpdates,
 * поэтому у бота НЕ должен быть установлен webhook (иначе getUpdates → 409).
 */
export class TelegramApprover implements Approver {
  private readonly base: string;
  private readonly chatId: string;
  private readonly timeoutMs: number;

  constructor(cfg: Config, timeoutMs = 300_000) {
    if (!cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_APPROVER_CHAT_ID) {
      throw new Error("Telegram-подтверждение требует TELEGRAM_BOT_TOKEN и TELEGRAM_APPROVER_CHAT_ID");
    }
    this.base = `https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}`;
    this.chatId = cfg.TELEGRAM_APPROVER_CHAT_ID;
    this.timeoutMs = timeoutMs;
  }

  async requestApproval(req: ApprovalRequest): Promise<boolean> {
    const nonce = randomUUID().slice(0, 8);
    const approveData = `ok:${nonce}`;
    const rejectData = `no:${nonce}`;

    const sent = await this.api("sendMessage", {
      chat_id: this.chatId,
      text: this.renderText(req),
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Подтвердить", callback_data: approveData },
            { text: "❌ Отклонить", callback_data: rejectData },
          ],
        ],
      },
    });
    const messageId = sent?.result?.message_id as number | undefined;

    const decision = await this.waitForDecision(approveData, rejectData);

    // Обновляем сообщение итогом и убираем кнопки.
    if (messageId) {
      const verdict =
        decision === "approve" ? "✅ Подтверждено" : decision === "reject" ? "❌ Отклонено" : "⏳ Время истекло — отклонено";
      await this.api("editMessageText", {
        chat_id: this.chatId,
        message_id: messageId,
        text: `${this.renderText(req)}\n\n${verdict}`,
      }).catch(() => {});
    }

    return decision === "approve";
  }

  private renderText(req: ApprovalRequest): string {
    const { proposal, guard } = req;
    const lines = [
      "📊 ПРЕДЛОЖЕНИЕ СДЕЛКИ",
      describeProposal(proposal),
      `Обоснование: ${proposal.rationale}`,
      `Контур: ${req.backendKind}`,
    ];
    if (guard.warnings.length) {
      lines.push("⚠ " + guard.warnings.join("; "));
    }
    lines.push(
      req.willSend && req.backendKind === "prod"
        ? `🔴 РЕЖИМ: ${req.sendMode}`
        : `Режим: ${req.willSend ? req.sendMode : "DRY-RUN (не отправляется)"}`,
    );
    return lines.join("\n");
  }

  /** Long-polling getUpdates до решения или таймаута. */
  private async waitForDecision(
    approveData: string,
    rejectData: string,
  ): Promise<"approve" | "reject" | "timeout"> {
    const deadline = Date.now() + this.timeoutMs;
    let offset: number | undefined;

    while (Date.now() < deadline) {
      // Транзиентный сбой опроса НЕ должен ронять ожидание — карточка уже
      // отправлена, кнопки живы; просто продолжаем поллинг до дедлайна.
      let res: any;
      try {
        res = await this.api("getUpdates", {
          offset,
          timeout: 20,
          allowed_updates: ["callback_query"],
        });
      } catch {
        await sleep(1500);
        continue;
      }
      const updates = (res?.result ?? []) as any[];
      for (const u of updates) {
        offset = u.update_id + 1;
        const cq = u.callback_query;
        if (!cq?.data) continue;
        if (String(cq.message?.chat?.id) !== this.chatId) continue;

        if (cq.data === approveData || cq.data === rejectData) {
          await this.api("answerCallbackQuery", {
            callback_query_id: cq.id,
            text: cq.data === approveData ? "Подтверждено" : "Отклонено",
          }).catch(() => {});
          return cq.data === approveData ? "approve" : "reject";
        }
      }
    }
    return "timeout";
  }

  private async api(method: string, body: Record<string, unknown>): Promise<any> {
    // getUpdates держит соединение до 25с — тайм-аут запроса делаем с запасом.
    const res = await withRetry(
      () =>
        fetch(`${this.base}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      { label: `telegram.${method}` },
    );
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || (json && json.ok === false)) {
      throw new Error(`Telegram ${method} ошибка: ${JSON.stringify(json)}`);
    }
    return json;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
