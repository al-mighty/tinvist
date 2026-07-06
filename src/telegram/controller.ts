import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Config } from "../config.js";
import { describeProposal } from "../strategy/types.js";
import { withRetry } from "../util/retry.js";
import type { Approver, ApprovalRequest } from "../approval/types.js";

const STATE_PATH = resolve(process.cwd(), "data", "control.json");

interface ControlState {
  paused: boolean;
  strategyEnabled: boolean;
}

interface Pending {
  approveData: string;
  rejectData: string;
  resolve: (v: boolean) => void;
}

/**
 * Единый Telegram-пульт: ОДИН потребитель getUpdates, который роутит и
 * кнопки-команды (статус/пауза/сводка/режим), и колбэки подтверждения (✅/❌).
 * Подтверждение не поллит само — регистрирует ожидание, диспетчер резолвит.
 * Так два поллера не конфликтуют на одном боте.
 */
export class TelegramController implements Approver {
  private readonly base: string;
  private readonly chatId: string;
  private offset: number | undefined;
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private state: ControlState;

  constructor(
    private readonly cfg: Config,
    /** Строит текст сводки/статуса по запросу. */
    private readonly statusFn: () => Promise<string>,
    private readonly approvalTimeoutMs = cfg.APPROVAL_TIMEOUT_SEC * 1000,
  ) {
    if (!cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_APPROVER_CHAT_ID) {
      throw new Error("Telegram-пульт требует TELEGRAM_BOT_TOKEN и TELEGRAM_APPROVER_CHAT_ID");
    }
    this.base = `https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}`;
    this.chatId = cfg.TELEGRAM_APPROVER_CHAT_ID;
    this.state = { paused: false, strategyEnabled: cfg.STRATEGY_ENABLED };
  }

  isPaused(): boolean {
    return this.state.paused;
  }
  isStrategyEnabled(): boolean {
    return this.state.strategyEnabled;
  }

