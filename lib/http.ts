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

export function errorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.name === "TimeoutError" ? "timed out" : reason.message;
  }
  return String(reason);
}
