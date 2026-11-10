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

/** route と同じ計算 (ローカル日付で n 日戻して ISO 日付にする) */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

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

  it("期間 (2w/4w/8w) ごとに別の集計を返す (同じ長さのスナップショットだけを使う)", async () => {
    // cron が作るのは 4 週ぶんのスナップショットだけ (ingest-cron.yml の snapshot:meta ... 4)。
    // 期間の長さを見ずに最新を返すと、2w/8w でもこの 4 週ぶんが返ってしまう (QA③)。
    await sql`INSERT INTO meta_snapshots (format, period_start, period_end, tier_data)
      VALUES ('original', ${daysAgo(28)}, ${today},
              ${sql.json([{ archetype: "スナップ4週", usage_rate: 100, count: 1, tier: "S" }])})`;
    // 週次ランキング: 直近 2 週・2〜4 週前・4〜8 週前に 1 件ずつ
    await sql`INSERT INTO archetype_weekly_stats
      (format, period_start, period_end, deck_archetype, entries, total_entries)
      VALUES ('original', ${daysAgo(9)}, ${daysAgo(3)}, '直近', 10, 10),
             ('original', ${daysAgo(26)}, ${daysAgo(20)}, '中間', 10, 10),
             ('original', ${daysAgo(51)}, ${daysAgo(45)}, '古い', 10, 10)`;

    const archetypesOf = async (period: string) => {
      const res = await makeApp().request(`/api/meta/tier?format=original&period=${period}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        period: string;
        period_start: string;
        tier_data: Array<{ archetype: string }>;
      };
      return { ...body, names: body.tier_data.map((t) => t.archetype).sort() };
    };

    const w2 = await archetypesOf("2w");
    const w4 = await archetypesOf("4w");
    const w8 = await archetypesOf("8w");

    // 4w は同じ長さのスナップショットがあるのでそれを使う
    expect(w4.names).toEqual(["スナップ4週"]);
    // 2w / 8w は同じ長さのスナップショットが無いので、その場集計に落ちる
    expect(w2.names).toEqual(["直近"]);
    expect(w8.names).toEqual(["中間", "古い", "直近"].sort());
    expect(w2.period).toBe("2w");
    expect(w8.period).toBe("8w");
    expect(w2.period_start).toBe(daysAgo(14));
    expect(w8.period_start).toBe(daysAgo(56));
  });

  it("同じ長さのスナップショットがあれば、その期間でも使う (8w)", async () => {
    await sql`INSERT INTO meta_snapshots (format, period_start, period_end, tier_data)
      VALUES ('original', ${daysAgo(28)}, ${today},
              ${sql.json([{ archetype: "スナップ4週", usage_rate: 100, count: 1, tier: "S" }])}),
             ('original', ${daysAgo(56)}, ${today},
              ${sql.json([{ archetype: "スナップ8週", usage_rate: 100, count: 1, tier: "S" }])})`;

    const res = await makeApp().request("/api/meta/tier?format=original&period=8w");
    const body = (await res.json()) as {
      period_start: string;
      period_end: string;
      tier_data: Array<{ archetype: string }>;
    };
    expect(body.tier_data.map((t) => t.archetype)).toEqual(["スナップ8週"]);
    // 8w のスナップショットでも日付は YYYY-MM-DD の完全一致 (#185)
    expect([body.period_start, body.period_end]).toEqual([daysAgo(56), today]);
  });

  it("4週のスナップショットだけがあるとき、2w/8w はその場集計で期間ごとに件数・期間が変わる (#180)", async () => {
    // 終わりを昨日にして、応答の期間がスナップショットの範囲 (今日ではない) になることも見る。
    // 長さはちょうど 28 日 (snapshot-meta と同じ作り方)
    await sql`INSERT INTO meta_snapshots (format, period_start, period_end, tier_data)
      VALUES ('original', ${daysAgo(29)}, ${daysAgo(1)},
              ${sql.json([{ archetype: "スナップ4週", usage_rate: 100, count: 102, tier: "S" }])})`;
    // 同じアーキタイプが時期をずらして出ている。期間が長いほど件数が増える
    await sql`INSERT INTO archetype_weekly_stats
      (format, period_start, period_end, deck_archetype, entries, total_entries)
      VALUES ('original', ${daysAgo(9)}, ${daysAgo(3)}, 'ウィリデ', 5, 5),
             ('original', ${daysAgo(51)}, ${daysAgo(45)}, 'ウィリデ', 7, 7)`;

    type Body = {
      period: string;
      period_start: string;
      period_end: string;
      tier_data: Array<{ archetype: string; entries?: number }>;
    };
    const get = async (period: string) => {
      const res = await makeApp().request(`/api/meta/tier?format=original&period=${period}`);
      expect(res.status).toBe(200);
      return (await res.json()) as Body;
    };
    const w2 = await get("2w");
    const w4 = await get("4w");
    const w8 = await get("8w");

    // 4w: スナップショットそのもの (期間もスナップショットの範囲)
    expect(w4.tier_data).toEqual([
      { archetype: "スナップ4週", usage_rate: 100, count: 102, tier: "S" },
    ]);
    // スナップショット経路でも YYYY-MM-DD の文字列そのもの (時刻つきにしない, #185)
    expect([w4.period_start, w4.period_end]).toEqual([daysAgo(29), daysAgo(1)]);

    // 2w / 8w: その場集計。件数も期間も違う
    expect(w2.tier_data.map((t) => [t.archetype, t.entries])).toEqual([["ウィリデ", 5]]);
    expect(w8.tier_data.map((t) => [t.archetype, t.entries])).toEqual([["ウィリデ", 12]]);
    expect([w2.period_start, w2.period_end]).toEqual([daysAgo(14), today]);
    expect([w8.period_start, w8.period_end]).toEqual([daysAgo(56), today]);
  });

  it("期間内に何も無ければ、同じ長さの最新スナップショットを stale 付きで返す (#163)", async () => {
    // 期間終端が 5 週前 (14 日より古い) の 4 週スナップショット。期間内の集計は空
    await sql`INSERT INTO meta_snapshots (format, period_start, period_end, tier_data)
      VALUES ('original', ${daysAgo(63)}, ${daysAgo(35)},
              ${sql.json([{ archetype: "古いスナップ", usage_rate: 100, count: 3, tier: "S" }])})`;

    const get = async (period: string) => {
      const res = await makeApp().request(`/api/meta/tier?format=original&period=${period}`);
      expect(res.status).toBe(200);
      return (await res.json()) as {
        period_start: string;
        period_end: string;
        tier_data: Array<{ archetype: string }>;
        fallback: boolean;
        stale: boolean;
        snapshot_created_at: string | null;
      };
    };

    const w4 = await get("4w");
    expect(w4.tier_data.map((t) => t.archetype)).toEqual(["古いスナップ"]);
    expect(w4.fallback).toBe(true);
    expect(w4.stale).toBe(true);
    expect([w4.period_start, w4.period_end]).toEqual([daysAgo(63), daysAgo(35)]);
    expect(typeof w4.snapshot_created_at).toBe("string");

    // 2w は同じ長さのスナップショットが無いので、フォールバックもしない (期間長の照合を維持)
    const w2 = await get("2w");
    expect(w2.tier_data).toEqual([]);
    expect(w2.fallback).toBe(false);
  });

  it("新しいスナップショットへのフォールバックは stale=false", async () => {
    await sql`INSERT INTO meta_snapshots (format, period_start, period_end, tier_data)
      VALUES ('original', ${daysAgo(29)}, ${daysAgo(1)},
              ${sql.json([{ archetype: "新しいスナップ", usage_rate: 100, count: 1, tier: "S" }])})`;

    const res = await makeApp().request("/api/meta/tier?format=original&period=4w");
    const body = (await res.json()) as { fallback: boolean; stale: boolean };
    // 期間内 (終端 1 日前) なのでフォールバックではなく通常のスナップショット
    expect(body.fallback).toBe(false);
    expect(body.stale).toBe(false);
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

  it("% を含む名前でも部分一致で拾う (ESCAPE が効いている, #170)", async () => {
    // 以前は JS ソースの `ESCAPE '\'` が cooked で `ESCAPE ''` になりエスケープ無効だった。
    // そのとき "\%" は「バックスラッシュ + 任意長」になり、"100%" の部分一致が 0件になる
    await sql`INSERT INTO tournament_results (event_name, event_date, format, deck_archetype, placement)
      VALUES ('CS1', ${today}, 'original', '赤単100%ビート', 1),
             ('CS2', ${today}, 'original', '赤単100ビート', 1)`;
    const res = await makeApp().request(
      `/api/meta/archetype/${encodeURIComponent("100%")}?format=original`,
    );
    const body = (await res.json()) as {
      stats: { total_entries: number };
      recent_results: Array<{ deck_archetype: string }>;
    };
    expect(body.stats.total_entries).toBe(1);
    expect(body.recent_results.map((r) => r.deck_archetype)).toEqual(["赤単100%ビート"]);
  });
});

describe("GET /api/meta/tier の period 検証 (B-11)", () => {
  // 検証は DB に触る前に行うので、DB なしでも走る
  it.each(["3w", "100w", "0w", "abc", "4", ""])("period=%j は 400", async (period) => {
    const res = await makeApp().request(
      `/api/meta/tier?format=original&period=${encodeURIComponent(period)}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("2w | 4w | 8w");
  });
});

describe("GET /api/meta/archetype/:name の period 検証 (#184)", () => {
  // /tier と同じ判定。検証は DB に触る前に行うので、DB なしでも走る
  it.each(["3w", "100w", "0w", "abc", "4", ""])("period=%j は 400", async (period) => {
    const res = await makeApp().request(
      `/api/meta/archetype/ウィリデ?format=original&period=${encodeURIComponent(period)}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("2w | 4w | 8w");
  });

  it.each([
    ["2w", "2w"],
    ["4w", "4w"],
    ["8w", "8w"],
    [null, "4w"],
  ])("period=%j は通り、応答の period は %j", async (period, expected) => {
    const qs = period === null ? "" : `&period=${period}`;
    const res = await makeApp().request(`/api/meta/archetype/ウィリデ?format=original${qs}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { period: string };
    expect(body.period).toBe(expected);
  });
});
