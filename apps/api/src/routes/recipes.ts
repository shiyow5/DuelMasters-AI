/**
 * CS 入賞デッキレシピの一覧 (#126)。取込元はデネブログ。
 *
 * **ティア表 (/api/meta/tier) とは連携しない。** デネブログはフォーマットを記録しておらず、
 * アーキタイプ名もティア表と 44.3% しか一致しないため、レシピを特定のティア行に
 * 紐づけると誤った対応付けになる (詳細は infra/sql/009_deck_recipes.sql)。
 * ここではデネブログが書いていることをそのまま返す。
 */
import { Hono } from "hono";
import { getSql } from "@dm-ai/db";

const recipesRouter = new Hono();

/** 一覧の既定件数と上限 */
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;
/** 検索語の長さ上限 */
const MAX_QUERY_LENGTH = 100;

/** 数値クエリを安全に読む。不正値は既定値へ落とす (400 にせず一覧を出す)。 */
function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * ILIKE のワイルドカードを無効化する。
 * エスケープしないと「%」の一語で全件が返り、検索が無検索になる。
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** GET /api/recipes?q=&limit=&offset= — 新着順のデッキレシピ一覧 */
recipesRouter.get("/", async (c) => {
  const sql = getSql();

  const limit = intParam(c.req.query("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = intParam(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const q = (c.req.query("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);

  // デッキ名と大会名のどちらでも引けるようにする (「ウィリデ」でも「妖精CS」でも)
  const pattern = `%${escapeLike(q)}%`;
  const filter =
    q === "" ? sql`TRUE` : sql`(deck_name ILIKE ${pattern} OR event_name ILIKE ${pattern})`;

  try {
    const rows = await sql`
      SELECT source_url, posted_date, event_name, placement_label, deck_name,
             player, participants, decklist_image_url
      FROM deck_recipes
      WHERE ${filter}
      ORDER BY posted_date DESC, source_url DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM deck_recipes WHERE ${filter}`;

    return c.json({
      recipes: rows.map((r) => ({
        source_url: r.source_url as string,
        // DATE は Date で返るので日付だけに整形する
        posted_date: (r.posted_date as Date).toISOString().split("T")[0],
        event_name: r.event_name as string,
        placement_label: r.placement_label as string,
        deck_name: r.deck_name as string,
        player: (r.player as string | null) ?? null,
        participants: (r.participants as number | null) ?? null,
        decklist_image_url: r.decklist_image_url as string,
      })),
      total: count as number,
      limit,
      offset,
    });
  } catch (err) {
    console.error("デッキレシピ一覧の取得に失敗:", err);
    return c.json({ error: "デッキレシピを取得できませんでした" }, 500);
  }
});

export { recipesRouter };
