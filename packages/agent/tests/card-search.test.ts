import { describe, it, expect } from "vitest";
import { normalizeCardName, buildCardSearchArgs } from "../src/card-search.js";

describe("normalizeCardName", () => {
  // **本番で実際に踏んだバグ。** カード名は《ヘブンズ・ゲート》と中黒入り。
  // 利用者 (や LLM) が「ヘブンズゲート」と中黒抜きで書くと、素朴な ILIKE 部分一致は
  // **1件もヒットしない** → agent が 0件を「ツールのエラー」と誤解して
  // 「一時的なエラーが発生しているようです」と言い出す。
  it("中黒を落とす", () => {
    expect(normalizeCardName("ヘブンズ・ゲート")).toBe(normalizeCardName("ヘブンズゲート"));
    expect(normalizeCardName("ボルシャック・ドラゴン")).toBe(
      normalizeCardName("ボルシャックドラゴン"),
    );
  });

  it("空白を落とす (全角・半角)", () => {
    expect(normalizeCardName("接続 CS-20")).toBe(normalizeCardName("接続　CS-20"));
    expect(normalizeCardName("接続 CS-20")).toBe(normalizeCardName("接続CS-20"));
  });

  it("全角と半角を揃える", () => {
    expect(normalizeCardName("ＣＳ－２０")).toBe(normalizeCardName("CS-20"));
  });

  it("大文字小文字を揃える", () => {
    expect(normalizeCardName("Ｓ・トリガー")).toBe(normalizeCardName("sトリガー"));
  });

  it("カード名の囲み記号を落とす", () => {
    // 利用者は《》付きで書くことがある。公式サイトの表記も《》。
    expect(normalizeCardName("《ヘブンズ・ゲート》")).toBe(normalizeCardName("ヘブンズゲート"));
  });

  it("空文字でも落ちない", () => {
    expect(normalizeCardName("")).toBe("");
  });
});

describe("buildCardSearchArgs", () => {
  // **query が必須で min_cost が無い**ため、「コスト7以上のクリーチャー」が
  // **そもそも表現できない**。agent は仕方なく query に「コスト7以上」という
  // 意味的な語を入れ、部分一致で 0件になる (本番で実際に起きた)。

  it("query が無くても検索できる (コスト・文明だけの絞り込み)", () => {
    const a = buildCardSearchArgs({ min_cost: 7, type: "creature" });
    expect(a.ok).toBe(true);
  });

  it("絞り込みが1つも無いのは拒否する (全件返しても意味がない)", () => {
    const a = buildCardSearchArgs({});
    expect(a.ok).toBe(false);
  });

  it("min_cost と max_cost を両方使える", () => {
    const a = buildCardSearchArgs({ min_cost: 3, max_cost: 5 });
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.args.min_cost).toBe(3);
      expect(a.args.max_cost).toBe(5);
    }
  });

  it("文明の日本語表記を内部コードに直す", () => {
    // Gemini は「火」と日本語で渡してくることがある。enum は内部コード ("fire")。
    // そのままだと zod が弾き「ツール引数が不正です」になる。
    const a = buildCardSearchArgs({ civilization: "火" });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.args.civilization).toBe("fire");
  });

  it("カード種別の日本語表記も直す", () => {
    const a = buildCardSearchArgs({ type: "クリーチャー" });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.args.type).toBe("creature");
  });

  it("数値が文字列で来ても受ける", () => {
    // Gemini は数値を文字列で渡してくることがある。zod の z.number() は弾く。
    const a = buildCardSearchArgs({ max_cost: "5" });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.args.max_cost).toBe(5);
  });

  it("知らない文明・種別は落とす (捏造した値で検索させない)", () => {
    expect(buildCardSearchArgs({ civilization: "虹" }).ok).toBe(false);
    expect(buildCardSearchArgs({ type: "なにか" }).ok).toBe(false);
  });
});
