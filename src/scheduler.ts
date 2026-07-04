import type { Config } from "./config.js";
import type { TradingBackend } from "./backends/types.js";
import { runRsiCycle } from "./strategy/run.js";
import { buildStatusReport } from "./report/status.js";
import { sendTelegram, reportSentFor, markReportSent } from "./report/notify.js";
import { TelegramController } from "./telegram/controller.js";

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

  // Алерты о фатальных сбоях: шлём в Telegram и падаем (docker перезапустит).
  const fatal = (kind: string) => (err: unknown) => {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    console.error(`FATAL ${kind}: ${msg}`);
    if (cfg.ALERT_ENABLED) {
      sendTelegram(cfg, `🚨 tinvist УПАЛ (${kind}):\n${msg.slice(0, 500)}`)
        .catch(() => {})
        .finally(() => process.exit(1));
    } else {
      process.exit(1);
    }
  };
  process.once("uncaughtException", fatal("uncaughtException"));
  process.once("unhandledRejection", fatal("unhandledRejection"));

  // Telegram-пульт: единый диспетчер апдейтов (кнопки + подтверждения).
  // Поднимаем только для telegram-канала; он же служит approver'ом.
  let controller: TelegramController | null = null;
  if (cfg.APPROVAL_CHANNEL === "telegram") {
    controller = new TelegramController(cfg, () => buildStatusReport(cfg, backend, accountId));
    await controller.start().catch((e) => console.error(`пульт не поднялся: ${e?.message ?? e}`));
  }

  console.log(
    `Планировщик запущен: каждые ${cfg.LOOP_INTERVAL_SEC}с, watchlist ${watchlist.join(",")}, счёт ${accountId}.\n` +
      `Окно: ${cfg.LOOP_MARKET_HOURS_ONLY ? `${cfg.LOOP_START_HOUR_MSK}:00–${cfg.LOOP_END_HOUR_MSK}:00 МСК (вкл. выходные; торгуемость — по статусу биржи)` : "круглосуточно"}.` +
      (cfg.LOOP_MAX_TICKS > 0 ? ` Лимит тиков: ${cfg.LOOP_MAX_TICKS}.` : ""),
  );

  let tick = 0;
  let consecutiveFailures = 0;
  let alerted = false;
  while (!stop) {
    tick++;
    const now = new Date();
    const ts = now.toISOString();

    if (controller?.isPaused()) {
      console.log(`[${ts}] тик ${tick}: торговля на паузе (пульт) — пропуск.`);
    } else if (cfg.LOOP_MARKET_HOURS_ONLY && !isMarketOpen(now, cfg)) {
      console.log(`[${ts}] тик ${tick}: биржа закрыта — пропуск.`);
    } else {
      console.log(`\n──── [${ts}] тик ${tick} ────`);
      try {
        await runRsiCycle(cfg, backend, accountId, watchlist, {
          approver: controller ?? undefined,
          strategyEnabled: controller?.isStrategyEnabled(),
        });
        // Успех: если ранее алертили — сообщаем о восстановлении.
        if (alerted) {
          await sendTelegram(cfg, "✅ tinvist: работа восстановлена (цикл снова проходит).").catch(() => {});
          alerted = false;
        }
        consecutiveFailures = 0;
      } catch (err) {
        // Сбой цикла (сеть/данные) не должен ронять планировщик.
        const emsg = err instanceof Error ? err.message : String(err);
        console.error(`[${ts}] ошибка цикла: ${emsg}`);
        consecutiveFailures++;
        // Алерт при N ошибках подряд — один раз, до восстановления.
        if (cfg.ALERT_ENABLED && !alerted && consecutiveFailures >= cfg.ALERT_AFTER_FAILURES) {
          await sendTelegram(
            cfg,
            `🚨 tinvist: ${consecutiveFailures} ошибок цикла подряд.\nПоследняя: ${emsg.slice(0, 400)}`,
          ).catch(() => {});
          alerted = true;
        }
      }
    }

    // Ежедневная сводка в Telegram (раз в день после REPORT_HOUR_MSK).
    if (cfg.DAILY_REPORT_ENABLED) {
      try {
        await maybeSendDailyReport(cfg, backend, accountId, now);
      } catch (err) {
        console.error(`[${ts}] ошибка сводки: ${err instanceof Error ? err.message : err}`);
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
  await controller?.stop();
}

/** Отправляет ежедневную сводку один раз в день после REPORT_HOUR_MSK. */
async function maybeSendDailyReport(
  cfg: Config,
  backend: TradingBackend,
  accountId: string,
  now: Date,
): Promise<void> {
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const date = msk.toISOString().slice(0, 10);
  if (msk.getUTCHours() < cfg.REPORT_HOUR_MSK) return;
  if (await reportSentFor(date)) return;
  const report = await buildStatusReport(cfg, backend, accountId);
  await sendTelegram(cfg, `🗓 Ежедневная сводка\n\n${report}`);
  await markReportSent(date);
  console.log(`Ежедневная сводка отправлена (${date}).`);
}

/**
 * Грубый фильтр по часам МСК (UTC+3) — чтобы не гонять цикл глубокой ночью.
 * Выходные НЕ блокируем: торги выходного дня разрешены, а реальную торгуемость
 * каждого инструмента проверяет статус-гейт в стратегии (invest_get_trading_statuses).
 */
function isMarketOpen(now: Date, cfg: Config): boolean {
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
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
