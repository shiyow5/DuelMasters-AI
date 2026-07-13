import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { metaRouter } from "../src/routes/meta.js";

function makeApp() {
  const app = new Hono();
  app.route("/api/meta", metaRouter);
  return app;
}

const today = new Date().toISOString().split("T")[0];

describe.skipIf(!hasTestDb)("GET /api/meta/tier (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => truncateAll(sql));
  afterAll(async () => {
    await sql.end();
  });

  it("週次ランキングがあれば個別 CS 記事より優先する", async () => {
    // 個別 CS 記事由来 (記事になった CS だけの偏った標本)
    await sql`INSERT INTO tournament_results (event_name, event_date, format, deck_archetype, placement)
      VALUES ('CS', ${today}, 'original', 'アグロ', 1)`;
    // 週次ランキング由来 (母集団の全量)
    await sql`INSERT INTO archetype_weekly_stats
      (format, period_start, period_end, deck_archetype, entries, total_entries)
      VALUES ('original', ${today}, ${today}, 'ウィリデ', 75, 100),
             ('original', ${today}, ${today}, 'ダーバンデ', 25, 100)`;

    const res = await makeApp().request("/api/meta/tier?format=original");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tier_data: Array<{ archetype: string; usage_rate: number }>;
    };

    expect(body.tier_data.map((t) => t.archetype)).toEqual(["ウィリデ", "ダーバンデ"]);
    expect(body.tier_data[0].usage_rate).toBe(75);
    expect(body.tier_data.map((t) => t.archetype)).not.toContain("アグロ");
  });

  it("週次ランキングが無ければ個別 CS 記事にフォールバックする", async () => {
    await sql`INSERT INTO tournament_results (event_name, event_date, format, deck_archetype, placement)
      VALUES ('CS', ${today}, 'original', 'アグロ', 1)`;

    const res = await makeApp().request("/api/meta/tier?format=original");
    const body = (await res.json()) as { tier_data: Array<{ archetype: string }> };
    expect(body.tier_data.map((t) => t.archetype)).toEqual(["アグロ"]);
  });

  it("データが無ければ空のティア表を返す", async () => {
    const res = await makeApp().request("/api/meta/tier?format=original");
    const body = (await res.json()) as { tier_data: unknown[] };
    expect(body.tier_data).toEqual([]);
  });
});

describe.skipIf(!hasTestDb)("GET /api/meta/archetype/:name (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => truncateAll(sql));
  afterAll(async () => {
    await sql.end();
  });

  it("基底アーキタイプ名で色つきの表記も拾う", async () => {
    // ティア表は取込元がまとめた基底名「ウィリデ」、個別 CS 記事は色つき「白緑ウィリデ」。
    // 完全一致だけだと詳細がいつも空になる。
    await sql`INSERT INTO tournament_results (event_name, event_date, format, deck_archetype, placement)
      VALUES ('CS1', ${today}, 'original', '白緑ウィリデ', 1),
             ('CS2', ${today}, 'original', '白青ウィリデ', 2),
             ('CS3', ${today}, 'original', '青黒デスパペット', 1)`;

    const res = await makeApp().request("/api/meta/archetype/ウィリデ?format=original");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stats: { total_entries: number; wins: number };
      recent_results: Array<{ deck_archetype: string }>;
    };

    expect(body.stats.total_entries).toBe(2);
    expect(body.stats.wins).toBe(1);
    expect(body.recent_results.map((r) => r.deck_archetype).sort()).toEqual([
      "白緑ウィリデ",
      "白青ウィリデ",
    ]);
  });

  it("LIKE のメタ文字を含む名前でも他の行に一致しない", async () => {
    await sql`INSERT INTO tournament_results (event_name, event_date, format, deck_archetype, placement)
      VALUES ('CS1', ${today}, 'original', '白緑ウィリデ', 1)`;

    // "%" をそのまま LIKE に渡すと全行に一致してしまう
    const res = await makeApp().request("/api/meta/archetype/%?format=original");
    const body = (await res.json()) as { stats: { total_entries: number } };
    expect(body.stats.total_entries).toBe(0);
  });
});
