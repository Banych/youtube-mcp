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
  /** YouTube Data API key; when set, uploads come from the API first and the feeds are the fallback. */
  youtubeApiKey?: string;
  /**
   * Epoch ms by which the tool call must be done. Vercel kills the function at maxDuration
   * (30 s) and the caller then gets nothing, so lookups shrink their timeouts and skip
   * optional steps rather than run past it.
   */
  deadline?: number;
};

/** Milliseconds left before the deadline; Infinity without one. */
export const timeLeft = (deps: Deps): number => (deps.deadline === undefined ? Infinity : deps.deadline - Date.now());

/** One line per failing lookup batch, e.g. "feeds: 38/40 failed (HTTP 404 (3 tries) ×38)". */
export function logFailures(deps: Deps, what: string, total: number, errors: string[]): void {
  if (!errors.length) return;
  const counts = new Map<string, number>();
  for (const e of errors) counts.set(e, (counts.get(e) ?? 0) + 1);
  const summary = [...counts].map(([e, n]) => `${e} ×${n}`).join(", ");
  (deps.log ?? console.warn)(`${what}: ${errors.length}/${total} failed (${summary})`);
}

export class HttpError extends Error {
  /** rateLimited: a 429, or a 403 that carries GitHub's rate-limit headers rather than a missing permission. */
  constructor(
    readonly status: number,
    readonly rateLimited = false,
  ) {
    super(`HTTP ${status}`);
  }
}

const httpError = (res: Response) =>
  new HttpError(
    res.status,
    res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"))),
  );

/** Runs one request under the call's budget: the timeout shrinks to what is left, and running out says so. */
async function budgeted<T>(deps: Deps, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const left = timeLeft(deps);
  if (left <= 0) throw new Error("out of time");
  const timeout = deps.timeoutMs ?? 8000;
  try {
    return await fn(AbortSignal.timeout(Math.min(timeout, left)));
  } catch (e) {
    // Cut short by the call's budget rather than by a slow server: say so.
    if (left < timeout && e instanceof Error && e.name === "TimeoutError") throw new Error("out of time");
    throw e;
  }
}

/** GET (or the given method) with a timeout; non-2xx answers throw HttpError. */
export async function get(url: string, deps: Deps, init?: RequestInit): Promise<string> {
  return budgeted(deps, async (signal) => {
    const res = await deps.fetch(url, { ...init, signal });
    if (!res.ok) throw httpError(res);
    return await res.text();
  });
}

/** sized: `bytes` is the size the server declared; otherwise it is only what was read before the cut. */
export type Capped = { text: string; type: string; bytes: number; cut: boolean; sized: boolean };

/**
 * Like `get`, but reads at most maxBytes of the body, so a huge file costs no more than its first part.
 * `type` is the Content-Type.
 */
export async function getCapped(url: string, deps: Deps, init: RequestInit, maxBytes: number): Promise<Capped> {
  return budgeted(deps, async (signal) => {
    const res = await deps.fetch(url, { ...init, signal });
    if (!res.ok) throw httpError(res);
    const type = res.headers.get("content-type") ?? "";
    const declared = Number(res.headers.get("content-length") ?? NaN);
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    let cut = false;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - bytes;
      bytes += value.byteLength;
      if (value.byteLength > room) {
        text += decoder.decode(value.subarray(0, room), { stream: true });
        cut = true;
        await reader.cancel();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    if (!cut) text += decoder.decode();
    const sized = Number.isFinite(declared) && declared >= bytes;
    return { text, type, bytes: sized ? declared : bytes, cut, sized };
  });
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
  // Never end on half of a surrogate pair (an emoji or other astral character cut in two).
  return s.slice(0, space > 0 ? space : max).replace(/[\uD800-\uDBFF]$/, "") + "…";
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
      // A retry needs its wait plus about a second for the request itself.
      if (attempt >= delays.length || timeLeft(deps) <= delays[attempt] + 1000) {
        throw new Error(`${(e as Error).message} (${attempt + 1} tries)`);
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}
