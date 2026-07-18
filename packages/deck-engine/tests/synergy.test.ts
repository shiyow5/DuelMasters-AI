import { describe, it, expect } from "vitest";
import type { Card } from "@dm-ai/core";
import { computeTribalSynergy } from "../src/synergy.js";

/**
 * 軽量シナジー信号 (#141 Stage 3 スライス1)。
 *
 * デッキの支配的な種族とその厚み (何枚が同じ種族か) を測る。DM は種族トライバルが強い
 * (ジョーカーズ 505枚, ハンター 394枚 …実測)。**確信が持てるときだけ**支配種族を返し、
 * 種族がバラけている / 種族カードが乏しいデッキは null (トライバルでないと判断)。
 */

function card(overrides: Partial<Card> = {}): Card {
  return {
    name: overrides.name ?? "テストカード",
    civilizations: overrides.civilizations ?? ["fire"],
    cost: overrides.cost ?? 3,
    type: overrides.type ?? "creature",
    races: overrides.races ?? [],
    text: overrides.text ?? "",
    power: overrides.power ?? 3000,
    is_rainbow: overrides.is_rainbow ?? false,
    is_shield_trigger: overrides.is_shield_trigger ?? false,
    tags: overrides.tags ?? [],
    card_image_url: null,
    official_id: null,
    set_code: null,
    rarity: null,
  };
}

function many(n: number, c: Card): Card[] {
  return Array.from({ length: n }, () => c);
}

describe("computeTribalSynergy (#141)", () => {
  it("同一種族が過半を占めると、その種族と枚数・比率を返す", () => {
    const deck = [
      ...many(24, card({ races: ["ジョーカーズ"] })),
      ...many(16, card({ races: [], type: "spell" })),
    ];
    const s = computeTribalSynergy(deck);
    expect(s?.tribe).toBe("ジョーカーズ");
    expect(s?.count).toBe(24);
    expect(s?.ratio).toBeCloseTo(0.6, 5);
  });

  it("多種族カードは各種族に計上する (支配種族を取りこぼさない)", () => {
    // アーマード・ドラゴン兼ハンター等、複数種族を持つカードは両方に数える。
    const deck = [
      ...many(20, card({ races: ["アーマード・ドラゴン", "ハンター"] })),
      ...many(20, card({ races: ["ハンター"] })),
    ];
    const s = computeTribalSynergy(deck);
    // ハンターは 40枚全部が持つので支配種族。
    expect(s?.tribe).toBe("ハンター");
    expect(s?.count).toBe(40);
  });

  it("種族がバラけていて支配種族が閾値未満なら null (トライバルでない)", () => {
    const deck = [
      ...many(10, card({ races: ["A"] })),
      ...many(10, card({ races: ["B"] })),
      ...many(10, card({ races: ["C"] })),
      ...many(10, card({ races: ["D"] })),
    ];
    // 最大でも 10/40 = 0.25 < 閾値 → トライバルでない
    expect(computeTribalSynergy(deck)).toBeNull();
  });

  it("種族を持つカードが乏しい (呪文主体) デッキは null", () => {
    const deck = many(40, card({ races: [], type: "spell" }));
    expect(computeTribalSynergy(deck)).toBeNull();
  });

  it("カードが少なすぎる (展開できていない) と null", () => {
    expect(computeTribalSynergy(many(5, card({ races: ["ジョーカーズ"] })))).toBeNull();
  });

  it("同率首位は決定的に決まる (種族名でタイブレーク)", () => {
    // 20 vs 20 の同率。実行ごとに結果が変わらないよう、名前順で決める。
    const deck = [
      ...many(20, card({ races: ["ゼータ"] })),
      ...many(20, card({ races: ["アルファ"] })),
    ];
    const s = computeTribalSynergy(deck);
    expect(s?.tribe).toBe("アルファ"); // 文字列順で先
    expect(s?.count).toBe(20);
  });
});
