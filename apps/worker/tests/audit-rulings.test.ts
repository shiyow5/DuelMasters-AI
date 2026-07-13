import { describe, it, expect } from "vitest";
import {
  isCardSpecific,
  verifyGrounding,
  buildAuditPrompt,
  type RuleArticle,
} from "../src/jobs/audit-rulings.js";

describe("isCardSpecific", () => {
  // 公式サイトはカード名の囲みを1種類に統一していない。実測すると《》(3649回) のほかに
  // 「」ではない ≪≫ (U+226A/226B, 38回)、『』(22回)、« » (U+00AB/00BB) が混在する。
  // 《》だけを見ていると、カード個別裁定を「一般ルール裁定」と誤判定して監査対象が膨らむ。
  it("《》で囲まれたカード名を認識する", () => {
    expect(isCardSpecific("《接続 CS-20》が2体バトルゾーンにいる場合どうなりますか？")).toBe(true);
  });

  it("≪≫ (U+226A 数学記号) で囲まれたカード名も認識する", () => {
    expect(isCardSpecific("≪サイバー・K・ウォズレック≫の能力で呪文を唱えた場合は？")).toBe(true);
  });

  it("『』で囲まれたカード名も認識する", () => {
    expect(isCardSpecific("『超神星アポロヌス・ドラゲリオン』のワールドブレイカーは？")).toBe(true);
  });

  it("« » (ギルメット) で囲まれたカード名も認識する", () => {
    expect(isCardSpecific("«霊魔の覚醒者シューヴェルト»がバトルゾーンを離れる場合は？")).toBe(true);
  });

  it("一般ルールの質問はカード個別ではない", () => {
    // 実データ: qa_id 34932 (総合ルール 501.1/501.2 と矛盾する既知の廃止裁定)
    expect(
      isCardSpecific("「自分のターンのはじめに」で始まる能力があります。このタイミングがよくわからないのですが。"),
    ).toBe(false);
    expect(isCardSpecific("オレガ・オーラが付いたクリーチャーが進化したらどうなりますか？")).toBe(false);
    expect(isCardSpecific("マナゾーンにすべての文明が揃っているかどうか見るのは、どのタイミングでですか？")).toBe(false);
  });

  it("鉤括弧「」はキーワード表記なのでカード名として扱わない", () => {
    // 「革命チェンジ」「Jチェンジ」等の能力名は「」で囲まれる。これをカード名と誤認すると
    // 一般ルール裁定 (最も矛盾しやすい) が監査対象から丸ごと漏れる。
    expect(isCardSpecific("「革命チェンジ」と「Jチェンジ」を同時に使うことは出来ますか？")).toBe(false);
  });
});

describe("verifyGrounding", () => {
  const articles: RuleArticle[] = [
    {
      article: "501.1",
      text: "501. ターン開始ステップ 501.1. ターン・プレイヤーは、自分のカードのうちでどれをアンタップするかを決定し、それ\nらを同時にアンタップします。これはターン起因処理です。",
    },
    { article: "502.1", text: "502. ドローステップ 502.1. ターン・プレイヤーはカードを1枚引きます。" },
  ];

  it("実在する条文の逐語引用なら通す", () => {
    const v = verifyGrounding(
      { contradicts: true, article: "501.1", quote: "自分のカードのうちでどれをアンタップするかを決定し", reason: "順序が逆" },
      articles,
    );
    expect(v.ok).toBe(true);
  });

  it("PDF 由来の改行・空白差を無視して一致させる", () => {
    // 総合ルールは PDF 抽出なので原文に折り返し空白が入る (「それ\nらを同時に」)。
    // LLM は空白を詰めて引用してくるため、素の substring 判定だと正しい引用まで落ちる。
    const v = verifyGrounding(
      { contradicts: true, article: "501.1", quote: "それらを同時にアンタップします", reason: "順序が逆" },
      articles,
    );
    expect(v.ok).toBe(true);
  });

  it("存在しない条番号は落とす (ハルシネーション対策)", () => {
    const v = verifyGrounding(
      { contradicts: true, article: "999.9", quote: "そんな条文はない", reason: "でっちあげ" },
      articles,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("条文が存在しない");
  });

  it("条文は実在しても引用がその条文に無ければ落とす", () => {
    // judge はこれまで4回間違えた。条番号だけ合っていて中身を捏造するのが最も危険なので、
    // 引用が条文の逐語部分列であることを機械的に確かめる。
    const v = verifyGrounding(
      { contradicts: true, article: "502.1", quote: "誘発する能力が先に処理されます", reason: "順序" },
      articles,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("引用が条文に無い");
  });

  it("contradicts=false は矛盾なしとして落とす", () => {
    const v = verifyGrounding(
      { contradicts: false, article: "501.1", quote: "ターン起因処理です", reason: "整合" },
      articles,
    );
    expect(v.ok).toBe(false);
  });

  it("引用が短すぎると偶然一致するので落とす", () => {
    // 「の」1文字でも substring 判定は通ってしまう。根拠として機能する長さを要求する。
    const v = verifyGrounding(
      { contradicts: true, article: "501.1", quote: "です", reason: "短い" },
      articles,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("引用が短すぎる");
  });

  it("空の条番号・引用は落とす", () => {
    expect(verifyGrounding({ contradicts: true, article: "", quote: "", reason: "" }, articles).ok).toBe(false);
  });
});

describe("buildAuditPrompt", () => {
  const articles: RuleArticle[] = [{ article: "501.1", text: "501.1. まずアンタップします。" }];

  it("裁定文と条文の両方をプロンプトに含める", () => {
    const p = buildAuditPrompt("Q: ターンのはじめは？\nA: 先に誘発します。", articles);
    expect(p).toContain("先に誘発します");
    expect(p).toContain("501.1");
    expect(p).toContain("まずアンタップします");
  });

  it("条文の逐語引用を要求する (根拠なしの判定を防ぐ)", () => {
    const p = buildAuditPrompt("Q\nA", articles);
    expect(p).toMatch(/逐語|そのまま|コピー/);
  });
});
