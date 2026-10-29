import { describe, expect, it } from "vitest";
import { authorize } from "../lib/auth";

const req = (auth?: string) =>
  new Request("https://example.test/api/mcp", { headers: auth ? { authorization: auth } : {} });

describe("authorize", () => {
  it("lets a matching bearer token through", () => {
    expect(authorize(req("Bearer s3cret"), "s3cret")).toBeUndefined();
    expect(authorize(req("bearer   s3cret "), "s3cret")).toBeUndefined();
  });

  it("refuses a missing, wrong or non-bearer credential with 401", () => {
    for (const header of [undefined, "Bearer nope", "Basic s3cret", "s3cret"]) {
      expect(authorize(req(header), "s3cret")?.status).toBe(401);
    }
  });

  it("refuses everything when no token is configured", async () => {
    const res = authorize(req("Bearer anything"), undefined);
    expect(res?.status).toBe(500);
    expect(await res?.json()).toEqual({ error: "server misconfigured: MCP_TOKEN is not set" });
  });
});
