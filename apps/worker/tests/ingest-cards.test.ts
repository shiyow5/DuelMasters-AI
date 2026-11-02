import { describe, it, expect } from "vitest";
import {
  parseCardDetail,
  extractCardIds,
  parseCardsArgs,
  selectNewIds,
  crawlCards,
  type CrawlDeps,
  type RawCard,
} from "../src/jobs/ingest-cards.js";

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
  it("数値 limit を解釈、省略は制限なし", () => {
    expect(parseCardsArgs(["30"])).toEqual({ limit: 30 });
    expect(parseCardsArgs([])).toEqual({});
  });
  it("--start-page / --max-pages / --full / --list-only", () => {
    expect(parseCardsArgs(["--start-page", "81", "--max-pages", "80", "--full"])).toEqual({
      startPage: 81,
      maxPages: 80,
      mode: "full",
    });
    expect(parseCardsArgs(["5", "--max-pages", "2"])).toEqual({ limit: 5, maxPages: 2 });
    expect(parseCardsArgs(["--list-only"])).toEqual({ mode: "list" });
  });
  it("不正な値は黙って全件に倒さず例外にする", () => {
    expect(() => parseCardsArgs(["--start-page"])).toThrow();
    expect(() => parseCardsArgs(["--start-page", "0"])).toThrow();
    expect(() => parseCardsArgs(["--max-pages", "abc"])).toThrow();
    expect(() => parseCardsArgs(["--bogus"])).toThrow();
    expect(() => parseCardsArgs(["abc"])).toThrow();
    expect(() => parseCardsArgs(["--full", "--list-only"])).toThrow();
  });
});

describe("selectNewIds", () => {
  it("DB に無い id だけを並び順のまま返す", () => {
    expect(selectNewIds(["a", "b", "c", "d"], new Set(["b", "d"]))).toEqual(["a", "c"]);
    expect(selectNewIds(["a"], new Set(["a"]))).toEqual([]);
  });
});

/** 1ページ2枚のフェイク一覧。pages[i] が i+1 ページ目。範囲外は空 (公式の終端と同じ) */
function fakeDeps(pages: string[][], known: string[], failPage?: number) {
  const listCalls: number[] = [];
  const detailCalls: string[] = [];
  const upserted: string[] = [];
  const warns: string[] = [];
  const deps: CrawlDeps = {
    async fetchListIds(page) {
      listCalls.push(page);
      if (page === failPage) throw new Error("HTTP 500");
      return pages[page - 1] ?? [];
    },
    async fetchDetail(id) {
      detailCalls.push(id);
      return `<meta property="og:title" content="${id}(SET 1/1) | DM">`;
    },
    async upsert(card: RawCard) {
      upserted.push(card.official_id);
    },
    knownIds: new Set(known),
    sleep: async () => {},
    log: () => {},
    warn: (m) => warns.push(m),
  };
  return { deps, listCalls, detailCalls, upserted, warns };
}

