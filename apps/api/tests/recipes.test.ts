import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { recipesRouter } from "../src/routes/recipes.js";

function makeApp() {
  const app = new Hono();
  app.route("/api/recipes", recipesRouter);
  return app;
}

interface RecipeRow {
  deck_name: string;
  event_name: string;
  decklist_image_url: string;
  posted_date: string;
  player: string | null;
  participants: number | null;
}
interface ListBody {
  recipes: RecipeRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * GET /api/recipes — CS 入賞デッキレシピの一覧 (#126)。
 *
 * ティア表とは連携しない。デネブログが書いていることだけを返す。
 */
describe.skipIf(!hasTestDb)("GET /api/recipes (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });

  const add = (url: string, date: string, deck: string, event = "テストCS") =>
    sql`INSERT INTO deck_recipes
          (source_url, posted_date, event_name, placement_label, deck_name, player,
           participants, decklist_image_url)
        VALUES (${url}, ${date}, ${event}, '優勝', ${deck}, 'テスト太郎', 55,
                ${"https://blog-imgs-201.fc2.com/" + deck + ".jpg"})`;

  beforeEach(async () => {
    await truncateAll(sql);
    await add("https://deneblog.jp/blog-entry-1.html", "2026-07-13", "赤白ウィリデ");
    await add("https://deneblog.jp/blog-entry-2.html", "2026-07-12", "サガループ");
    await add("https://deneblog.jp/blog-entry-3.html", "2026-07-11", "青黒魔導具");
  });

  it("新着順に返す", async () => {
    const res = await makeApp().request("/api/recipes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(3);
    expect(body.recipes.map((r) => r.deck_name)).toEqual([
      "赤白ウィリデ",
      "サガループ",
      "青黒魔導具",
    ]);
    expect(body.recipes[0].decklist_image_url).toContain("blog-imgs-");
    expect(body.recipes[0].participants).toBe(55);
  });

  it("q でデッキ名を部分一致検索する", async () => {
    const res = await makeApp().request("/api/recipes?q=" + encodeURIComponent("ウィリデ"));
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(1);
    expect(body.recipes[0].deck_name).toBe("赤白ウィリデ");
  });

  it("q は大会名にも当たる", async () => {
    await add("https://deneblog.jp/blog-entry-4.html", "2026-07-10", "デスパペット", "妖精CS");
    const res = await makeApp().request("/api/recipes?q=" + encodeURIComponent("妖精"));
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(1);
    expect(body.recipes[0].event_name).toBe("妖精CS");
  });

  it("q に一致が無ければ空配列 (エラーにしない)", async () => {
    const res = await makeApp().request("/api/recipes?q=" + encodeURIComponent("存在しないデッキ"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(0);
    expect(body.recipes).toEqual([]);
  });

  it("q の % と _ をリテラルとして扱う (LIKE のワイルドカードにしない)", async () => {
    // 「%」で全件返ってしまうと、検索したつもりが無検索になる
    const res = await makeApp().request("/api/recipes?q=%25");
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(0);
  });

  it("limit / offset でページングする", async () => {
    const res = await makeApp().request("/api/recipes?limit=2&offset=1");
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(3); // total は絞り込み後の全件数
    expect(body.recipes.map((r) => r.deck_name)).toEqual(["サガループ", "青黒魔導具"]);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
  });

  it("不正な limit / offset は既定値に落とす (500 にしない)", async () => {
    // limit=-5 を下限 1 にクランプすると「1件だけの一覧」を返してしまう。
    // 負のページサイズは無意味な指定なので、既定 (24件) に戻すのが正しい。
    const res = await makeApp().request("/api/recipes?limit=-5&offset=abc");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.limit).toBe(24);
    expect(body.recipes).toHaveLength(3);
    expect(body.offset).toBe(0);
  });

  it("limit=0 も既定値に落とす", async () => {
    const res = await makeApp().request("/api/recipes?limit=0");
    const body = (await res.json()) as ListBody;
    expect(body.limit).toBe(24);
    expect(body.recipes).toHaveLength(3);
  });

  it("負の offset は 0 にする", async () => {
    const res = await makeApp().request("/api/recipes?offset=-10");
    const body = (await res.json()) as ListBody;
    expect(body.offset).toBe(0);
    expect(body.recipes).toHaveLength(3);
  });

  it("巨大な offset は上限で頭打ちにする (全走査させない)", async () => {
    // 上限が無いと offset=9007199254740991 で毎回インデックス全走査になる
    const res = await makeApp().request("/api/recipes?offset=9007199254740991");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.offset).toBe(100000);
    expect(body.recipes).toEqual([]);
  });

  it("limit に上限を設ける (取り放題にしない)", async () => {
    const res = await makeApp().request("/api/recipes?limit=99999");
    const body = (await res.json()) as ListBody;
    expect(body.limit).toBeLessThanOrEqual(60);
  });
});
