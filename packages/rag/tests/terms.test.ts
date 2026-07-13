import { describe, it, expect } from "vitest";
import { extractTerms } from "../src/terms.js";

describe("extractTerms (日本語クエリの検索語抽出)", () => {
  // 旧実装は query.split(/[\s　、。,.]/) で切っていた。日本語には空白が無いため
  // 「1ターンの流れを順番に教えてください」が丸ごと1トークンになり ILIKE が必ず0件になる。
  it("空白の無い日本語から内容語を取り出す", () => {
    expect(extractTerms("1ターンの流れを順番に教えてください。")).toEqual(["ターン", "順番"]);
  });

  it("S・トリガーのような中黒つき複合語を1語として保つ", () => {
    expect(extractTerms("シールドをブレイクされた時、S・トリガーはいつ使えますか？")).toEqual([
      "S・トリガー",
      "シールド",
      "ブレイク",
    ]);
  });

  it("ひらがなだけの助詞・語尾は落とす", () => {
    expect(extractTerms("これはどうなりますか")).toEqual([]);
  });

  it("1文字の漢字・裸の数字はノイズなので落とす", () => {
    expect(extractTerms("水の1")).toEqual([]);
  });

  it("条番号は検索語として残す (条文本文に番号が入っているため直接引ける)", () => {
    expect(extractTerms("500.6ってどういう意味ですか？")).toContain("500.6");
    expect(extractTerms("113.6aの扱いを教えて")).toContain("113.6a");
  });

  it("英字は2文字以上を残す (長い語が先)", () => {
    expect(extractTerms("EXライフとcipの処理")).toEqual(["ライフ", "cip", "EX", "処理"]);
  });

  it("長い語を優先して上限5語に絞る", () => {
    const terms = extractTerms("進化クリーチャーとタマシードとクロスギアと侵略と革命チェンジ");
    expect(terms.length).toBeLessThanOrEqual(5);
    expect(terms[0]).toBe("クリーチャー");
  });
});
