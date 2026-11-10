/** What every outside lookup needs; tests inject a fake fetch and a fixed clock. */
export type Deps = {
  fetch: typeof fetch;
  timeoutMs?: number;
  /** Clock for "today"; tests pin it. */
  now?: () => Date;
  /** Waits before each feed retry; tests pass zeros. */
  retryDelaysMs?: number[];
  /** Where failure summaries go; Vercel keeps console.warn in its runtime logs. Tests capture it. */
  log?: (line: string) => void;
};

/** One line per failing lookup batch, e.g. "feeds: 38/40 failed (HTTP 404 (3 tries) ×38)". */
export function logFailures(deps: Deps, what: string, total: number, errors: string[]): void {
  if (!errors.length) return;
  const counts = new Map<string, number>();
  for (const e of errors) counts.set(e, (counts.get(e) ?? 0) + 1);
  const summary = [...counts].map(([e, n]) => `${e} ×${n}`).join(", ");
  (deps.log ?? console.warn)(`${what}: ${errors.length}/${total} failed (${summary})`);
}

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
 * Outside text as one capped line, by allow-list: letters, digits, punctuation, symbols, marks
 * and plain spaces stay; line breaks become spaces; everything else (control and format
 * characters, private-use and unassigned code points) goes, along with the blank-looking
 * characters those classes miss: variation selectors (Mongolian ones too), the combining
 * grapheme joiner, Hangul fillers and the Braille blank. Joiners go too, so emoji sequences
 * split and Persian ZWNJ is lost: an accepted cost for quoted text.
 */
export function oneLine(raw: unknown, max: number): string {
  const s = String(raw ?? "")
    .replace(/[\p{Zl}\p{Zp}\r\n\t\v\f]+/gu, " ")
    .replace(/[^\p{L}\p{N}\p{P}\p{S}\p{M}\p{Zs}]/gu, "")
    .replace(/[\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u034F\u115F\u1160\u3164\uFFA0\u2800\u180B-\u180D\u180F]/gu, "")
    .replace(/\p{Zs}+/gu, " ")
    .trim();
  if (s.length <= max) return s;
  const space = s.lastIndexOf(" ", max);
  return s.slice(0, space > 0 ? space : max) + "…";
}

/** A failure as one short line. JSON.parse errors quote the response body, so they become "invalid JSON". */
export function errorMessage(reason: unknown): string {
  if (reason instanceof SyntaxError) return "invalid JSON";
  return oneLine(reason instanceof Error ? (reason.name === "TimeoutError" ? "timed out" : reason.message) : reason, 120);
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
