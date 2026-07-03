import type { LlmOutput } from "./schema.js";

/**
 * Провайдер LLM для движка предложений. Реализация сама выбирает механизм
 * структурированного вывода (Anthropic structured outputs / GigaChat JSON) и
 * возвращает уже провалидированный LlmOutput.
 */
export interface ProposalLLM {
  readonly name: string;
  generate(system: string, user: string): Promise<LlmOutput>;
}
