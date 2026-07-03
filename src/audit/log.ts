import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Append-only аудит в JSONL. Каждая строка — одно событие жизненного цикла
 * сделки. Формат JSONL выбран сознательно: легко грепать, не портится при
 * дозаписи, парсится построчно.
 *
 * Логируем ВСЁ, что касается денег: предложение, вердикт guard-лимитов,
 * решение человека, исполнение и результат от брокера.
 */

export type AuditEventType =
  | "proposal" // стратегия/LLM предложила сделку
  | "guard" // результат проверки лимитов
  | "approval" // решение человека (approve/reject)
  | "execute" // отправка заявки брокеру (или DRY_RUN)
  | "result" // ответ брокера
  | "error";

export interface AuditEvent {
  type: AuditEventType;
  at: string; // ISO
  payload: unknown;
}

const DEFAULT_PATH = resolve(process.cwd(), "audit", "trades.jsonl");

export class AuditLog {
  constructor(private readonly filePath: string = DEFAULT_PATH) {}

  async record(type: AuditEventType, payload: unknown): Promise<void> {
    const event: AuditEvent = {
      type,
      at: new Date().toISOString(),
      payload,
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(event) + "\n", "utf8");
  }

  /**
   * Суммарный оборот отправленных сегодня заявок, руб. Считается по событиям
   * "execute" с payload.notionalRub и payload.sent=true. Нужен guard-лимиту
   * дневного оборота. Отсутствие файла — оборот 0.
   */
  async todayTurnoverRub(): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return 0;
    }
    const today = new Date().toISOString().slice(0, 10);
    let sum = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as AuditEvent;
        if (ev.type !== "execute" || !ev.at.startsWith(today)) continue;
        const p = ev.payload as { notionalRub?: number; sent?: boolean };
        if (p?.sent && typeof p.notionalRub === "number") sum += p.notionalRub;
      } catch {
        // битую строку пропускаем
      }
    }
    return sum;
  }
}
