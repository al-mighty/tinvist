import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Персистентный «пик капитала» (high-water mark) по счетам — основа
 * drawdown kill-switch. Храним максимум наблюдавшегося equity, чтобы считать
 * просадку от пика между запусками.
 */
const DEFAULT_PATH = resolve(process.cwd(), "data", "equity-hwm.json");

type HwmMap = Record<string, number>;

export class EquityState {
  constructor(private readonly filePath: string = DEFAULT_PATH) {}

  private async read(): Promise<HwmMap> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as HwmMap;
    } catch {
      return {};
    }
  }

  /**
   * Обновляет HWM для счёта текущим equity и возвращает пик и просадку.
   * drawdownPct = (peak − equity) / peak · 100 (0, если на пике или выше).
   */
  async observe(accountId: string, equityRub: number): Promise<{ peak: number; drawdownPct: number }> {
    const map = await this.read();
    const prevPeak = map[accountId] ?? 0;
    const peak = Math.max(prevPeak, equityRub);
    if (peak !== prevPeak) {
      map[accountId] = peak;
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(map, null, 2), "utf8");
    }
    const drawdownPct = peak > 0 ? ((peak - equityRub) / peak) * 100 : 0;
    return { peak, drawdownPct };
  }
}
