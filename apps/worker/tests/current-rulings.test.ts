import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseRulingListPage,
  parseJpDate,
  dedupeRulingList,
  type RulingItem,
} from "../src/jobs/ingest-rulings.js";

/**
 * 現行の裁定 (`/rule/qa/`) の取込 (#123)。
 *
 * ## 何が起きていたか
 *
 * 一次情報源は**2つある**:
 *
 * | 集合 | 取得方法 | 件数 |
 * | --- | --- | --- |
 * | **現行** `/rule/qa/` | HTML ページング (REST に出ていない) | 約 3,955 |
 * | **過去** `qa_old` | WP REST API (投稿タイプ名は「**過去の**よくある質問」) | 約 3,246 |
 *
 * **長らく `qa_old` しか取り込んでおらず、現行の裁定を1件も持っていなかった。**
 * 公式裁定の半分以上が RAG から欠けていた。
 *
 * フィクスチャは**本番の実 HTML から切り出したもの**。推測で書いたパーサは本番で壊れる。
 */

const listHtml = readFileSync(
  fileURLToPath(new URL("./fixtures/qa-list.html", import.meta.url)),
  "utf8",
);

describe("parseRulingListPage (現行の一覧ページ)", () => {
  it("実 HTML から id / 質問 / リンク / 日付を取り出す", () => {
    const items = parseRulingListPage(listHtml);

    expect(items).toHaveLength(2);
    expect(items[0].id).toBe(49017);
    expect(items[0].link).toBe("https://dm.takaratomy.co.jp/rule/qa/49017/");
    expect(items[0].source).toBe("current");
    // 質問文にカード名が入っていること (#92 で qa_old のカード名欠落を踏んでいる)
    expect(items[0].question).toContain("《Disメイデン》");
    // **日付が取れる。** qa_old の日付は全件 1990-01-01 のプレースホルダで使えなかった。
    expect(items[0].date).toBe("2026-07-09");
  });

  it("改行を含む質問文を1行に潰す", () => {
    const items = parseRulingListPage(listHtml);
    expect(items[0].question).not.toContain("\n");
  });

  it("裁定リンクが無いページなら空を返す (無限ループの終端条件)", () => {
    expect(parseRulingListPage("<html><body>該当なし</body></html>")).toEqual([]);
  });
});

describe("parseJpDate", () => {
  it("「2026.7.9」→「2026-07-09」", () => {
    expect(parseJpDate("2026.7.9")).toBe("2026-07-09");
  });

  it("2桁の月日も扱える", () => {
    expect(parseJpDate("2026.12.25")).toBe("2026-12-25");
  });

  it("読めない書式は undefined (**日付を捏造しない**)", () => {
    expect(parseJpDate("")).toBeUndefined();
    expect(parseJpDate("近日公開")).toBeUndefined();
  });
});

describe("dedupeRulingList (現行 > 過去)", () => {
  const item = (id: number, source: "current" | "archived", question: string): RulingItem => ({
    id,
    question,
    link: `https://dm.takaratomy.co.jp/rule/${source === "current" ? "qa" : "qa_old"}/${id}/`,
    source,
  });

  it("**同じ質問なら現行を採る。ID の大小では決めない**", () => {
    // 現行側にも 31971 のような小さい ID がある (過去側の 35220 より小さい)。
    // ID で決めると、**改定前の裁定が現行を上書きする**。
    const list = dedupeRulingList([
      item(35220, "archived", "S・トリガーは必ず使いますか？"),
      item(31971, "current", "S・トリガーは必ず使いますか？"),
    ]);

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(31971);
    expect(list[0].source).toBe("current");
  });

  it("同じ集合の中なら qa_id が新しい方", () => {
    const list = dedupeRulingList([
      item(34000, "archived", "同じ質問"),
      item(38000, "archived", "同じ質問"),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(38000);
  });

  it("質問が違えば両方残す (現行と過去が混ざっていてよい)", () => {
    const list = dedupeRulingList([
      item(49017, "current", "質問A"),
      item(35220, "archived", "質問B"),
    ]);
    expect(list).toHaveLength(2);
  });

  it("先頭のラベル差 (【基本ルール】) は同一視する", () => {
    const list = dedupeRulingList([
      item(35220, "archived", "【基本ルール】 マナは何枚置けますか？"),
      item(49017, "current", "マナは何枚置けますか？"),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].source).toBe("current");
  });
});

/**
 * **サイレントな部分取込を許さない** (#123 のレビュー指摘)。
 *
 * 末尾の prune は `qa_id NOT IN (keep)` で掃除する。取り込めなかった裁定は本番から消える。
 *
 * HTTP エラーで throw するだけでは足りない。**公式サイトが HTML 構造を変えたら、200 OK なのに
 * `parseRulingListPage` が 0件を返す。** これを「ページ終端」と読むと、現行の裁定を1件も
 * 取らずに prune へ進み、**取り込み済みの約3,955件を全部消す** —
 * このジョブが直そうとした欠落を、自分で作り直すことになる。
 */
describe("HTML 構造が変わったときに落ちる", () => {
  it("**1ページ目が0件なら throw する** (「終端」と区別できないまま進ませない)", async () => {
    const { fetchCurrentRulingList } = await import("../src/jobs/ingest-rulings.js");
    const original = globalThis.fetch;
    // 200 OK だが構造が変わって裁定リンクが1件も無いページ
    globalThis.fetch = (async () =>
      new Response("<html><body><ul class='changedClass'></ul></body></html>", {
        status: 200,
      })) as typeof fetch;

    try {
      await expect(fetchCurrentRulingList()).rejects.toThrow(/1件も取れなかった/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("2ページ目以降が0件なら正常終端 (件数が10の倍数のときに起こりうる)", async () => {
    const { fetchCurrentRulingList } = await import("../src/jobs/ingest-rulings.js");
    const original = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      // 1ページ目は実データ、2ページ目は空
      return new Response(call === 1 ? listHtml : "<html><body></body></html>", { status: 200 });
    }) as typeof fetch;

    try {
      const items = await fetchCurrentRulingList();
      expect(items).toHaveLength(2); // フィクスチャの2件
    } finally {
      globalThis.fetch = original;
    }
  });
});
