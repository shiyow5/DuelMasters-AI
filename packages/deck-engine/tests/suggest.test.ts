import { describe, it, expect } from "vitest";
import { pickReplacements, type SuggestInput } from "../src/suggest.js";

describe("pickReplacements", () => {
  it("goal タグを持たない高count・高costカードが最初の original に選ばれる", () => {
    const input: SuggestInput = {
      deckCards: [
        { name: "バニラ大", count: 4, cost: 7, tags: [] },
        { name: "バニラ小", count: 1, cost: 2, tags: [] },
        { name: "受け札", count: 4, cost: 3, tags: ["受け"] },
      ],
      candidatesByGoal: new Map([["ドロー", [{ name: "新ドロー", cost: 3, tags: ["ドロー"] }]]]),
    };
    const out = pickReplacements(input);
    expect(out[0].original).toBe("バニラ大");
    expect(out[0].replacement).toBe("新ドロー");
    expect(out[0].reason).toContain("ドロー");
  });

  it("全カードが goal に寄与している → 提案 0 件 (original に空文字を返さない)", () => {
    const input: SuggestInput = {
      deckCards: [{ name: "受け札", count: 4, cost: 3, tags: ["受け"] }],
      candidatesByGoal: new Map([["受け", [{ name: "新受け", cost: 2, tags: ["受け"] }]]]),
    };
    expect(pickReplacements(input)).toEqual([]);
  });

  it("候補が空の goal からは提案なし", () => {
    const input: SuggestInput = {
      deckCards: [{ name: "バニラ", count: 4, cost: 5, tags: [] }],
      candidatesByGoal: new Map([["ドロー", []]]),
    };
    expect(pickReplacements(input)).toEqual([]);
  });

  it("同 count・同 cost は名前昇順で選ばれる", () => {
    const input: SuggestInput = {
      deckCards: [
        { name: "B", count: 2, cost: 4, tags: [] },
        { name: "A", count: 2, cost: 4, tags: [] },
      ],
      candidatesByGoal: new Map([
        [
          "ドロー",
          [
            { name: "d1", cost: 3, tags: ["ドロー"] },
            { name: "d2", cost: 3, tags: ["ドロー"] },
          ],
        ],
      ]),
    };
    const out = pickReplacements(input);
    expect(out[0].original).toBe("A");
    expect(out[1].original).toBe("B");
  });

  it("1 goal あたり最大2提案", () => {
    const input: SuggestInput = {
      deckCards: [
        { name: "v1", count: 4, cost: 5, tags: [] },
        { name: "v2", count: 4, cost: 5, tags: [] },
        { name: "v3", count: 4, cost: 5, tags: [] },
      ],
      candidatesByGoal: new Map([
        [
          "ドロー",
          [
            { name: "d1", cost: 1, tags: ["ドロー"] },
            { name: "d2", cost: 2, tags: ["ドロー"] },
            { name: "d3", cost: 3, tags: ["ドロー"] },
          ],
        ],
      ]),
    };
    expect(pickReplacements(input).length).toBe(2);
  });
});
