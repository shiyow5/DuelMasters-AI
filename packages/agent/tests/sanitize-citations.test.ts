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

  // --- 書式のゆらぎ ---------------------------------------------------------
  //
  // 最初の実装は `【総合ルール 113.6】` という**厳密な形しか見ておらず**、自分で攻撃したら
  // 8通りの抜け道が見つかった。「見たことのある書式だけ守る防御」は防御ではない。
  // 抜けると**捏造した条番号が利用者に届く** — この機構が存在する理由そのものが崩れる。

  describe("書式がぶれても捏造を通さない", () => {
    const cites = [cite("113.6")];
    const leaks = (text: string) => sanitizeCitations(text, cites).text;

    it("太字がラベルの内側にあっても落とす", () => {
      // agent は Markdown で書くので `【**総合ルール 114.6**】` は現実に起こりうる。
      expect(leaks("【**総合ルール 114.6**】")).not.toContain("114.6");
    });

    it("コロン区切りでも落とす", () => {
      expect(leaks("【総合ルール: 114.6】")).not.toContain("114.6");
    });

    it("1つのラベルに複数の番号があっても落とす", () => {
      const r = sanitizeCitations("【総合ルール 114.6と115.2】", cites);
      expect(r.text).not.toContain("114.6");
      expect(r.text).not.toContain("115.2");
      expect(r.stripped.sort()).toEqual(["114.6", "115.2"]);
    });

    it("複数番号のうち裏取りできたものは残す", () => {
      const r = sanitizeCitations("【総合ルール 113.6と114.6】", cites);
      expect(r.text).toContain("113.6");
      expect(r.text).not.toContain("114.6");
      expect(r.stripped).toEqual(["114.6"]);
    });

    it("全角の数字でも落とす", () => {
      const r = sanitizeCitations("【総合ルール １１４．６】", cites);
      expect(r.text).not.toMatch(/１１４．６/);
      expect(r.stripped).toEqual(["114.6"]);
    });

    it("全角の囲みでも落とす", () => {
      expect(leaks("［総合ルール 114.6］")).not.toContain("114.6");
    });

    it("ラベルの外に裸で書かれた条番号も落とす", () => {
      // 「条文 114.6 によれば」のように、【】を使わずに書いてくることがある。
      const r = sanitizeCitations("条文 114.6 によれば敗北します。", cites);
      expect(r.text).not.toContain("114.6");
      expect(r.stripped).toEqual(["114.6"]);
    });

    it("枝番が2文字の番号は総合ルールに存在しない形なので落とす", () => {
      // 親 (104.2) を retrieve していても、104.2ab という条文は無い。**知らない形は通さない。**
      const r = sanitizeCitations("【総合ルール 104.2ab】", [cite("104.2")]);
      expect(r.text).toBe("【総合ルール】");
      expect(r.stripped).toEqual(["104.2ab"]);
    });

    it("3階層の番号も存在しない形なので落とす", () => {
      const r = sanitizeCitations("【総合ルール 114.6.1】", [cite("114.6")]);
      expect(r.text).toBe("【総合ルール】");
      expect(r.stripped).toEqual(["114.6.1"]);
    });

    it("裏取りできていれば装飾はそのまま残す", () => {
      // 全部通ったラベルには触らない (太字などを壊さない)。
      const text = "**【総合ルール 113.6】**";
      expect(sanitizeCitations(text, cites).text).toBe(text);
    });

    it("citations の article が数値でも照合できる", () => {
      const numeric = [{ article: 113.6, text: "", doc_type: "comprehensive_rules" }];
      const r = sanitizeCitations("【総合ルール 113.6】", numeric as unknown as Citation[]);
      expect(r.stripped).toEqual([]);
    });

    it("キーワードに空白を挟んでも落とす", () => {
      // 「総合 ルール」でキーワード一致を外す手。
      const r = sanitizeCitations("【 総合 ルール   114.6 】", cites);
      expect(r.text).not.toContain("114.6");
      expect(r.stripped).toEqual(["114.6"]);
    });

    it("ゼロ幅スペースを挟んでも落とす", () => {
      // `114​.6` は目には 114.6 に見えるが、素の正規表現はすり抜ける。
      const r = sanitizeCitations("【総合ルール 114​.6】", cites);
      expect(r.text).not.toMatch(/114/);
      expect(r.stripped).toEqual(["114.6"]);
    });

    it("小数点の無い節番号も検証する", () => {
      // 【総合ルール 500】のような節への言及。小数点を必須にしていると**素通り**し、
      // 【総合ルール 999】まで通ってしまう (eval で agent が実際に 500 を引いた)。
      const withSection = [
        { article: "500.1", section: "500", text: "", doc_type: "comprehensive_rules" },
      ] as unknown as Citation[];
      // 500 は retrieve した条文の節 → 残す
      expect(sanitizeCitations("【総合ルール 500】", withSection).text).toBe("【総合ルール 500】");
      // 999 はどの節でもない → 落とす
      const r = sanitizeCitations("【総合ルール 999】", withSection);
      expect(r.text).toBe("【総合ルール】");
      expect(r.stripped).toEqual(["999"]);
    });

    it("条番号から節を導けるので section メタが無くても通る", () => {
      // citations に section が載らない経路もある。article の親から節を復元する。
      const r = sanitizeCitations("【総合ルール 113】", [cite("113.6")]);
      expect(r.text).toBe("【総合ルール 113】");
      expect(r.stripped).toEqual([]);
    });

    it("「114.6条によれば」(番号の後ろにキーワード) も落とす", () => {
      // 日本語ではこちらが自然。前方キーワードしか見ていない実装は**素通りしていた**。
      const r = sanitizeCitations("114.6条によれば敗北します。", cites);
      expect(r.text).not.toContain("114.6");
      expect(r.stripped).toEqual(["114.6"]);
    });

    it("ルールブックの版数 (1.50) を条番号と誤認しない", () => {
      // **3桁始まりでない数字は条番号ではない。** 触ると本文が壊れる。
      const r = sanitizeCitations("総合ルール 1.50版に基づきます。", cites);
      expect(r.text).toBe("総合ルール 1.50版に基づきます。");
      expect(r.stripped).toEqual([]);
    });

    it("ラベル内の年号を条番号と誤認してラベルごと潰さない", () => {
      // 【総合ルール第113.6条(2020年)】 の 2020 を条番号と誤認すると、
      // 裏取り済みの 113.6 まで巻き添えでラベルごと消える。
      const r = sanitizeCitations("【総合ルール第113.6条(2020年)】", cites);
      expect(r.text).toContain("113.6");
      expect(r.stripped).toEqual([]);
    });

    it("裸の番号 (キーワード無し) は落とさない — 正当な数字を壊さないため", () => {
      // **意図的な残余リスク。** `\d+\.\d+` を無条件に落とすと「勝率 52.3%」「コスト 3.5」
      // まで壊れる。過剰除去のほうが害が大きい。
      const r = sanitizeCitations("勝率は 52.3% で、平均コストは 3.5 です。", cites);
      expect(r.text).toContain("52.3");
      expect(r.text).toContain("3.5");
      expect(r.stripped).toEqual([]);
    });
  });
});
