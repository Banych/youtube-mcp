import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Returns an error Response when the request may not proceed, or undefined
 * when its bearer token matches. With no token configured, every request is
 * refused: a deployment missing MCP_TOKEN must not be open to the internet.
 */
export function authorize(req: Request, expected: string | undefined): Response | undefined {
  if (!expected) {
    return Response.json({ error: "server misconfigured: MCP_TOKEN is not set" }, { status: 500 });
  }
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !timingSafeEqual(digest(match[1].trim()), digest(expected))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return undefined;
}
