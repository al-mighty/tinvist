import type { Config } from "./config.js";
import type { TradingBackend } from "./backends/types.js";
import { runRsiCycle } from "./strategy/run.js";

/**
 * Встроенный планировщик: периодически гоняет стратегию, чтобы входы/выходы,
 * стопы и kill-switch проверялись регулярно, а не только по ручному запуску.
 * Устойчив к сбоям (ошибка цикла не роняет петлю), уважает часы биржи,
 * останавливается по SIGINT/SIGTERM.
 */
export async function runLoop(
  cfg: Config,
  backend: TradingBackend,
  accountId: string,
  watchlist: string[],
): Promise<void> {
  let stop = false;
  const onStop = () => {
    console.log("\nОстановка планировщика…");
    stop = true;
  };
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);

  console.log(
    `Планировщик запущен: каждые ${cfg.LOOP_INTERVAL_SEC}с, watchlist ${watchlist.join(",")}, счёт ${accountId}.\n` +
      `Часы биржи: ${cfg.LOOP_MARKET_HOURS_ONLY ? `${cfg.LOOP_START_HOUR_MSK}:00–${cfg.LOOP_END_HOUR_MSK}:00 МСК, будни` : "круглосуточно"}.` +
      (cfg.LOOP_MAX_TICKS > 0 ? ` Лимит тиков: ${cfg.LOOP_MAX_TICKS}.` : ""),
  );

  let tick = 0;
  while (!stop) {
    tick++;
    const now = new Date();
    const ts = now.toISOString();

    if (cfg.LOOP_MARKET_HOURS_ONLY && !isMarketOpen(now, cfg)) {
      console.log(`[${ts}] тик ${tick}: биржа закрыта — пропуск.`);
    } else {
      console.log(`\n──── [${ts}] тик ${tick} ────`);
      try {
        await runRsiCycle(cfg, backend, accountId, watchlist);
      } catch (err) {
        // Сбой цикла (сеть/данные) не должен ронять планировщик.
        console.error(`[${ts}] ошибка цикла: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (cfg.LOOP_MAX_TICKS > 0 && tick >= cfg.LOOP_MAX_TICKS) {
      console.log(`Достигнут лимит тиков (${cfg.LOOP_MAX_TICKS}) — выход.`);
      break;
    }
    // Джиттер: разброс интервала, чтобы не быть предсказуемым и не гердиться
    // с другими ботами на одинаковых «ровных» тиках.
    const jitterMs = Math.floor(Math.random() * cfg.LOOP_JITTER_SEC * 1000);
    const sleepMs = cfg.LOOP_INTERVAL_SEC * 1000 + jitterMs;
    console.log(`Следующий тик через ${Math.round(sleepMs / 1000)}с (базовый ${cfg.LOOP_INTERVAL_SEC} + джиттер ${Math.round(jitterMs / 1000)}).`);
    await interruptibleSleep(sleepMs, () => stop);
  }
}

/** Открыта ли биржа: будни и час в окне [start, end) по МСК (UTC+3). */
function isMarketOpen(now: Date, cfg: Config): boolean {
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const weekday = msk.getUTCDay(); // 0=вс, 6=сб (для сдвинутой на МСК даты)
  if (weekday === 0 || weekday === 6) return false;
  const hour = msk.getUTCHours();
  return hour >= cfg.LOOP_START_HOUR_MSK && hour < cfg.LOOP_END_HOUR_MSK;
}

/** Сон с ранним выходом по флагу остановки (проверка раз в секунду). */
async function interruptibleSleep(ms: number, stopped: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !stopped()) {
    await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
  }
}
