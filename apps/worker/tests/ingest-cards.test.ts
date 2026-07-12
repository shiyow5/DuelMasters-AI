import { describe, it, expect } from "vitest";
import { parseCardDetail, extractCardIds, parseCardsArgs } from "../src/jobs/ingest-cards.js";

const DETAIL = `
<html><head>
<meta property="og:title" content="ヨミジ 丁-二式(DMRP12 22/104) | デュエル・マスターズ">
<meta name="description" content="このクリーチャーがバトルゾーンに出た時、S・トリガーを与える。">
<meta property="og:image" content="https://dm.takaratomy.co.jp/wp-content/card/cardimage/dmrp12-022.jpg">
</head><body>
<table><tr>
  <td class='type'>GRクリーチャー</td>
  <td class='civil'>光/闇</td>
  <td class='rarelity'>R</td>
  <td class='power'>2000</td>
  <td class='cost'>4</td>
  <td class='race'>マフィ・ギャング/デリートロン</td>
</tr></table>
</body></html>`;

describe("parseCardDetail", () => {
  const c = parseCardDetail(DETAIL, "dmrp12-022")!;

  it("og:title から名前とセットコードを取る", () => {
    expect(c.name).toBe("ヨミジ 丁-二式");
    expect(c.set_code).toBe("DMRP12");
  });
  it("td セルから cost/power/type/race を取る", () => {
    expect(c.cost).toBe(4);
    expect(c.power).toBe(2000);
    expect(c.type).toBe("creature");
    expect(c.races).toEqual(["マフィ・ギャング", "デリートロン"]);
  });
  it("文明を日本語→内部コードに変換し多色を判定", () => {
    expect(c.civilizations).toEqual(["light", "darkness"]);
    expect(c.is_rainbow).toBe(true);
  });
  it("S・トリガーをテキストから判定", () => {
    expect(c.is_shield_trigger).toBe(true);
  });
  it("og:title が無ければ null", () => {
    expect(parseCardDetail("<html></html>", "x")).toBeNull();
  });
});

describe("extractCardIds", () => {
  it("data-href / href から id を重複なく取る", () => {
    const html = `
      <a data-href="/card/detail/?id=dmrp12-022">A</a>
      <a href="/card/detail/?id=dmrp12-023">B</a>
      <a data-href="/card/detail/?id=dmrp12-022">dup</a>
      <a href="/other/">skip</a>`;
    expect(extractCardIds(html).sort()).toEqual(["dmrp12-022", "dmrp12-023"]);
  });
});

describe("parseCardsArgs", () => {
  it("数値 limit を解釈、不正は全件", () => {
    expect(parseCardsArgs(["30"])).toEqual({ limit: 30 });
    expect(parseCardsArgs([])).toEqual({});
  });
});
