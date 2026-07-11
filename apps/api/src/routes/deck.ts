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
} from "@dm-ai/core";
import type { Context } from "hono";
import type { z } from "zod";

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

export { deckRouter };
