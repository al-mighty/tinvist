import type { Config } from "../config.js";
import { McpBackend } from "./mcp.js";
import { SandboxBackend } from "./sandbox.js";
import type { TradingBackend } from "./types.js";

/** Создаёт backend согласно активному контуру (cfg.BACKEND). */
export function createBackend(cfg: Config): TradingBackend {
  return cfg.BACKEND === "prod" ? new McpBackend(cfg) : new SandboxBackend(cfg);
}
