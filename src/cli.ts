import { loadConfig, type Config } from "./config.js";
import { createBackend } from "./backends/factory.js";
import type { TradingBackend } from "./backends/types.js";
import { fmtRub } from "./domain.js";
import { TInvestMcp, extractResult } from "./mcp/client.js";
import { InstrumentResolver } from "./instruments/resolve.js";
import { createApprover } from "./approval/factory.js";
import { Executor } from "./execution/executor.js";
import { ProposalEngine } from "./strategy/engine.js";
import { runRsiCycle } from "./strategy/run.js";
import { runLoop } from "./scheduler.js";
import { buildStatusReport } from "./report/status.js";
import { describeProposal, type TradeProposal } from "./strategy/types.js";

/**
 * CLI для ручной проверки слоёв агента.
 *
 * Команды данных (accounts/portfolio/quote) идут через активный BACKEND
 * (sandbox REST или prod MCP). Команды интроспекции (list-tools/describe/call)
 * всегда идут в MCP с prod-токеном — MCP работает только с боевым контуром.
 *
 *   npm run cli -- accounts
 *   npm run cli -- portfolio [accountId]
 *   npm run cli -- quote <instrumentId>
 *   npm run cli -- list-tools
 *   npm run cli -- describe <tool>
 *   npm run cli -- call <tool> '<jsonArgs>'
 */

// ─── Команды через backend ─────────────────────────────────────────

type BackendCommand = (backend: TradingBackend, cfg: Config, args: string[]) => Promise<void>;

