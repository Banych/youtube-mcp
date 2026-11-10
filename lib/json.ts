/** Read outside JSON without trusting its shape: wrong types become empty values, never throws. */
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
