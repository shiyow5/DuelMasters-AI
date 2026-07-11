import { describe, it, expect } from "vitest";
import { extractTextFromHtml } from "../src/html.js";

describe("extractTextFromHtml", () => {
  it("script/style/nav/footer を除去して本文だけを残す", () => {
    const html = `
      <html><head><style>.x{color:red}</style></head>
      <body>
        <nav>ナビゲーション</nav>
        <script>var a = 1;</script>
        <main>本文テキストです</main>
        <footer>フッター情報</footer>
      </body></html>`;
    const text = extractTextFromHtml(html);
    expect(text).toContain("本文テキストです");
    expect(text).not.toContain("ナビゲーション");
    expect(text).not.toContain("var a = 1");
    expect(text).not.toContain("フッター情報");
    expect(text).not.toContain("color:red");
  });

  it("3連続以上の改行が2つに圧縮される", () => {
    expect(extractTextFromHtml("<body>A\n\n\n\nB</body>")).toBe("A\n\nB");
  });
});
