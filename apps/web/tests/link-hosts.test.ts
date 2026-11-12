import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../src/components/Markdown.js";
import { ALLOWED_LINK_HOSTS, isAllowedLink } from "../src/lib/link-hosts.js";

const render = (markdown: string) => renderToStaticMarkup(createElement(Markdown, null, markdown));

describe("ALLOWED_LINK_HOSTS (#254 M-3 ③)", () => {
  it("許可ホストは 1 か所に定義され、実際の出典ドメインを含む", () => {
    expect([...ALLOWED_LINK_HOSTS]).toEqual([
      "dm.takaratomy.co.jp",
      "supersolenoid.jp",
      "deneblog.jp",
    ]);
  });
});

describe("isAllowedLink", () => {
  it("許可ホストの http(s) は通す", () => {
    expect(isAllowedLink("https://dm.takaratomy.co.jp/rule/")).toBe(true);
    expect(isAllowedLink("http://supersolenoid.jp/blog-entry-1.html")).toBe(true);
    expect(isAllowedLink("https://DM.TAKARATOMY.CO.JP/x")).toBe(true);
  });

  it.each([
    "https://evil.invalid/login",
    "https://dm.takaratomy.co.jp.evil.invalid/", // 前方一致の偽装
    "https://evildm.takaratomy.co.jp/", // サブドメインは許可しない (完全一致)
    "https://dm.takaratomy.co.jp@evil.invalid/", // ユーザー情報で host を偽装
    "https://dm.takaratomy.co.jp:pw@evil.invalid/",
    "https://xn--dm-takaratomy-co-jp.evil.invalid/",
    "https://",
    "https://[bad",
  ])("許可外・偽装 %s は通さない", (u) => {
    expect(isAllowedLink(u)).toBe(false);
  });

  it("制御文字を挟んだ偽装も許可外として扱う", () => {
    expect(isAllowedLink("ht\ntps://evil.invalid/")).toBe(false);
    expect(isAllowedLink("https://evil.invalid\t/")).toBe(false);
  });

  it("相対リンク・脚注は判定対象外 (通す)。空は通さない", () => {
    expect(isAllowedLink("/rule")).toBe(true);
    expect(isAllowedLink("#user-content-fn-1")).toBe(true);
    expect(isAllowedLink("")).toBe(false);
    expect(isAllowedLink(undefined)).toBe(false);
  });
});

describe("Markdown: 許可ホスト以外の http(s) リンクは非リンク表示", () => {
  it("許可ホストはリンクのまま (target=_blank + rel)", () => {
    const html = render("[総合ルール](https://dm.takaratomy.co.jp/rule/)");
    expect(html).toContain('<a href="https://dm.takaratomy.co.jp/rule/"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("許可外は <a> を出さず `テキスト (URL)` にする", () => {
    const html = render("[公式キャンペーン](https://example.invalid/claim)");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("href");
    expect(html).toContain("公式キャンペーン (https://example.invalid/claim)");
  });

  it("自動リンク (裸の URL) も許可外は非リンクで URL だけ出す", () => {
    const html = render("詳しくは https://evil.invalid/login へ");
    expect(html).not.toContain("<a");
    expect(html).toContain("https://evil.invalid/login");
  });

  it("host を偽装した許可外は非リンク", () => {
    const html = render("[x](https://dm.takaratomy.co.jp@evil.invalid/)");
    expect(html).not.toContain("<a");
  });

  it("相対リンク・脚注リンクは従来どおり", () => {
    const html = render("[ルール](/rule)");
    expect(html).toContain('<a href="/rule"');
  });

  it("javascript: は従来どおり safeUrl が落とす (リンクにならない)", () => {
    expect(render("[x](javascript:alert(1))")).not.toContain("javascript:");
  });
});
