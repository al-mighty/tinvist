import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Тонкая обёртка над MCP-клиентом Т-Инвестиций.
 *
 * Сервер хостит сам Т-Банк — мы только клиент. Авторизация через
 * Bearer-токен в заголовке HTTP-транспорта. ВАЖНО: MCP работает только с
 * боевым (prod) контуром — sandbox-токен здесь не авторизуется. Уровень
 * доступа (чтение / торговля) определяется самим токеном на стороне банка.
 */
export class TInvestMcp {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async connect(): Promise<void> {
    if (this.client) return;

    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
    });

    const client = new Client(
      { name: "tinvist-agent", version: "0.1.0" },
      { capabilities: {} },
    );

    await client.connect(transport);

    this.client = client;
    this.transport = transport;
  }

  /** Список доступных инструментов (зависит от уровня токена). */
  async listTools() {
    const client = this.requireClient();
    const { tools } = await client.listTools();
    return tools;
  }

  /**
   * Вызов инструмента по имени. Возвращает сырой content MCP —
   * разбор структуры оставляем вызывающему слою (обёрткам в tools.ts).
   */
  async callTool(name: string, args: Record<string, unknown> = {}) {
    const client = this.requireClient();
    const result = await client.callTool({ name, arguments: args });

    if (result.isError) {
      throw new McpToolError(name, result.content);
    }
    return result;
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.client = null;
    this.transport = null;
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new Error("MCP-клиент не подключён. Сначала вызови connect().");
    }
    return this.client;
  }
}

export class McpToolError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly content: unknown,
  ) {
    super(`MCP-инструмент "${toolName}" вернул ошибку: ${JSON.stringify(content)}`);
    this.name = "McpToolError";
  }
}

/**
 * Достаёт полезную нагрузку из MCP-ответа. T-Invest MCP кладёт уже
 * распарсенный объект в structuredContent — предпочитаем его. Иначе парсим
 * текстовую часть (обычно JSON-строка).
 */
export function extractResult(result: Awaited<ReturnType<TInvestMcp["callTool"]>>): unknown {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== undefined) return structured;

  const content = result.content;
  if (!Array.isArray(content)) return content;

  const texts = content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text);

  if (texts.length === 0) return content;

  const joined = texts.join("\n");
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}
