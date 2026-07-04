import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Config } from "../config.js";
import { withRetry } from "../util/retry.js";

/**
 * Простое уведомление в Telegram (sendMessage без кнопок) — для ежедневной
 * сводки. Использует тот же бот/чат, что и подтверждение.
 */
export async function sendTelegram(cfg: Config, text: string): Promise<void> {
  if (!cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_APPROVER_CHAT_ID) {
    throw new Error("Telegram-уведомление требует TELEGRAM_BOT_TOKEN и TELEGRAM_APPROVER_CHAT_ID");
  }
  await withRetry(
    () =>
      fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.TELEGRAM_APPROVER_CHAT_ID, text }),
      }),
    { label: "telegram.report" },
  );
}

const STATE_PATH = resolve(process.cwd(), "data", "report-state.json");

/** Уже отправляли сводку за указанную дату (YYYY-MM-DD)? */
export async function reportSentFor(date: string): Promise<boolean> {
  try {
    const st = JSON.parse(await readFile(STATE_PATH, "utf8")) as { lastReportDate?: string };
    return st.lastReportDate === date;
  } catch {
    return false;
  }
}

export async function markReportSent(date: string): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify({ lastReportDate: date }), "utf8");
}
