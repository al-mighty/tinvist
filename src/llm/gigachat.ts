import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { withRetry } from "../util/retry.js";
import { LlmOutputSchema, type LlmOutput } from "./schema.js";
import type { ProposalLLM } from "./types.js";

/** Точное описание требуемого JSON — добавляется в system-промпт GigaChat. */
const JSON_SPEC = `Ответь СТРОГО одним JSON-объектом без markdown, пояснений и текста вокруг.
Формат:
{
  "marketCommentary": "строка, 2-4 предложения",
  "proposals": [
    {
      "ticker": "тикер из watchlist",
      "side": "buy" | "sell",
      "orderType": "market" | "limit",
      "lots": целое число > 0,
      "limitPrice": число (для limit) или null,
      "confidence": число от 0 до 1,
      "rationale": "обоснование"
    }
  ]
}
Если хороших идей нет — верни "proposals": []. Никакого текста вне JSON.`;

/**
 * Sber GigaChat. Structured output через строгий JSON-промпт + валидацию zod
 * с одним повтором при ошибке разбора. TLS GigaChat выпущен через Russian
 * Trusted Root CA — тот же, что уже подключён через NODE_EXTRA_CA_CERTS.
 */
export class GigaChatLLM implements ProposalLLM {
  readonly name = "gigachat";
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: Config) {
    if (!cfg.GIGACHAT_AUTH_KEY) {
      throw new Error("LLM_PROVIDER=gigachat требует GIGACHAT_AUTH_KEY в .env");
    }
  }

  async generate(system: string, user: string): Promise<LlmOutput> {
    const fullSystem = `${system}\n\n${JSON_SPEC}`;

    const first = await this.chat(fullSystem, user);
    const parsed = tryParse(first);
    if (parsed.ok) return parsed.data;

    // Повтор: возвращаем модели её ответ и требуем валидный JSON.
    const retry = await this.chat(
      fullSystem,
      `${user}\n\nТвой предыдущий ответ не прошёл валидацию: ${parsed.reason}. ` +
        `Верни ТОЛЬКО корректный JSON-объект по схеме, без markdown и текста вокруг.`,
    );
    const parsedRetry = tryParse(retry);
    if (parsedRetry.ok) return parsedRetry.data;

    throw new Error(
      `GigaChat не вернул валидный JSON (${parsedRetry.reason}).\nОтвет модели:\n${retry}`,
    );
  }

  // ─── OAuth ──────────────────────────────────────────────────────

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt - 60_000 > now) return this.token.value;

    const res = await withRetry(
      () =>
        fetch(this.cfg.GIGACHAT_OAUTH_URL, {
          method: "POST",
          headers: {
            Authorization: `Basic ${this.cfg.GIGACHAT_AUTH_KEY}`,
            RqUID: randomUUID(),
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: `scope=${encodeURIComponent(this.cfg.GIGACHAT_SCOPE)}`,
        }),
      { label: "gigachat.oauth" },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GigaChat OAuth ошибка ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text) as { access_token: string; expires_at?: number };
    // expires_at — epoch ms; если нет, считаем 30 минут от текущего момента.
    this.token = {
      value: json.access_token,
      expiresAt: json.expires_at ?? now + 30 * 60_000,
    };
    return this.token.value;
  }

  private async chat(system: string, user: string): Promise<string> {
    const token = await this.accessToken();
    const res = await withRetry(
      () =>
        fetch(`${this.cfg.GIGACHAT_API_URL}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model: this.cfg.GIGACHAT_MODEL,
            temperature: 0.3,
            max_tokens: 6000,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }),
        }),
      { label: "gigachat.chat" },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GigaChat chat ошибка ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "";
  }
}

type ParseResult = { ok: true; data: LlmOutput } | { ok: false; reason: string };

/** Извлекает JSON-объект из ответа (снимает markdown-обёртку) и валидирует. */
function tryParse(raw: string): ParseResult {
  if (!raw) return { ok: false, reason: "пустой ответ" };
  let candidate = raw.trim();
  // Снять ```json ... ``` обёртку, если есть.
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidate = fence[1].trim();
  // Выделить первый { ... последний }.
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return { ok: false, reason: "JSON-объект не найден" };
  candidate = candidate.slice(start, end + 1);

  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch (e) {
    return { ok: false, reason: `JSON.parse: ${e instanceof Error ? e.message : e}` };
  }
  const result = LlmOutputSchema.safeParse(obj);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return { ok: false, reason: `схема: ${issues}` };
  }
  return { ok: true, data: result.data };
}
