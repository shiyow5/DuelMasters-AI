import { describe, it, expect } from "vitest";
import { inferTagsByRule, isDefensiveCard } from "../src/tagger.js";
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

/**
 * **カードテキストの数字はほぼ全角** (#120)。
 *
 * 公式サイトは「カードを２枚引く」と書く。実測: 全角 1279件 / 半角 4件。
 * `\d` は全角にマッチしないので `/カードを(\d+枚)?引/` は**約1263件のドロー札を
 * 取りこぼしていた** (ドロータグが付いたのは 16件だけ)。#111 の中黒と同じ病気。
 */
describe("全角表記 (実データはほぼ全角)", () => {
  const base = {
    name: "x",
    civilizations: ["water"] as never,
    type: "spell" as never,
    races: [],
    power: null,
    is_rainbow: false,
    is_shield_trigger: false,
    tags: [],
    card_image_url: null,
    official_id: null,
    set_code: null,
    rarity: null,
  };

  it("「カードを２枚引く」(全角) をドローとして拾う", () => {
    expect(inferTagsByRule({ ...base, cost: 3, text: "＊カードを２枚引く。" })).toContain("ドロー");
  });

  it("半角も従来どおり拾う", () => {
    expect(inferTagsByRule({ ...base, cost: 3, text: "カードを2枚引く。" })).toContain("ドロー");
  });

  it("全角のドロー札は「初動」にもなる (コスト3以下)", () => {
    // 初動は ブースト/ドロー を前提にするので、ドローを取りこぼすと初動も落ちる。
    expect(inferTagsByRule({ ...base, cost: 2, text: "＊カードを２枚引く。" })).toContain("初動");
  });

  it("「Ｗ・ブレイカー」(全角W) をフィニッシャーとして拾う", () => {
    expect(
      inferTagsByRule({ ...base, cost: 7, type: "creature" as never, text: "＊Ｗ・ブレイカー" }),
    ).toContain("フィニッシャー");
  });

  it("「Ｇ・ストライク」(全角G) を受けとして拾う", () => {
    expect(isDefensiveCard({ ...base, cost: 5, text: "＊Ｇ・ストライク" })).toBe(true);
  });
});

describe("ドローの表現ゆれ (#120)", () => {
  const base = {
    name: "x",
    civilizations: ["water"] as never,
    type: "spell" as never,
    races: [],
    power: null,
    is_rainbow: false,
    is_shield_trigger: false,
    tags: [],
    card_image_url: null,
    official_id: null,
    set_code: null,
    rarity: null,
    cost: 3,
  };

  it("「カードを３枚まで引く」(《サイバー・ブレイン》) を拾う", () => {
    // 「まで」を許さないと落ちる。実測で +60件。
    expect(inferTagsByRule({ ...base, text: "＊カードを３枚まで引く。" })).toContain("ドロー");
  });

  it("「カードを２枚まで引き」(連用形) も拾う", () => {
    expect(inferTagsByRule({ ...base, text: "カードを２枚まで引き、その後…" })).toContain("ドロー");
  });

  it("**相手のドローは自分のドローソースではない**", () => {
    // ここを広く取ると「相手はカードを1枚引く」(58件) を誤検出する。
    expect(inferTagsByRule({ ...base, text: "相手はカードを１枚引く。" })).not.toContain("ドロー");
  });
});

describe("相手のドローを巻き込まない (#120)", () => {
  const base = {
    name: "x",
    civilizations: ["water"] as never,
    type: "creature" as never,
    races: [],
    power: 3000,
    is_rainbow: false,
    is_shield_trigger: false,
    tags: [],
    card_image_url: null,
    official_id: null,
    set_code: null,
    rarity: null,
    cost: 4,
  };

  it("《黒神龍ザルバ》型: 相手だけが引く → ドローではない (実測 37件)", () => {
    expect(
      inferTagsByRule({ ...base, text: "＊このクリーチャーが出た時、相手はカードを１枚引く。" }),
    ).not.toContain("ドロー");
  });

  it("《侵略者 BJ》型: 「相手の」が条件に出るが引くのは自分 → ドロー", () => {
    // 「相手」を含む文を丸ごと捨てる実装だと、これを巻き添えで落とす。
    expect(
      inferTagsByRule({
        ...base,
        text: "＊このクリーチャーが攻撃する時、相手のシールドが1つ以下なら、カードを1枚まで引く。",
      }),
    ).toContain("ドロー");
  });

  it("相手も自分も引く → 自分のドローがあるのでドロー", () => {
    expect(
      inferTagsByRule({ ...base, text: "相手はカードを１枚引く。その後、カードを３枚引く。" }),
    ).toContain("ドロー");
  });
});
