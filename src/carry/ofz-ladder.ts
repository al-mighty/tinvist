import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Config } from "../config.js";
import type { MarketData } from "../instruments/marketdata.js";

export interface Rung {
  uid: string;
  ticker: string;
  maturityDate: string;
  nominalRub: number;
}

const CACHE_PATH = resolve(process.cwd(), "data", "ofz-ladder.json");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // неделя
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Все инструменты карри (cash-equivalent): фонд LQDT + ступени лестницы ОФЗ
 * (из кэша). Их нужно исключать из сопровождения стратегией и из риск-экспозиции.
 */
export async function carryUids(cfg: Config): Promise<Set<string>> {
  const set = new Set<string>([cfg.CARRY_UID]);
  if (cfg.CARRY_MODE === "ofz") {
    try {
      const c = JSON.parse(await readFile(CACHE_PATH, "utf8")) as { rungs?: Rung[] };
      for (const r of c.rungs ?? []) set.add(r.uid);
    } catch {
      // кэш ещё не построен — исключаем хотя бы фонд
    }
  }
  return set;
}

/**
 * Лестница ОФЗ: набор фикс-купонных ОФЗ-ПД (серия 26xxx) со ступенчатыми
 * сроками погашения. Паркуем избыток кэша, докупая самую «недовесную» ступень —
 * так лестница заполняется равномерно, а погашения возвращают кэш регулярно.
 */
export class OfzLadder {
  constructor(
    private readonly cfg: Config,
    private readonly market: MarketData,
  ) {}

  /** Ступени лестницы (из кэша или заново собрать по кривой погашений). */
  async ensureLadder(nowMs: number): Promise<Rung[]> {
    const cached = await this.readCache(nowMs);
    if (cached) return cached;

    // Кандидаты — только ОФЗ-ПД (фикс-купон, серия 26xxx).
    const all = await this.market.listBondsBase();
    const candidates = all.filter((b) => /^ОФЗ\s*26\d/.test(b.name));
    const details: Rung[] = [];
    for (const c of candidates) {
      const d = await this.market.bondDetail(c.uid).catch(() => null);
      if (!d || d.floating || d.currency !== "rub" || !d.maturityDate) continue;
      if (Date.parse(d.maturityDate) <= nowMs) continue; // уже погашена
      details.push({ uid: d.uid, ticker: d.ticker, maturityDate: d.maturityDate, nominalRub: d.nominalRub });
    }
    if (details.length === 0) return [];

    // Ступени: ближайшие к целевым срокам 1..N лет.
    const rungs: Rung[] = [];
    const used = new Set<string>();
    for (let y = 1; y <= this.cfg.OFZ_LADDER_RUNGS; y++) {
      const targetMs = nowMs + y * YEAR_MS;
      let best: Rung | null = null;
      let bestDist = Infinity;
      for (const d of details) {
        if (used.has(d.uid)) continue;
        const dist = Math.abs(Date.parse(d.maturityDate) - targetMs);
        if (dist < bestDist) {
          bestDist = dist;
          best = d;
        }
      }
      if (best) {
        used.add(best.uid);
        rungs.push(best);
      }
    }
    rungs.sort((a, b) => a.maturityDate.localeCompare(b.maturityDate));
    await this.writeCache(rungs, nowMs);
    return rungs;
  }

  /** Ступень с наименьшим текущим держанием (докупаем недовес). */
  selectUnderweightRung(rungs: Rung[], heldLotsByUid: Map<string, number>): Rung {
    let pick = rungs[0]!;
    let min = heldLotsByUid.get(pick.uid) ?? 0;
    for (const r of rungs) {
      const held = heldLotsByUid.get(r.uid) ?? 0;
      if (held < min) {
        min = held;
        pick = r;
      }
    }
    return pick;
  }

  private async readCache(nowMs: number): Promise<Rung[] | null> {
    try {
      const c = JSON.parse(await readFile(CACHE_PATH, "utf8")) as { builtAt: number; rungs: Rung[] };
      if (c.rungs?.length && nowMs - c.builtAt < CACHE_TTL_MS) return c.rungs;
    } catch {
      // нет кэша / протух
    }
    return null;
  }

  private async writeCache(rungs: Rung[], nowMs: number): Promise<void> {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify({ builtAt: nowMs, rungs }), "utf8");
  }
}
