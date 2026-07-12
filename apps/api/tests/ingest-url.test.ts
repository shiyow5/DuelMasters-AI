import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const extractTournamentMock = vi.fn();
vi.mock("../src/tournament-extract.js", () => ({
  extractTournament: (...args: unknown[]) => extractTournamentMock(...args),
}));

const { metaRouter } = await import("../src/routes/meta.js");

const app = new Hono();
app.route("/api/meta", metaRouter);

function post(body: unknown, headers: Record<string, string> = {}) {
  return app.request("/api/meta/ingest/url", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/meta/ingest/url", () => {
  beforeEach(() => {
    extractTournamentMock.mockReset();
    process.env.INTERNAL_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<body>大会結果ページ</body>")),
    );
  });

  it("X-Internal-Key 無しは 401", async () => {
    const res = await post({ url: "https://example.com" });
    expect(res.status).toBe(401);
  });

  it("X-Internal-Key 不一致は 401", async () => {
    const res = await post({ url: "https://example.com" }, { "X-Internal-Key": "wrong" });
    expect(res.status).toBe(401);
  });

  it("url 欠落は 400", async () => {
    const res = await post({}, { "X-Internal-Key": "test-key" });
    expect(res.status).toBe(400);
  });

  it("抽出失敗は 422", async () => {
    extractTournamentMock.mockRejectedValueOnce(new Error("抽出不能"));
    const res = await post({ url: "https://example.com" }, { "X-Internal-Key": "test-key" });
    expect(res.status).toBe(422);
  });
});
