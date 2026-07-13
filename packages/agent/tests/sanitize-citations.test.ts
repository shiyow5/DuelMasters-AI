import { describe, it, expect } from "vitest";
import { sanitizeCitations } from "../src/citations.js";
import type { Citation } from "../src/state.js";

const cite = (article: string): Citation =>
  ({ article, text: "", doc_type: "comprehensive_rules" }) as unknown as Citation;

describe("sanitizeCitations", () => {
  // **プロンプトの指示だけでは防げないことを実測した。**
  // 「参考資料に出てこない条番号を書くな」と明示しても、agent は
  // 【総合ルール 114.6】【総合ルール 114.6a】をでっち上げた (114章は 114.1〜114.4 しかない)。
  // 利用者が 114.6 を調べに行って存在しないのが最悪なので、機械的に落とす。

  it("資料にある条番号はそのまま残す", () => {
    const text = "S・トリガーは任意です【総合ルール 113.6】。";
    const r = sanitizeCitations(text, [cite("113.6")]);
    expect(r.text).toBe(text);
    expect(r.stripped).toEqual([]);
  });

  it("資料に無い条番号は番号だけ落とし、主張は残す", () => {
    // 主張そのものは正しいことがある。番号だけ消して「総合ルールでは」に留める。
    // 文ごと消すと回答が意味不明になる。
    const r = sanitizeCitations("山札切れで敗北します【総合ルール 114.6】。", [cite("104.2")]);
    expect(r.text).toBe("山札切れで敗北します【総合ルール】。");
    expect(r.stripped).toEqual(["114.6"]);
  });

  it("実際に捏造されたケースを落とす (114.6 / 114.6a)", () => {
    const text =
      "【総合ルール 114.6】にある通り…。置換効果があれば回避できます（【総合ルール 114.6a】）。";
    const r = sanitizeCitations(text, [cite("104.2"), cite("703.4")]);
    expect(r.text).not.toContain("114.6");
    expect(r.stripped.sort()).toEqual(["114.6", "114.6a"]);
  });

  it("親条文を retrieve していれば枝番の引用は残す", () => {
    // 枝番 (104.2a) は親チャンク (104.2) の本文に埋まっており、citations には親しか載らない。
    // 落としてしまうと**正しい引用まで消える** (#92 で同じ誤判定をやった)。
    const text = "相手のシールドが0枚なら勝利します【総合ルール 104.2a】。";
    const r = sanitizeCitations(text, [cite("104.2")]);
    expect(r.text).toBe(text);
    expect(r.stripped).toEqual([]);
  });

  it("条番号の無い【総合ルール】は触らない", () => {
    const text = "【総合ルール】に定めがあります。【裁定Q&A】も参照。";
    expect(sanitizeCitations(text, []).text).toBe(text);
  });

  it("同じ捏造番号が複数回出てもすべて落とし、報告は1件にまとめる", () => {
    const r = sanitizeCitations("【総合ルール 999.9】と【総合ルール 999.9】", [cite("113.6")]);
    expect(r.text).toBe("【総合ルール】と【総合ルール】");
    expect(r.stripped).toEqual(["999.9"]);
  });

  it("資料が空なら条番号はすべて落とす", () => {
    const r = sanitizeCitations("【総合ルール 113.6】", []);
    expect(r.text).toBe("【総合ルール】");
    expect(r.stripped).toEqual(["113.6"]);
  });

  it("空文字でも落ちない", () => {
    expect(sanitizeCitations("", [])).toEqual({ text: "", stripped: [] });
  });
});