const backendCommands: Record<string, BackendCommand> = {
  accounts: async (backend) => {
    const accounts = await backend.listAccounts();
    console.log(`\nСчета (${backend.kind}): ${accounts.length}\n`);
    for (const a of accounts) {
      console.log(`• ${a.id}  ${a.name || "(без имени)"}  [${a.type}] ${a.accessLevel}`);
    }
    console.log();
  },

  portfolio: async (backend, _cfg, args) => {
    let accountId = args[0];
    if (!accountId) {
      const accounts = await backend.listAccounts();
      if (accounts.length === 0) {
        console.log("Нет доступных счетов.");
        return;
      }
      accountId = accounts[0]!.id;
      console.log(`accountId не указан — беру первый: ${accountId}`);
    }
    const p = await backend.getPortfolio(accountId);
    console.log(`\nПортфель ${p.accountId} (${backend.kind})`);
    console.log(`Итого: ${fmtRub(p.totalValueRub)}\n`);
    if (p.positions.length === 0) {
      console.log("Позиций нет.");
    } else {
      for (const pos of p.positions) {
        const name = pos.ticker || pos.instrumentId;
        console.log(
          `• ${name} [${pos.instrumentType}]  ${pos.quantity} шт × ${pos.currentPrice} = ${fmtRub(pos.valueRub)}`,
        );
      }
    }
    console.log();
  },

  // status [accountId] — сводка: капитал, позиции, нереализ. P&L, просадка.
  status: async (backend, cfg, args) => {
    const accountId = args[0] ?? (await backend.listAccounts())[0]?.id ?? "";
    if (!accountId) {
      console.error("Не удалось определить accountId.");
      process.exitCode = 1;
      return;
    }
    const report = await buildStatusReport(cfg, backend, accountId);
    console.log("\n" + report + "\n");
  },

  quote: async (backend, _cfg, args) => {
    const instrumentId = args[0];
    if (!instrumentId) {
      console.error("Использование: npm run cli -- quote <instrumentId>");
      process.exitCode = 1;
      return;
    }
    const price = await backend.getLastPrice(instrumentId);
    console.log(`\n${instrumentId}: ${price}\n`);
  },

  // order <query> <buy|sell> <lots> [limitPrice] [accountId]
  // Ручное предложение сделки через полный конвейер: guard → подтверждение → исполнение.
  order: async (backend, cfg, args) => {
    const [query, sideRaw, lotsRaw, priceRaw, accountArg] = args;
    if (!query || !sideRaw || !lotsRaw) {
      console.error(
        "Использование: npm run cli -- order <тикер|uid> <buy|sell> <лоты> [лимит-цена] [accountId]",
      );
      process.exitCode = 1;
      return;
    }
    const side = sideRaw.toLowerCase();
    if (side !== "buy" && side !== "sell") {
      console.error("Направление должно быть buy или sell.");
      process.exitCode = 1;
      return;
    }
    const lots = Number(lotsRaw);
    if (!Number.isInteger(lots) || lots <= 0) {
      console.error("Лоты — целое положительное число.");
      process.exitCode = 1;
      return;
    }
    const limitPrice = priceRaw ? Number(priceRaw) : undefined;

    const resolver = new InstrumentResolver(cfg);
    let proposal: TradeProposal;
    let accountId: string;
    try {
      const instrument = await resolver.resolveOne(query);
      if (!instrument) {
        console.error(`Инструмент по запросу "${query}" не найден.`);
        process.exitCode = 1;
        return;
      }
      const price = limitPrice ?? (await backend.getLastPrice(instrument.uid));
      proposal = {
        instrument: instrument.uid,
        instrumentName: `${instrument.ticker} · ${instrument.name}`,
        side,
        orderType: limitPrice != null ? "limit" : "market",
        lots,
        price,
        lotSize: instrument.lot,
        rationale: "Ручная заявка через CLI",
        createdAt: new Date().toISOString(),
      };
      accountId = accountArg ?? (await backend.listAccounts())[0]?.id ?? "";
      if (!accountId) {
        console.error("Не удалось определить accountId.");
        process.exitCode = 1;
        return;
      }
    } finally {
      await resolver.close();
    }

    const executor = new Executor(backend, cfg, createApprover(cfg));
    const outcome = await executor.execute(proposal, accountId);
    console.log(`\n[${outcome.status}] ${outcome.message}`);
    if (outcome.order) {
      console.log(`orderId: ${outcome.order.orderId}  status: ${outcome.order.status}`);
    }
  },

  // propose <ticker1,ticker2,...> [accountId]
  // Движок предложений (стратегия + Claude) → каждое предложение через конвейер.
  propose: async (backend, cfg, args) => {
    const watchRaw = args[0];
    if (!watchRaw) {
      console.error("Использование: npm run cli -- propose <тикеры через запятую> [accountId]");
      process.exitCode = 1;
      return;
    }
    const watchlist = watchRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const accountId = args[1] ?? (await backend.listAccounts())[0]?.id ?? "";
    if (!accountId) {
      console.error("Не удалось определить accountId.");
      process.exitCode = 1;
      return;
    }

    const engine = new ProposalEngine(cfg, backend);
    const { proposals, commentary } = await engine.propose(watchlist, accountId);
    await runProposals(backend, cfg, accountId, proposals, commentary, "Движок не предложил сделок.");
  },

  // rsi <ticker1,ticker2,...> [accountId]
  // Детерминированная стратегия RSI mean-reversion (без LLM) → тот же конвейер.
  rsi: async (backend, cfg, args) => {
    const watchRaw = args[0];
    if (!watchRaw) {
      console.error("Использование: npm run cli -- rsi <тикеры через запятую> [accountId]");
      process.exitCode = 1;
      return;
    }
    const watchlist = watchRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const accountId = args[1] ?? (await backend.listAccounts())[0]?.id ?? "";
    if (!accountId) {
      console.error("Не удалось определить accountId.");
      process.exitCode = 1;
      return;
    }
    await runRsiCycle(cfg, backend, accountId, watchlist);
  },

  // loop <ticker1,ticker2,...> [accountId]
  // Планировщик: периодически гоняет RSI+дивидендную стратегию (часы биржи, kill-switch).
  loop: async (backend, cfg, args) => {
    const watchRaw = args[0];
    if (!watchRaw) {
      console.error("Использование: npm run cli -- loop <тикеры через запятую> [accountId]");
      process.exitCode = 1;
      return;
    }
    const watchlist = watchRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const accountId = args[1] ?? (await backend.listAccounts())[0]?.id ?? "";
    if (!accountId) {
      console.error("Не удалось определить accountId.");
      process.exitCode = 1;
      return;
    }
    await runLoop(cfg, backend, accountId, watchlist);
  },
};

/** Общий прогон списка предложений через конвейер исполнения. */
async function runProposals(
  backend: TradingBackend,
  cfg: Config,
  accountId: string,
  proposals: TradeProposal[],
  commentary: string,
  emptyMsg: string,
): Promise<void> {
  console.log(`\n${commentary}\n`);
  if (proposals.length === 0) {
    console.log(emptyMsg);
    return;
  }
  console.log(`Предложено сделок: ${proposals.length}`);
  for (const p of proposals) console.log(`  • ${describeProposal(p)}`);

  const executor = new Executor(backend, cfg, createApprover(cfg));
  for (const proposal of proposals) {
    const outcome = await executor.execute(proposal, accountId);
    console.log(`\n[${outcome.status}] ${outcome.message}`);
    if (outcome.order) {
      console.log(`orderId: ${outcome.order.orderId}  status: ${outcome.order.status}`);
    }
  }
}

// ─── Команды интроспекции MCP (всегда prod-токен) ──────────────────

type McpCommand = (mcp: TInvestMcp, args: string[]) => Promise<void>;

