import { describe, it, expect } from "vitest";
import { archetypeCoreName } from "../src/archetype.js";

/**
 * アーキタイプ名 → カード名の照合 (#122)。
 *
 * 環境分析のデッキに**メインカードの画像**を出したい。アーキタイプ名は「**色 + カード名**」の
 * 複合語なので、素朴な部分一致では当たらない (実測 8件中2件)。色の接頭辞を落とすと 5件当たる。
 *
 * 下の期待値は**本番相当データ (11563件) で実際に照合して確かめたもの**。
 */
describe("archetypeCoreName (色の接頭辞を落とす)", () => {
  it.each([
    ["トリーヴァアルファディオス", "アルファディオス"],
    ["赤単我我我", "我我我"],
    ["青黒魔導具", "魔導具"],
    ["アナカラーデイヤー", "デイヤー"],
    ["5cモルト", "モルト"],
    ["白青メタリカ", "メタリカ"],
  ])("%s → %s", (input, expected) => {
    expect(archetypeCoreName(input)).toBe(expected);
  });

  it("**長い接頭辞から試す** (「赤」を先に当てると「赤単我我我」が壊れる)", () => {
    // 「赤単」を落として「我我我」。「赤」だけ落として「単我我我」になってはいけない。
    expect(archetypeCoreName("赤単我我我")).toBe("我我我");
    expect(archetypeCoreName("赤単我我我")).not.toContain("単");
  });

  it("色の接頭辞が無ければそのまま", () => {
    expect(archetypeCoreName("ウィリデ")).toBe("ウィリデ");
    expect(archetypeCoreName("創世竜")).toBe("創世竜");
  });

  it("落とすと空になるなら落とさない (色だけのアーキタイプ名)", () => {
    // 「赤単」だけのアーキタイプ名を空文字にすると、全カードにマッチしてしまう。
    expect(archetypeCoreName("赤単")).toBe("赤単");
    expect(archetypeCoreName("アナカラー")).toBe("アナカラー");
  });

  it("全角/半角を揃える (５ｃ → 5c)", () => {
    expect(archetypeCoreName("５ｃモルト")).toBe("モルト");
  });

  /**
   * デッキ名の飾り (#131)。
   *
   * 本番の主要ティアで画像が出ていなかった実例を、実データで裏取りして直したもの:
   *   「モルト系」    → `%モルト系%` は0件。「モルト」なら **15件** (《龍覇 グレンモルト》等)
   *   「ドッコイループ」→ `%ドッコイループ%` は0件。「ドッコイ」なら **2件** (《空神のD ドッコイ》等)
   * 飾りはカード名には現れないので、照合前に落とす。
   */
  it.each([
    ["モルト系", "モルト"],
    ["ドッコイループ", "ドッコイ"],
    ["メタリカデッキ", "メタリカ"],
    // 色接頭辞の直後に残る「系」も落とす (「アナカラー系〜」)
    ["アナカラー系革命チェンジ", "革命チェンジ"],
    // 接頭辞 + 飾りの複合
    ["5cモルト系", "モルト"],
  ])("デッキ名の飾りを落とす: %s → %s", (input, expected) => {
    expect(archetypeCoreName(input)).toBe(expected);
  });

  it("飾りだけのアーキタイプ名は落とさない (全カードに当たってしまう)", () => {
    // 落として空にすると `%%` になり、無関係なカードを引いてしまう。
    expect(archetypeCoreName("ループ")).toBe("ループ");
    expect(archetypeCoreName("デッキ")).toBe("デッキ");
    expect(archetypeCoreName("系")).toBe("系");
  });

  it("空でも落ちない", () => {
    expect(archetypeCoreName("")).toBe("");
    expect(archetypeCoreName("   ")).toBe("");
  });
});
