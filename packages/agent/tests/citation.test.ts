import { describe, it, expect } from "vitest";
import { citedArticles, citationGrounding } from "../eval/metrics.js";

describe("citedArticles", () => {
  // RAG は【総合ルール 113.6】の形で資料を渡す。回答本文にも同じ形で書かせる。
  it("本文から条番号を取り出す", () => {
    const text = "S・トリガーは任意です【総合ルール 113.6】。ブロックは【総合ルール 115.2】。";
    expect(citedArticles(text)).toEqual(["113.6", "115.2"]);
  });

  it("枝番も取り出す", () => {
    expect(citedArticles("【総合ルール 501.2a】のとおりです")).toEqual(["501.2a"]);
  });

  it("空白の有無を問わない", () => {
    expect(citedArticles("【総合ルール113.6】と【総合ルール  115.2】")).toEqual(["113.6", "115.2"]);
  });

  it("同じ条番号を2回書いても1つに数える", () => {
    expect(citedArticles("【総合ルール 113.6】…【総合ルール 113.6】")).toEqual(["113.6"]);
  });

  it("条番号の無い出典ラベルは拾わない", () => {
    // 【裁定Q&A】【FAQ】には条番号が無い。条番号の実在検証はできないので対象外。
    expect(citedArticles("【裁定Q&A】によると…【FAQ】にも…")).toEqual([]);
    expect(citedArticles("【総合ルール】に定めがあります")).toEqual([]);
  });

  it("出典ラベルの外にある数字は拾わない", () => {
    // 「4枚制限」「2ブロック」のような本文中の数字を条番号と誤認しない。
    expect(citedArticles("同名カードは4枚まで。コストは3.5ではない。")).toEqual([]);
  });

  it("空文字でも落ちない", () => {
    expect(citedArticles("")).toEqual([]);
  });
});

describe("citationGrounding", () => {
  // **これが #99 の要**。LLM は実在しない条番号を平然と書く (eval で【総合ルール 114.6】を
  // 捏造した。114章は 114.4 までしか無い)。
  //
  // 本文は agent の toOutput で **既にサニタイズ済み** (捏造番号は落ちている) なので、
  // 本文だけ見ると常に 1.0 になり指標が死ぬ。**落とした番号** (ungroundedCitations) を
  // 足し戻して率を出す。

  it("捏造が無ければ 1.0", () => {
    expect(citationGrounding("【総合ルール 113.6】【総合ルール 115.2】", [])).toBe(1);
  });

  it("落とされた番号があれば下がる", () => {
    // 本文に残った 113.6 (裏取り済み) 1件 + 落とされた 999.9 が1件 → 0.5
    expect(citationGrounding("【総合ルール 113.6】と【総合ルール】", ["999.9"])).toBe(0.5);
  });

  it("全部でっちあげたら 0", () => {
    expect(citationGrounding("【総合ルール】", ["114.6", "114.6a"])).toBe(0);
  });

  it("条番号を1つも引いていなければ null (計測対象外)", () => {
    // 「引用が無い」と「引用が全部でっちあげ」を混同しない。デッキ相談などは条文を
    // 引かないのが正常なので、0 として平均に混ぜるとゲートが壊れる。
    expect(citationGrounding("デッキの改善案です。", [])).toBeNull();
    expect(citationGrounding("", [])).toBeNull();
  });
});
