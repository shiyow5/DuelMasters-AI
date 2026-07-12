import { describe, it, expect } from "vitest";
import { parseRulingHtml, parseRulingsArgs } from "../src/jobs/ingest-rulings.js";

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
