import { describe, it, expect } from "vitest";
import { savedCardsToDecklist } from "../src/lib/deck-text.js";

describe("savedCardsToDecklist (QA②)", () => {
  it("メインは見出し無し、超次元・GR は見出しを付けて後ろに置く", () => {
    expect(
      savedCardsToDecklist([
        { count: 1, name: "H", zone: "hyperspatial" },
        { count: 4, name: "A" },
        { count: 2, name: "G", zone: "gr" },
        { count: 3, name: "B" },
      ]),
    ).toBe(["4 A", "3 B", "超次元ゾーン", "1 H", "GRゾーン", "2 G"].join("\n"));
  });

  it("zone の無い従来の保存データはそのまま並べる", () => {
    expect(savedCardsToDecklist([{ count: 4, name: "A" }])).toBe("4 A");
  });
});
