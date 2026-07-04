import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const HISTORY_PATH = resolve(process.cwd(), "data", "equity-history.jsonl");

export interface EquityPoint {
  accountId: string;
  date: string; // YYYY-MM-DD (МСК)
  equity: number;
}

/**
 * Дневные снапшоты капитала (append-only JSONL). Один пункт на дату на счёт —
 * основа для кривой эквити, доходности и сравнения с бенчмарком.
 */
export class EquityHistory {
  constructor(private readonly filePath: string = HISTORY_PATH) {}

  async load(accountId: string): Promise<EquityPoint[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }
    const points: EquityPoint[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as EquityPoint;
        if (p.accountId === accountId && typeof p.equity === "number") points.push(p);
      } catch {
        // битую строку пропускаем
      }
    }
    // Дедуп по дате: берём последний снапшот за день.
    const byDate = new Map<string, EquityPoint>();
    for (const p of points) byDate.set(p.date, p);
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Записать снапшот за сегодня (МСК), если за эту дату его ещё не было. */
  async snapshot(accountId: string, equity: number, nowMs: number): Promise<void> {
    if (!(equity > 0)) return;
    const date = new Date(nowMs + 3 * 60 * 60 * 1000).toISOString().slice(0, 10); // МСК
    const existing = await this.load(accountId);
    if (existing.some((p) => p.date === date)) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify({ accountId, date, equity } satisfies EquityPoint) + "\n", "utf8");
  }
}
