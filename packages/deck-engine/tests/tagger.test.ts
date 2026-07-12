import { describe, it, expect } from "vitest";
import { inferTagsByRule } from "../src/tagger.js";
import type { Card } from "@dm-ai/core";

function card(overrides: Partial<Card>): Card {
  return {
    name: "テスト",
    civilizations: [],
    cost: 5,
    type: "creature",
    races: [],
    text: "",
    power: null,
    is_rainbow: false,
    is_shield_trigger: false,
    tags: [],
    card_image_url: null,
    official_id: null,
    set_code: null,
    rarity: null,
    ...overrides,
  };
}

describe("inferTagsByRule", () => {
  it("S・トリガー持ち呪文 → 受け", () => {
    expect(inferTagsByRule(card({ type: "spell", is_shield_trigger: true }))).toContain("受け");
  });

  it("『カードを2枚引く』コスト2 → ドロー+初動", () => {
    const tags = inferTagsByRule(card({ cost: 2, text: "カードを2枚引く。" }));
    expect(tags).toContain("ドロー");
    expect(tags).toContain("初動");
  });

  it("『山札の上から1枚目をマナゾーンに置く』コスト2 → ブースト+初動", () => {
    const tags = inferTagsByRule(card({ cost: 2, text: "山札の上から1枚目をマナゾーンに置く。" }));
    expect(tags).toContain("ブースト");
    expect(tags).toContain("初動");
  });

  it("『相手のクリーチャーを1体選び、破壊する』 → 除去", () => {
    expect(inferTagsByRule(card({ text: "相手のクリーチャーを1体選び、破壊する。" }))).toContain(
      "除去",
    );
  });

  it("コスト7・W・ブレイカー → フィニッシャー", () => {
    expect(inferTagsByRule(card({ cost: 7, text: "W・ブレイカー", power: 7000 }))).toContain(
      "フィニッシャー",
    );
  });

  it("『相手は呪文を唱えられない』 → メタ", () => {
    expect(inferTagsByRule(card({ text: "相手は呪文を唱えられない。" }))).toContain("メタ");
  });

  it("バニラ(効果なし・コスト5) → []", () => {
    expect(inferTagsByRule(card({ cost: 5, text: "" }))).toEqual([]);
  });

  it("複合(S・トリガー+破壊) → 受け と 除去", () => {
    const tags = inferTagsByRule(
      card({
        is_shield_trigger: true,
        text: "S・トリガー 相手のクリーチャーを1体選び、破壊する。",
      }),
    );
    expect(tags).toContain("受け");
    expect(tags).toContain("除去");
  });
});
