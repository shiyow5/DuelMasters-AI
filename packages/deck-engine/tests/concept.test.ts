import { describe, it, expect } from "vitest";
import type { Card } from "@dm-ai/core";
import { inferDeckConcept, isRelaxedConcept, conceptLabel } from "../src/concept.js";

/**
 * デッキ戦略コンセプト検出 (#130)。
 *
 * カード単位の役割タグ (#120) では表せない「デッキ全体の戦略」を粗く分類する。
 * 確信が持てないときは unknown を返し、scorer は緩和しない (= 現行の採点)。
 */

/** テスト用カード生成 (DB 非依存)。既定はバニラのクリーチャー。 */
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

/** n 枚の同じカードを並べる。 */
function many(n: number, c: Card): Card[] {
  return Array.from({ length: n }, () => c);
}

describe("inferDeckConcept (#130)", () => {
  it("コンボ信号が2種以上かつ合計6枚以上なら combo (1〜2部品のループを拾う)", () => {
    const deck = [
      ...many(4, card({ name: "ループA", text: "無限にマナを生み出す", cost: 5 })),
      ...many(4, card({ name: "ループB", text: "好きなだけ召喚する", cost: 4 })),
      ...many(32, card({ name: "無地", text: "" })),
    ];
    // 2種 × 各4枚 = 8枚 → combo
    expect(inferDeckConcept(deck)).toBe("combo");
  });

  it("同じコンボ信号カードを1プレイセット (1種4枚) 積んだだけでは combo にしない", () => {
    // 汎用ドロー呪文を4枚積んだだけのビートダウンが combo と誤判定される事故を防ぐ (レビュー指摘)。
    const deck = [
      ...many(4, card({ name: "汎用ドロー", text: "無限の可能性を秘めたカードを引く", cost: 3 })),
      ...many(36, card({ name: "無地", text: "", cost: 3 })),
    ];
    // 1種のみ (合計4枚) → combo でない
    expect(inferDeckConcept(deck)).not.toBe("combo");
  });

  it("コンボ信号が3種でも各1枚 (合計3枚) なら combo にしない (合計枚数の下限)", () => {
    // まばらな splash / 制限カードでスコアが緩まないようにする (Codex/レビュー指摘)。
    const deck = [
      card({ name: "散らしA", text: "無限の可能性", cost: 5 }),
      card({ name: "散らしB", text: "好きなだけ", cost: 5 }),
      card({ name: "散らしC", text: "繰り返す", cost: 5 }),
      ...many(37, card({ name: "無地", text: "", cost: 5 })),
    ];
    // 3種だが合計3枚 (< 6) → combo でない
    expect(inferDeckConcept(deck)).not.toBe("combo");
  });

  it("クリーチャーが少なく受け+除去が厚いと control", () => {
    const deck = [
      // 除去呪文 12枚
      ...many(12, card({ type: "spell", cost: 5, text: "相手のクリーチャーを1体破壊する" })),
      // 受け (S・トリガー) 呪文 8枚
      ...many(8, card({ type: "spell", cost: 4, is_shield_trigger: true, text: "相手を止める" })),
      // クリーチャーは少数 (比率 <= 0.4)
      ...many(8, card({ type: "creature", cost: 7, text: "" })),
      ...many(12, card({ type: "spell", cost: 3, text: "カードを2枚引く" })),
    ];
    const c = inferDeckConcept(deck);
    expect(c).toBe("control");
  });

  it("クリーチャー主体で低コストだと beatdown", () => {
    const deck = many(40, card({ type: "creature", cost: 2, text: "" }));
    expect(inferDeckConcept(deck)).toBe("beatdown");
  });

  it("どれの条件も満たさない中庸なデッキは unknown", () => {
    // クリーチャー比 0.5、平均コスト 4.5、コンボ信号なし、相互作用薄い
    const deck = [
      ...many(20, card({ type: "creature", cost: 5, text: "" })),
      ...many(20, card({ type: "spell", cost: 4, text: "マナを1枚増やす" })),
    ];
    expect(inferDeckConcept(deck)).toBe("unknown");
  });

  it("カード数が少なすぎる (展開できていない) と unknown", () => {
    const deck = many(5, card({ text: "無限に繰り返す好きなだけ" }));
    expect(inferDeckConcept(deck)).toBe("unknown");
  });

  it("墓地回収や踏み倒し等の一般的な語だけでは combo と誤検出しない", () => {
    // これらは多くのデッキに出るので COMBO_SIGNAL に含めていない
    const deck = [
      ...many(6, card({ text: "墓地からクリーチャーを1体召喚する", cost: 6 })),
      ...many(6, card({ text: "コストを支払わずに唱えてもよい", cost: 5 })),
      ...many(28, card({ text: "", cost: 3 })),
    ];
    expect(inferDeckConcept(deck)).not.toBe("combo");
  });

  it("isRelaxedConcept は combo/control のみ true", () => {
    expect(isRelaxedConcept("combo")).toBe(true);
    expect(isRelaxedConcept("control")).toBe(true);
    expect(isRelaxedConcept("beatdown")).toBe(false);
    expect(isRelaxedConcept("unknown")).toBe(false);
  });

  it("conceptLabel は日本語ラベルを返す", () => {
    expect(conceptLabel("combo")).toBe("コンボ");
    expect(conceptLabel("control")).toBe("コントロール");
    expect(conceptLabel("unknown")).toBe("不明");
  });
});
