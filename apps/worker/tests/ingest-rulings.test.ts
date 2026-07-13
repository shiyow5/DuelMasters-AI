import { describe, it, expect } from "vitest";
import { pickQuestion } from "../src/jobs/ingest-rulings.js";

describe("pickQuestion", () => {
  // 公式ページの .question は、カード名リンクが壊れて中身が空のことがある。実際の HTML:
  //   <a href='/card/detail/?id='>《》</a>で、四隅に封印をつけるのは…
  // 一方 qa_old API の title にはカード名が入っている。ページ側を無条件に優先すると
  // **カード名が消えた裁定が RAG に入り**、カード名で検索しても引けなくなる。
  // 取込済み220件のうち8件 (3.6%) で発生していた。
  it("ページ側のカード名リンクが空なら API の title を採る", () => {
    const page = "《》で、四隅に封印をつけるのは《》上に置くのですか？";
    const title = "《FORBIDDEN STAR～世界最後の日～》で、四隅に封印をつけるのは《FORBIDDEN STAR～世界最後の日～》上に置くのですか？";
    expect(pickQuestion(page, title)).toBe(title);
  });

  it("ページ側が健全ならページ側を採る", () => {
    const page = "《ボルシャック・ドラゴン》の能力はどう処理しますか？";
    expect(pickQuestion(page, "別のタイトル")).toBe(page);
  });

  it("ページ側が空なら API の title を採る", () => {
    expect(pickQuestion("", "タイトル")).toBe("タイトル");
  });

  it("両方壊れていてもページ側を捨てない (情報を減らさない)", () => {
    const page = "《》の能力は？";
    expect(pickQuestion(page, "《》の能力は？")).toBe(page);
  });

  it("空でない括弧は壊れていないと見なす", () => {
    const page = "「革命チェンジ」と「Jチェンジ」は同時に使えますか？";
    expect(pickQuestion(page, "違うタイトル")).toBe(page);
  });
});
import { parseRulingHtml, parseRulingsArgs, dedupeRulingList } from "../src/jobs/ingest-rulings.js";

describe("parseRulingHtml", () => {
  it(".question / .answer を抽出する", () => {
    const html = `
      <div class="qabox01">
        <div class="question">Sトリガーはブロックされますか？</div>
        <div class="answer">いいえ、S・トリガーで唱えた呪文はブロックされません。</div>
      </div>`;
    const r = parseRulingHtml(html);
    expect(r.question).toContain("Sトリガー");
    expect(r.answer).toContain("ブロックされません");
  });

  it("回答が無ければ空文字", () => {
    const r = parseRulingHtml(`<div class="question">Q?</div>`);
    expect(r.answer).toBe("");
  });

  it("空白は正規化される", () => {
    const r = parseRulingHtml(`<div class="answer">  複数\n  行\t です </div>`);
    expect(r.answer).toBe("複数 行 です");
  });

  it("先頭の Q/A ラベル (半角/全角) を除去する", () => {
    const r = parseRulingHtml(
      `<div class="question">Q《カード》の質問？</div><div class="answer">Aはい、できます。</div>`,
    );
    expect(r.question).toBe("《カード》の質問？");
    expect(r.answer).toBe("はい、できます。");
  });
});

describe("parseRulingsArgs", () => {
  it("数値 limit を解釈", () => {
    expect(parseRulingsArgs(["300"])).toEqual({ limit: 300 });
  });
  it("引数なし/不正は limit 無し (全件)", () => {
    expect(parseRulingsArgs([])).toEqual({});
    expect(parseRulingsArgs(["abc"])).toEqual({});
    expect(parseRulingsArgs(["0"])).toEqual({});
  });
});

describe("dedupeRulingList", () => {
  // 公式サイトには改定前の裁定が残っており、同じ質問で結論が逆のペアが存在する。
  // 実例: qa_id 34932 は「能力→アンタップ→ドロー」、37341 は「アンタップ→能力→ドロー」。
  // 総合ルール 501.1/501.2/502.1 と一致するのは新しい 37341 の方。
  it("同じ質問なら qa_id が新しい方だけ残す", () => {
    const items = [
      { id: 34932, question: "「自分のターンのはじめに」で始まる能力があります。", link: "old" },
      {
        id: 37341,
        question: "【基本ルール】 「自分のターンのはじめに」で始まる能力があります。",
        link: "new",
      },
    ];
    expect(dedupeRulingList(items).map((i) => i.id)).toEqual([37341]);
  });

  it("質問が違えば両方残す", () => {
    const items = [
      { id: 1, question: "質問A", link: "a" },
      { id: 2, question: "質問B", link: "b" },
    ];
    expect(dedupeRulingList(items).map((i) => i.id)).toEqual([1, 2]);
  });

  it("先頭以外の【】は落とさない (別の裁定を同一視して消してしまわない)", () => {
    // 質問文中の【マナ武装】のような括弧を落とすと、別々の裁定が同じキーに潰れる。
    // 全件取込では新しい qa_id 以外が prune で DELETE されるため、正当な裁定が消える。
    const items = [
      { id: 100, question: "《A》の【マナ武装】は使えますか？", link: "a" },
      { id: 200, question: "《A》の【革命チェンジ】は使えますか？", link: "b" },
    ];
    expect(dedupeRulingList(items).map((i) => i.id)).toEqual([100, 200]);
  });

  it("元の並び順を保つ", () => {
    const items = [
      { id: 10, question: "質問A", link: "a" },
      { id: 5, question: "質問B", link: "b" },
      { id: 20, question: "質問A", link: "a2" },
    ];
    expect(dedupeRulingList(items).map((i) => i.id)).toEqual([5, 20]);
  });
});
