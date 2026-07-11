import { Hono } from "hono";
import {
  parseDecklist,
  scoreDeck,
  validateRegulation,
  autoBuild,
  suggestReplacements,
} from "@dm-ai/deck-engine";
import {
  DeckParseRequestSchema,
  DeckEvaluateRequestSchema,
  DeckBuildRequestSchema,
  DeckSuggestRequestSchema,
  DeckSaveRequestSchema,
} from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
import { requireAuth } from "../middleware/auth.js";
import type { Context } from "hono";
import { z } from "zod";

const deckRouter = new Hono();

/** ボディを検証し、失敗時は 400 レスポンスを返す */
async function parseBody<S extends z.ZodTypeAny>(
  c: Context,
  schema: S
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  const raw = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      res: c.json(
        {
          error: "リクエストが不正です",
          details: parsed.error.issues.map(
            (i) => `${i.path.join(".")}: ${i.message}`
          ),
        },
        400
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

/** デッキリスト解析 */
deckRouter.post("/parse", async (c) => {
  const body = await parseBody(c, DeckParseRequestSchema);
  if (!body.ok) return body.res;
  const { decklist } = body.data;

  const parsed = parseDecklist(decklist);
  return c.json(parsed);
});

/** デッキ評価 */
deckRouter.post("/evaluate", async (c) => {
  const body = await parseBody(c, DeckEvaluateRequestSchema);
  if (!body.ok) return body.res;
  const { decklist, format } = body.data;

  const parsed = parseDecklist(decklist);
  const [score, validation] = await Promise.all([
    scoreDeck(parsed),
    validateRegulation(parsed, format),
  ]);

  return c.json({
    parsed,
    score,
    validation,
  });
});

/** デッキ自動構築 */
deckRouter.post("/build", async (c) => {
  const body = await parseBody(c, DeckBuildRequestSchema);
  if (!body.ok) return body.res;
  const { theme, format, constraints } = body.data;

  const result = await autoBuild(theme, format, constraints);
  return c.json(result);
});

/** デッキ改善提案 */
deckRouter.post("/suggest", async (c) => {
  const body = await parseBody(c, DeckSuggestRequestSchema);
  if (!body.ok) return body.res;
  const { decklist, goals } = body.data;

  const parsed = parseDecklist(decklist);
  const suggestions = await suggestReplacements(parsed.entries, goals);
  return c.json({ suggestions });
});

/** デッキ保存 (下書き保存の用途を妨げないため殿堂 NG でも保存可) */
deckRouter.post("/save", requireAuth, async (c) => {
  const body = await parseBody(c, DeckSaveRequestSchema);
  if (!body.ok) return body.res;
  const { title, format, decklist } = body.data;

  const parsed = parseDecklist(decklist);
  if (parsed.entries.length === 0) {
    return c.json({ error: "デッキリストを解析できませんでした" }, 400);
  }
  const score = await scoreDeck(parsed);
  const userId = c.get("userId")!;
  const sql = getSql();
  const rows = await sql`
    INSERT INTO decks (format, title, cards, user_id, scores)
    VALUES (${format}, ${title}, ${JSON.stringify(parsed.entries)}, ${userId}, ${JSON.stringify(score)})
    RETURNING id, title, format, cards, scores
  `;
  const row = rows[0];
  return c.json(
    {
      id: row.id,
      title: row.title,
      format: row.format,
      cards: row.cards,
      scores: row.scores,
    },
    201
  );
});

/** マイデッキ一覧 (自分のもののみ、作成日降順、最大50件)。/:id より前に定義すること */
deckRouter.get("/list", requireAuth, async (c) => {
  const userId = c.get("userId")!;
  const sql = getSql();
  const rows = await sql`
    SELECT id, title, format, scores->>'overall' as overall, created_at
    FROM decks WHERE user_id = ${userId}
    ORDER BY created_at DESC LIMIT 50
  `;
  return c.json({
    decks: rows.map((r) => ({
      id: r.id,
      title: r.title,
      format: r.format,
      overall: r.overall !== null ? Number(r.overall) : null,
      created_at: r.created_at,
    })),
  });
});

/** デッキ詳細 (自分のもののみ。他人・不存在は 404) */
deckRouter.get("/:id", requireAuth, async (c) => {
  const idParsed = z.coerce
    .number()
    .int()
    .positive()
    .safeParse(c.req.param("id"));
  if (!idParsed.success) return c.json({ error: "見つかりません" }, 404);
  const userId = c.get("userId")!;
  const sql = getSql();
  const rows = await sql`
    SELECT id, title, format, cards, scores, created_at
    FROM decks WHERE id = ${idParsed.data} AND user_id = ${userId}
  `;
  if (rows.length === 0) return c.json({ error: "見つかりません" }, 404);
  const row = rows[0];
  return c.json({
    id: row.id,
    title: row.title,
    format: row.format,
    cards: row.cards,
    scores: row.scores,
    created_at: row.created_at,
  });
});

/** デッキ削除 (自分のもののみ。他人・不存在は 404) */
deckRouter.delete("/:id", requireAuth, async (c) => {
  const idParsed = z.coerce
    .number()
    .int()
    .positive()
    .safeParse(c.req.param("id"));
  if (!idParsed.success) return c.json({ error: "見つかりません" }, 404);
  const userId = c.get("userId")!;
  const sql = getSql();
  const result = await sql`
    DELETE FROM decks WHERE id = ${idParsed.data} AND user_id = ${userId}
  `;
  if (result.count === 0) return c.json({ error: "見つかりません" }, 404);
  return c.json({ deleted: true });
});

export { deckRouter };
