import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { deckRouter } from "../src/routes/deck.js";

/**
 * QA② (#165 B-07): オリジナルに超次元・GR を入れたデッキは**警告を出して評価を続ける**
 * (2026-11-02 しよをさん決定・A案)。DB 無しでも評価は劣化動作で返るので、DB 不要で回す。
 */
function makeApp() {
  const app = new Hono();
  app.route("/api/deck", deckRouter);
  return app;
}

function main40(): string {
  return Array.from({ length: 10 }, (_, i) => `4 メインカード${i + 1}`).join("\n");
}

async function evaluate(decklist: string, format: "original" | "advance") {
  const res = await makeApp().request("/api/deck/evaluate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decklist, format }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    parsed: { totalCards: number; zones: { hyperspatial: unknown[]; gr: unknown[] } };
    score: { overall: number } | null;
    validation: { valid: boolean; errors: string[]; warnings: string[] };
  };
}

describe("POST /api/deck/evaluate 超次元・GR (QA②)", () => {
  it("オリジナルで超次元/GR 入りは警告が出て、評価結果も返る", async () => {
    const decklist = [
      "メインデッキ",
      main40(),
      "超次元ゾーン",
      "4 時空の英雄アンタッチャブル",
      "4 時空の喧嘩屋キル",
      "GRゾーン",
      "2 ジェイ-SHOCKER",
    ].join("\n");
    const body = await evaluate(decklist, "original");

    expect(body.validation.valid).toBe(true);
    expect(body.validation.errors).toEqual([]);
    expect(body.validation.warnings).toContain(
      "オリジナルでは超次元・GRゾーンを使えません (超次元ゾーン8枚・GRゾーン2枚)。メインデッキだけで評価しています",
    );
    expect(typeof body.score?.overall).toBe("number");
    // メインは 40 枚 (見出し行・超次元・GR を含まない)
    expect(body.parsed.totalCards).toBe(40);
  });

  it("アドバンスで 40+超次元8+GR12 は枚数違反にならず、ゾーンの警告も出ない", async () => {
    const decklist = [
      "メインデッキ",
      main40(),
      "超次元ゾーン",
      "4 超次元A",
      "4 超次元B",
      "GRゾーン",
      ...Array.from({ length: 6 }, (_, i) => `2 GRカード${i + 1}`),
    ].join("\n");
    const body = await evaluate(decklist, "advance");

    expect(body.validation.errors).toEqual([]);
    expect(body.validation.valid).toBe(true);
    expect(body.validation.warnings.some((w) => w.includes("超次元"))).toBe(false);
  });
});

describe("deck 系の入力サイズ上限 (#253)", () => {
  it("decklist が上限 +1 なら /evaluate は 400", async () => {
    const res = await makeApp().request("/api/deck/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decklist: "a".repeat(20_001), format: "original" }),
    });
    expect(res.status).toBe(400);
  });
});