  async start(): Promise<void> {
    await this.loadState();
    await this.setCommands();
    await this.sendMenu("Пульт tinvist запущен.");
    // Единый цикл опроса — в фоне, параллельно тикам.
    this.loopPromise = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.loopPromise) await this.loopPromise.catch(() => {});
  }

  // ── Approver: подтверждение сделки ──────────────────────────────
  async requestApproval(req: ApprovalRequest): Promise<boolean> {
    const nonce = randomUUID().slice(0, 8);
    const approveData = `ok:${nonce}`;
    const rejectData = `no:${nonce}`;
    const sent = await this.api("sendMessage", {
      chat_id: this.chatId,
      text: this.renderApproval(req),
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Подтвердить", callback_data: approveData },
            { text: "❌ Отклонить", callback_data: rejectData },
          ],
        ],
      },
    }).catch(() => null);
    const messageId = sent?.result?.message_id as number | undefined;

    const decision = await new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        resolvePromise(false); // таймаут → безопасный отказ
      }, this.approvalTimeoutMs);
      this.pending.set(nonce, {
        approveData,
        rejectData,
        resolve: (v) => {
          clearTimeout(timer);
          this.pending.delete(nonce);
          resolvePromise(v);
        },
      });
    });

    if (messageId) {
      const verdict = decision ? "✅ Подтверждено" : "❌ Отклонено / истекло";
      await this.api("editMessageText", {
        chat_id: this.chatId,
        message_id: messageId,
        text: `${this.renderApproval(req)}\n\n${verdict}`,
      }).catch(() => {});
    }
    return decision;
  }

  // ── Единый цикл опроса ──────────────────────────────────────────
  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      let res: any;
      try {
        res = await this.api("getUpdates", {
          offset: this.offset,
          timeout: 20,
          allowed_updates: ["message", "callback_query"],
        });
      } catch {
        await sleep(1500);
        continue;
      }
      for (const u of (res?.result ?? []) as any[]) {
        this.offset = u.update_id + 1;
        try {
          if (u.callback_query) await this.onCallback(u.callback_query);
          else if (u.message?.text) await this.onText(String(u.message.text));
        } catch {
          // не роняем диспетчер на одной ошибке
        }
      }
    }
  }

  private async onCallback(cq: any): Promise<void> {
    if (String(cq.message?.chat?.id) !== this.chatId || !cq.data) return;
    for (const [, p] of this.pending) {
      if (cq.data === p.approveData || cq.data === p.rejectData) {
        await this.api("answerCallbackQuery", {
          callback_query_id: cq.id,
          text: cq.data === p.approveData ? "Подтверждено" : "Отклонено",
        }).catch(() => {});
        p.resolve(cq.data === p.approveData);
        return;
      }
    }
    // неизвестный колбэк (старая карточка) — просто закрываем «часики»
    await this.api("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
  }

  private async onText(text: string): Promise<void> {
    const t = text.trim();
    if (t === "📊 Статус" || t === "/status") {
      await this.reply(await this.statusFn());
    } else if (t === "🗓 Сводка" || t === "/report") {
      await this.reply(`🗓 Сводка (по запросу)\n\n${await this.statusFn()}`);
    } else if (t === "⏸ Пауза" || t === "/pause") {
      await this.setState({ paused: true });
      await this.sendMenu("⏸ Торговля на паузе. Карри/мониторинг продолжаются, сводка приходит.");
    } else if (t === "▶️ Старт" || t === "/resume") {
      await this.setState({ paused: false });
      await this.sendMenu("▶️ Торговля возобновлена.");
    } else if (t.startsWith("🔄") || t === "/mode") {
      await this.setState({ strategyEnabled: !this.state.strategyEnabled });
      await this.sendMenu(
        this.state.strategyEnabled ? "🔄 Режим: КОМБО (стратегия + карри)." : "🔄 Режим: ТОЛЬКО КАРРИ (без спекулятивных входов).",
      );
    } else if (t === "/start") {
      await this.sendMenu("Пульт tinvist.");
    }
  }

  // ── Вспомогательное ─────────────────────────────────────────────
  private menuKeyboard() {
    return {
      keyboard: [
        ["📊 Статус", "🗓 Сводка"],
        [this.state.paused ? "▶️ Старт" : "⏸ Пауза", this.state.strategyEnabled ? "🔄 Только карри" : "🔄 Комбо"],
      ],
      resize_keyboard: true,
      is_persistent: true,
    };
  }

  private async sendMenu(text: string): Promise<void> {
    const mode = this.state.strategyEnabled ? "комбо" : "только карри";
    const status = this.state.paused ? "⏸ пауза" : "▶️ активна";
    await this.api("sendMessage", {
      chat_id: this.chatId,
      text: `${text}\n\nТорговля: ${status} · режим: ${mode}`,
      reply_markup: this.menuKeyboard(),
    }).catch(() => {});
  }

  private async reply(text: string): Promise<void> {
    await this.api("sendMessage", { chat_id: this.chatId, text }).catch(() => {});
  }

  private async setCommands(): Promise<void> {
    await this.api("setMyCommands", {
      commands: [
        { command: "status", description: "Статус: капитал, позиции, P&L" },
        { command: "report", description: "Сводка сейчас" },
        { command: "pause", description: "Пауза торговли" },
        { command: "resume", description: "Возобновить торговлю" },
        { command: "mode", description: "Переключить карри/комбо" },
      ],
    }).catch(() => {});
  }

  private renderApproval(req: ApprovalRequest): string {
    const { proposal, guard } = req;
    const lines = [
      "📊 ПРЕДЛОЖЕНИЕ СДЕЛКИ",
      describeProposal(proposal),
      `Обоснование: ${proposal.rationale}`,
      `Контур: ${req.backendKind}`,
    ];
    if (guard.warnings.length) lines.push("⚠ " + guard.warnings.join("; "));
    lines.push(
      req.willSend && req.backendKind === "prod"
        ? `🔴 РЕЖИМ: ${req.sendMode}`
        : `Режим: ${req.willSend ? req.sendMode : "DRY-RUN (не отправляется)"}`,
    );
    return lines.join("\n");
  }

  private async loadState(): Promise<void> {
    try {
      const st = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<ControlState>;
      this.state = {
        paused: st.paused ?? false,
        strategyEnabled: st.strategyEnabled ?? this.cfg.STRATEGY_ENABLED,
      };
    } catch {
      // нет файла — дефолт из конфига
    }
  }

  private async setState(patch: Partial<ControlState>): Promise<void> {
    this.state = { ...this.state, ...patch };
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(this.state), "utf8");
  }

  private async api(method: string, body: Record<string, unknown>): Promise<any> {
    const res = await withRetry(
      () =>
        fetch(`${this.base}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      { label: `tg.${method}` },
    );
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok === false) throw new Error(`Telegram ${method}: ${JSON.stringify(json)}`);
    return json;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
