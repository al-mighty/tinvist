import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Config } from "../config.js";
import { LlmOutputSchema, type LlmOutput } from "./schema.js";
import type { ProposalLLM } from "./types.js";

/** Anthropic Claude: нативный structured output через messages.parse. */
export class AnthropicLLM implements ProposalLLM {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly cfg: Config) {
    if (!cfg.ANTHROPIC_API_KEY) {
      throw new Error("LLM_PROVIDER=anthropic требует ANTHROPIC_API_KEY в .env");
    }
    this.client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  }

  async generate(system: string, user: string): Promise<LlmOutput> {
    const response = await this.client.messages.parse({
      model: this.cfg.LLM_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: zodOutputFormat(LlmOutputSchema),
      },
      system,
      messages: [{ role: "user", content: user }],
    });
    if (!response.parsed_output) {
      throw new Error("Anthropic не вернул структурированный ответ.");
    }
    return response.parsed_output;
  }
}
