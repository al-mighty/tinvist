import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

/**
 * Схема окружения. Валидируется один раз при старте — падаем рано и понятно,
 * а не в середине торговой сессии.
 */
const EnvSchema = z.object({
  // T-Invest endpoints
  TINVEST_MCP_URL: z.string().url().default("https://invest-public-api.tbank.ru/mcp"),
  TINVEST_REST_URL: z.string().url().default("https://invest-public-api.tbank.ru/rest"),

  // Токены. Нужен тот, что соответствует активному BACKEND.
  TINVEST_TOKEN_SANDBOX: z.string().optional(),
  TINVEST_TOKEN_PROD: z.string().optional(),

  // Активный контур.
  BACKEND: z.enum(["sandbox", "prod"]).default("sandbox"),

  // LLM — провайдер движка предложений
  LLM_PROVIDER: z.enum(["anthropic", "gigachat"]).default("gigachat"),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("claude-opus-4-8"),

  // Sber GigaChat
  GIGACHAT_AUTH_KEY: z.string().optional(),
  GIGACHAT_SCOPE: z.string().default("GIGACHAT_API_PERS"),
  GIGACHAT_MODEL: z.string().default("GigaChat"),
  GIGACHAT_OAUTH_URL: z.string().url().default("https://ngw.devices.sberbank.ru:9443/api/v2/oauth"),
  GIGACHAT_API_URL: z.string().url().default("https://gigachat.devices.sberbank.ru/api/v1"),

  // Безопасность
  DRY_RUN: bool(true),
  ALLOW_REAL_TRADING: bool(false),
  // Гейт прибыльности (окупаемость по комиссии)
  COMMISSION_PCT: z.coerce.number().default(0.3), // комиссия за сторону, % (Инвестор=0.3, Трейдер=0.04)
  SLIPPAGE_PCT: z.coerce.number().default(0.1), // буфер на спред/проскальзывание, %
  MIN_NET_EDGE_RATIO: z.coerce.number().default(1.5), // тейк должен быть ≥ издержки × это

  MAX_ORDER_RUB: z.coerce.number().positive().default(10_000),
  MAX_POSITION_SHARE: z.coerce.number().min(0).max(1).default(0.25),
  MAX_DAILY_TURNOVER_RUB: z.coerce.number().positive().default(50_000),

  // Сохранение капитала (применяется к покупкам)
  MAX_DRAWDOWN_PCT: z.coerce.number().default(15), // просадка от пика → стоп новых покупок (0 = выкл)
  EQUITY_FLOOR_RUB: z.coerce.number().default(0), // ниже этого капитала покупки запрещены (0 = выкл)
  MAX_TOTAL_EXPOSURE_PCT: z.coerce.number().min(0).max(1).default(0.7), // макс. доля в бумагах (подушка кэша)
  MAX_OPEN_POSITIONS: z.coerce.number().int().default(3), // макс. число открытых позиций (0 = выкл)

  // Стратегия RSI mean-reversion (пороги настраиваемы)
  STRATEGY_ENABLED: bool(true), // false → режим «только карри»
  MIN_CONFIDENCE: z.coerce.number().default(0.55), // ниже — вход не предлагается (0.5=на пороге, 0.55≈RSI≤25): без новых входов (выходы и карри работают)
  RSI_PERIOD: z.coerce.number().int().positive().default(14),
  RSI_OVERSOLD: z.coerce.number().default(30),
  RSI_OVERBOUGHT: z.coerce.number().default(70),
  RSI_TP_PCT: z.coerce.number().default(4),
  RSI_SL_PCT: z.coerce.number().default(3),

  // Лимитные заявки и ликвидность
  USE_LIMIT_ORDERS: bool(true), // marketable-limit вместо market (контроль проскальзывания)
  LIMIT_SLIPPAGE_CAP_PCT: z.coerce.number().default(0.3), // макс. проход по стакану, %
  MAX_SPREAD_PCT: z.coerce.number().default(0.5), // фильтр ликвидности: не входить при спреде шире

  // Circuit breaker по волатильности (не входить в аномальное движение)
  VOLATILITY_ENABLED: bool(true),
  MAX_INTRADAY_RANGE_PCT: z.coerce.number().default(3), // размах за час выше → стоп входов

  // Карри: парковка свободного кэша (ежедневный доход)
  CARRY_ENABLED: bool(true),
  // Режим: fund — фонд ликвидности LQDT (мгновенная ликвидность); ofz — лестница ОФЗ
  // (фикс-купон ОФЗ-ПД по срокам погашения; фиксируем доходность кривой).
  CARRY_MODE: z.enum(["fund", "ofz"]).default("fund"),
  CARRY_UID: z.string().default("a240edc6-a605-44b3-9801-37b9f7c3d1ff"), // LQDT «ВИМ Ликвидность»
  CARRY_TICKER: z.string().default("LQDT"),
  OFZ_LADDER_RUNGS: z.coerce.number().int().positive().default(4), // число ступеней лестницы
  CASH_RESERVE_RUB: z.coerce.number().default(2000), // держим ликвидным под стратегию, остальное — в карри

  // Дивидендный фактор стратегии
  DIV_ENABLED: bool(true),
  DIV_ENTRY_WINDOW_DAYS: z.coerce.number().default(10), // покупать за ≤ N дней до отсечки
  DIV_MIN_YIELD: z.coerce.number().default(3), // мин. доходность дивиденда, %
  DIV_SELL_AFTER_PAYMENT: bool(true), // true: держать через отсечку, продать после выплаты

  // Планировщик (команда `loop`)
  LOOP_INTERVAL_SEC: z.coerce.number().int().positive().default(900), // период цикла, сек
  LOOP_MARKET_HOURS_ONLY: bool(true), // торговать только в часы биржи
  LOOP_START_HOUR_MSK: z.coerce.number().int().default(10), // начало окна, МСК
  LOOP_END_HOUR_MSK: z.coerce.number().int().default(24), // конец окна, МСК (24 = включая вечёрку)
  LOOP_MAX_TICKS: z.coerce.number().int().default(0), // 0 = бесконечно (для тестов можно ограничить)
  LOOP_JITTER_SEC: z.coerce.number().int().default(120), // случайный разброс тика (антипредсказуемость/гердинг)

  // Идемпотентность/дедуп заявок (защита от дублей)
  DEDUP_WINDOW_SEC: z.coerce.number().int().default(120), // блок идентичной заявки в этом окне

  // Аналитика доходности vs бенчмарк
  BENCHMARK_UID: z.string().default("1c9d472c-975c-4212-8fb9-fb30639dc01f"), // EQMX «ВИМ – Индекс МосБиржи»
  BENCHMARK_TICKER: z.string().default("EQMX"),

  // Алерты о сбоях в Telegram
  ALERT_ENABLED: bool(true),
  ALERT_AFTER_FAILURES: z.coerce.number().int().positive().default(3), // N ошибок подряд → алерт

  // Ежедневная сводка в Telegram (планировщик)
  DAILY_REPORT_ENABLED: bool(true),
  REPORT_HOUR_MSK: z.coerce.number().int().default(19), // час МСК для сводки

  // Подтверждение
  APPROVAL_CHANNEL: z.enum(["cli", "telegram"]).default("telegram"),
  APPROVAL_TIMEOUT_SEC: z.coerce.number().int().positive().default(1800), // сколько ждать ✅/❌ (30 мин)
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_APPROVER_CHAT_ID: z.string().optional(),
});

