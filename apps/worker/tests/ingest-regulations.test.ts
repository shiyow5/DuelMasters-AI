import { describe, it, expect } from "vitest";
import { parseRegulations } from "../src/jobs/ingest-regulations.js";

const HTML = `
<h1>殿堂レギュレーション</h1>
<h3>■2026年3月16日より殿堂入りになるカード</h3>
<ul><li><a data-href="/card/detail/?id=x1">《予告カードA》</a></li></ul>
<h2>プレミアム殿堂入りカード</h2>
<h4>「プレミアム殿堂入りカード」とは…？</h4>
<h3>あ行</h3>
<ul><li><a data-href="/card/detail/?id=p1">《アクア・パトロール》</a></li></ul>
<h2>殿堂入りカード</h2>
<h3>あ行</h3>
<ul>
  <li><a data-href="/card/detail/?id=d1">《アポロヌス》</a></li>
  <li><a href="/card/detail/?id=ad">【今すぐ】広告【クリック】</a></li>
</ul>
<h4>「殿堂解除カード」とは…？</h4>
<h3>か行</h3>
<ul><li><a data-href="/card/detail/?id=r1">《解除される旧殿堂》</a></li></ul>
<h2>使用禁止カード</h2>
`;

describe("parseRegulations", () => {
  const entries = parseRegulations(HTML);

  it("h2 制限種別ごとにカードを紐付ける", () => {
    expect(entries.find((e) => e.card_name === "アクア・パトロール")?.restriction_type).toBe(
      "プレミアム殿堂",
    );
    expect(entries.find((e) => e.card_name === "アポロヌス")?.restriction_type).toBe("殿堂入り");
  });

  it("《》を除去し card_id を取る", () => {
    const e = entries.find((x) => x.card_name === "アポロヌス");
    expect(e?.card_id).toBe("d1");
  });

  it("h2 前の予告(announcement)カードは除外", () => {
    expect(entries.some((e) => e.card_name === "予告カードA")).toBe(false);
  });

  it("「殿堂解除」節のカードは除外", () => {
    expect(entries.some((e) => e.card_name === "解除される旧殿堂")).toBe(false);
  });

  it("広告(【】)リンクは除外", () => {
    expect(entries.some((e) => /【/.test(e.card_name))).toBe(false);
  });
});
