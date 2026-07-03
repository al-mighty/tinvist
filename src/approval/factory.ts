import type { Config } from "../config.js";
import { CliApprover } from "./cli.js";
import { TelegramApprover } from "./telegram.js";
import type { Approver } from "./types.js";

/** Создаёт канал подтверждения согласно APPROVAL_CHANNEL. */
export function createApprover(cfg: Config): Approver {
  return cfg.APPROVAL_CHANNEL === "telegram" ? new TelegramApprover(cfg) : new CliApprover();
}