/** Булев флаг из строки окружения: всё кроме "false" (без учёта регистра) → true. */
function bool(defaultValue: boolean) {
  return z
    .string()
    .default(String(defaultValue))
    .transform((v) => v.toLowerCase() !== "false");
}

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Ошибка конфигурации (.env):\n${issues}`);
  }

  const cfg = parsed.data;

  // Активный backend требует своего токена.
  if (cfg.BACKEND === "sandbox" && !cfg.TINVEST_TOKEN_SANDBOX) {
    throw new Error("BACKEND=sandbox требует TINVEST_TOKEN_SANDBOX");
  }
  if (cfg.BACKEND === "prod" && !cfg.TINVEST_TOKEN_PROD) {
    throw new Error("BACKEND=prod требует TINVEST_TOKEN_PROD");
  }

  // Креды LLM-провайдера и Telegram проверяются лениво (в createLLM /
  // TelegramApprover) — нужны только для propose/order, а не для чтения.

  cached = cfg;
  return cfg;
}

/**
 * Можно ли реально отправлять заявки брокеру. Реальные деньги задействуются
 * ТОЛЬКО когда все предохранители сняты одновременно.
 */
export function realTradingEnabled(cfg: Config): boolean {
  return cfg.BACKEND === "prod" && !cfg.DRY_RUN && cfg.ALLOW_REAL_TRADING;
}