const mcpCommands: Record<string, McpCommand> = {
  "list-tools": async (mcp) => {
    const tools = await mcp.listTools();
    console.log(`\nДоступно инструментов: ${tools.length}\n`);
    for (const t of tools) {
      console.log(`• ${t.name}`);
      if (t.description) console.log(`    ${t.description}`);
    }
    console.log();
  },

  describe: async (mcp, args) => {
    const name = args[0];
    if (!name) {
      console.error("Укажи имя инструмента: npm run cli -- describe invest_create_order");
      process.exitCode = 1;
      return;
    }
    const tools = await mcp.listTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      console.error(`Инструмент "${name}" не найден.`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n${tool.name}\n${tool.description ?? ""}\n`);
    console.log("inputSchema:");
    console.log(JSON.stringify(tool.inputSchema, null, 2));
    console.log();
  },

  find: async (mcp, args) => {
    const query = args[0];
    if (!query) {
      console.error("Использование: npm run cli -- find <запрос>");
      process.exitCode = 1;
      return;
    }
    const res = (await extractResult(
      await mcp.callTool("invest_find_instrument", {
        query,
        instrumentKind: args[1] ?? "INSTRUMENT_TYPE_SHARE",
        apiTradeAvailableFlag: true,
        responseView: ["FULL"],
      }),
    )) as any;
    const items = (res?.instruments ?? []) as any[];
    console.log(`\nНайдено: ${items.length}\n`);
    for (const i of items.slice(0, 15)) {
      console.log(`• ${i.ticker ?? "?"} [${i.classCode ?? "?"}] лот ${i.lot ?? "?"} — ${i.name ?? ""}`);
      console.log(`    uid: ${i.uid}`);
    }
    console.log();
  },

  call: async (mcp, args) => {
    const name = args[0];
    if (!name) {
      console.error('Использование: npm run cli -- call <tool> \'{"json":"args"}\'');
      process.exitCode = 1;
      return;
    }
    let toolArgs: Record<string, unknown> = {};
    if (args[1]) {
      try {
        toolArgs = JSON.parse(args[1]);
      } catch {
        console.error("Второй аргумент должен быть валидным JSON.");
        process.exitCode = 1;
        return;
      }
    }
    console.log(JSON.stringify(extractResult(await mcp.callTool(name, toolArgs)), null, 2));
  },
};

function printHelp(): void {
  console.log(`
tinvist — торговый агент поверх T-Bank Invest MCP

Использование:
  npm run cli -- <команда> [аргументы]

Данные (через активный BACKEND):
  accounts              Список счетов
  portfolio [accountId] Портфель (по умолчанию — первый счёт)
  quote <instrumentId>  Последняя цена инструмента
  status [accountId]    Сводка: капитал, позиции, нереализ. P&L, просадка
  order <тикер|uid> <buy|sell> <лоты> [лимит] [accountId]
                        Заявка через конвейер guard → подтверждение → исполнение
  propose <тикеры,...> [accountId]
                        LLM (GigaChat/Claude) предлагает сделки → тот же конвейер
  rsi <тикеры,...> [accountId]
                        Детерминированная RSI mean-reversion стратегия → конвейер
  loop <тикеры,...> [accountId]
                        Планировщик: гоняет стратегию по расписанию (часы биржи)

Интроспекция MCP (всегда prod):
  find <запрос>         Поиск инструмента (тикер, uid, лот)
  list-tools            Доступные MCP-инструменты
  describe <tool>       Схема входных параметров инструмента
  call <tool> '<json>'  Сырой вызов инструмента
`);
}

async function main(): Promise<void> {
  const [, , cmdName, ...args] = process.argv;

  if (!cmdName || cmdName === "help" || cmdName === "--help") {
    printHelp();
    return;
  }

  const cfg = loadConfig();

  if (backendCommands[cmdName]) {
    const backend = createBackend(cfg);
    try {
      await backend.connect();
      await backendCommands[cmdName]!(backend, cfg, args);
    } finally {
      await backend.close();
    }
    return;
  }

  if (mcpCommands[cmdName]) {
    if (!cfg.TINVEST_TOKEN_PROD) {
      throw new Error("Интроспекция MCP требует TINVEST_TOKEN_PROD (MCP работает только с prod).");
    }
    const mcp = new TInvestMcp(cfg.TINVEST_MCP_URL, cfg.TINVEST_TOKEN_PROD);
    try {
      await mcp.connect();
      await mcpCommands[cmdName]!(mcp, args);
    } finally {
      await mcp.close();
    }
    return;
  }

  console.error(`Неизвестная команда: ${cmdName}`);
  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("\n✖ Ошибка:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