describe("crawlCards (diff)", () => {
  const pages = [
    ["n1", "k1"],
    ["k2", "k3"],
    ["n2", "k4"],
    ["k5", "k6"],
    ["k7", "k8"],
    ["k9", "k10"],
    ["n3", "k11"],
  ];
  const known = ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9", "k10", "k11"];

  it("DB に無い id だけ詳細を取る", async () => {
    const f = fakeDeps(pages, known);
    const r = await crawlCards(f.deps);
    expect(f.detailCalls).toEqual(["n1", "n2"]);
    expect(f.upserted).toEqual(["n1", "n2"]);
    expect(r.inserted).toBe(2);
    expect(r.newIds).toBe(2);
  });

  it("新規の無いページが K ページ続いたら打ち切る (途中の新規でカウントはリセット)", async () => {
    const f = fakeDeps(pages, known);
    const r = await crawlCards(f.deps, { stopAfterEmptyPages: 3 });
    // 2ページ目で1回目、3ページ目に新規があってリセット、4〜6ページ目で3回 → 6で終了
    expect(f.listCalls).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.stop).toBe("no-new");
    expect(r.lastPage).toBe(6);
    // 7ページ目の n3 は届かない (古い側は月次の全件更新で拾う)
    expect(f.detailCalls).not.toContain("n3");
    // 最後まで読んでいないので、消えた id は判定しない
    expect(r.removedIds).toBeNull();
  });

  it("K を大きくすれば一覧の終端まで読み、消えた id はログだけ出す", async () => {
    const f = fakeDeps(pages, [...known, "gone1"]);
    const r = await crawlCards(f.deps, { stopAfterEmptyPages: 100 });
    expect(r.stop).toBe("end");
    expect(f.listCalls).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(f.detailCalls).toEqual(["n1", "n2", "n3"]);
    expect(r.removedIds).toEqual(["gone1"]);
    expect(f.warns.some((w) => w.includes("gone1") && w.includes("削除はしない"))).toBe(true);
    // 消えた id を upsert/削除しようとしない
    expect(f.upserted).not.toContain("gone1");
  });

  it("limit に達したら止める", async () => {
    const f = fakeDeps(pages, known);
    const r = await crawlCards(f.deps, { limit: 1, stopAfterEmptyPages: 100 });
    expect(r.stop).toBe("limit");
    expect(f.upserted).toEqual(["n1"]);
  });
});

describe("crawlCards (ページ範囲)", () => {
  const pages = [
    ["a1", "a2"],
    ["b1", "b2"],
    ["c1", "c2"],
    ["d1", "d2"],
    ["e1", "e2"],
  ];

  it("full: start-page から max-pages ページだけ、既知も含めて取り直す", async () => {
    const f = fakeDeps(pages, ["b1", "c2"]);
    const r = await crawlCards(f.deps, { mode: "full", startPage: 2, maxPages: 2 });
    expect(f.listCalls).toEqual([2, 3]);
    expect(f.upserted).toEqual(["b1", "b2", "c1", "c2"]);
    expect(r.stop).toBe("max-pages");
    expect(r.lastPage).toBe(3);
    expect(r.newIds).toBe(2);
  });

  it("full: 範囲の途中で一覧が終われば end で止まる。2ページ目以降からの開始では消えた id を判定しない", async () => {
    const f = fakeDeps(pages, ["zz"]);
    const r = await crawlCards(f.deps, { mode: "full", startPage: 4, maxPages: 80 });
    expect(f.listCalls).toEqual([4, 5, 6]);
    expect(r.stop).toBe("end");
    expect(r.pages).toBe(2);
    expect(r.removedIds).toBeNull();
  });

  it("full は新規の無いページが続いても打ち切らない", async () => {
    const f = fakeDeps(pages, pages.flat());
    const r = await crawlCards(f.deps, { mode: "full", stopAfterEmptyPages: 1 });
    expect(r.stop).toBe("end");
    expect(f.upserted).toHaveLength(10);
  });

  it("list: 詳細は取らず、一覧を最後まで読んで新規数と消えた id を出す", async () => {
    const f = fakeDeps(pages, ["a1", "b2", "old"]);
    const r = await crawlCards(f.deps, { mode: "list" });
    expect(f.detailCalls).toEqual([]);
    expect(r.stop).toBe("end");
    expect(r.newIds).toBe(8);
    expect(r.removedIds).toEqual(["old"]);
  });

  it("一覧の取得に失敗したら list-error で止める (消えた id は判定しない)", async () => {
    const f = fakeDeps(pages, ["old"]);
    const r = await crawlCards(f.deps, { mode: "list" });
    expect(r.stop).toBe("end");
    const g = fakeDeps(pages, ["old"], 3);
    const r2 = await crawlCards(g.deps, { mode: "list" });
    expect(r2.stop).toBe("list-error");
    expect(r2.pages).toBe(2);
    expect(r2.removedIds).toBeNull();
  });
});
