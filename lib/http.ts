/** What every outside lookup needs; tests inject a fake fetch and a fixed clock. */
export type Deps = {
  fetch: typeof fetch;
  timeoutMs?: number;
  /** Clock for "today"; tests pin it. */
  now?: () => Date;
  /** Waits before each feed retry; tests pass zeros. */
  retryDelaysMs?: number[];
};

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** GET (or the given method) with a timeout; non-2xx answers throw HttpError. */
export async function get(url: string, deps: Deps, init?: RequestInit): Promise<string> {
  const res = await deps.fetch(url, {
    ...init,
    signal: AbortSignal.timeout(deps.timeoutMs ?? 8000),
  });
  if (!res.ok) throw new HttpError(res.status);
  return res.text();
}

/**
 * A failure as one short line. JSON.parse errors quote the response body, so they become a
 * fixed "invalid JSON"; anything else is stripped of invisible characters and line breaks.
 */
export function errorMessage(reason: unknown): string {
  if (reason instanceof SyntaxError) return "invalid JSON";
  const raw = reason instanceof Error ? (reason.name === "TimeoutError" ? "timed out" : reason.message) : String(reason);
  const line = raw
    .replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ")
    .trim();
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/**
 * Some endpoints (YouTube's feeds, github.com from shared Vercel IPs) intermittently answer
 * 404, 429 or 5xx for things that exist; a retry a moment later usually succeeds. Timeouts are
 * not retried: three 8 s attempts would not fit the function's 30 s limit.
 */
const RETRY_DELAYS_MS = [500, 1500];

const isTransient = (e: unknown) => e instanceof HttpError && (e.status === 404 || e.status === 429 || e.status >= 500);

/** `get`, retried on transient answers; the final error names the number of tries. */
export async function getWithRetry(url: string, deps: Deps): Promise<string> {
  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await get(url, deps);
    } catch (e) {
      if (!isTransient(e)) throw e;
      if (attempt >= delays.length) throw new Error(`${(e as Error).message} (${attempt + 1} tries)`);
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}
