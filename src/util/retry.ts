/**
 * Ретрай транзиентных сетевых сбоев (наблюдался флакающий `fetch failed`
 * на этом окружении). ПРИМЕНЯТЬ ТОЛЬКО К ИДЕМПОТЕНТНЫМ ОПЕРАЦИЯМ (чтение).
 * Для создания заявок ретрай запрещён — повтор может задвоить сделку.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts) break;
      await sleep(baseDelayMs * i);
    }
  }
  throw lastErr;
}

function isTransient(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up") ||
    msg.includes("network")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
