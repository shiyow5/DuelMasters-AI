import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CitationItem } from "../src/components/Citations.js";
import { citationHref } from "../src/lib/citation.js";
import type { Citation } from "../src/lib/types.js";

/**
 * 「出典を開く」の href も Markdown のリンクと同じ許可制 (safeUrl) で通す。
 * ケースは markdown.test.ts の safeUrl と揃える。
 */
const cite = (url?: unknown): Citation => ({ text: "本文", doc_type: "faq", url }) as Citation;
const render = (c: Citation) => renderToStaticMarkup(createElement(CitationItem, { c }));

const ALLOWED = [
  "https://dm.takaratomy.co.jp/",
  "http://example.test/a",
  "mailto:a@example.test",
  "/rule",
  "#section",
  "./a/b",
];

const BLOCKED = [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "  javascript:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "java\0script:alert(1)",
  "data:text/html;base64,PHNjcmlwdD4=",
  "vbscript:msgbox(1)",
];

describe("citationHref", () => {
  it("http / https / mailto と相対リンクは通す", () => {
    for (const url of ALLOWED) expect(citationHref(cite(url))).toBe(url);
  });

  it("javascript: / data: / vbscript: は空文字 (制御文字・大文字・空白でも)", () => {
    for (const url of BLOCKED) expect(citationHref(cite(url))).toBe("");
  });

  it("url が無い・文字列でない・空なら空文字", () => {
    expect(citationHref(cite())).toBe("");
    expect(citationHref(cite(123))).toBe("");
    expect(citationHref(cite(""))).toBe("");
  });
});

describe("CitationItem", () => {
  it("許可された URL はリンクを出す", () => {
    const html = render(cite("https://dm.takaratomy.co.jp/"));
    expect(html).toContain('href="https://dm.takaratomy.co.jp/"');
    expect(html).toContain("出典を開く");
  });

  it("ブロックされた URL はリンク自体を出さない (本文は出す)", () => {
    for (const url of BLOCKED) {
      const html = render(cite(url));
      expect(html).not.toContain("<a");
      expect(html).not.toMatch(/script:/i);
      expect(html).toContain("本文");
    }
  });

  it("url が無ければリンクを出さない", () => {
    expect(render(cite())).not.toContain("<a");
  });
});
