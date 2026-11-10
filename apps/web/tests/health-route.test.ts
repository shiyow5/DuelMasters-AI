import { describe, it, expect } from "vitest";
import { GET } from "../src/app/health/route.js";

describe("/health", () => {
  it("200 と status: ok を返す", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
