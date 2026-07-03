import type { Config } from "../config.js";
import { AnthropicLLM } from "./anthropic.js";
import { GigaChatLLM } from "./gigachat.js";
import type { ProposalLLM } from "./types.js";

/** Создаёт LLM-провайдер согласно LLM_PROVIDER. Ключ проверяется в конструкторе. */
export function createLLM(cfg: Config): ProposalLLM {
  return cfg.LLM_PROVIDER === "anthropic" ? new AnthropicLLM(cfg) : new GigaChatLLM(cfg);
}
