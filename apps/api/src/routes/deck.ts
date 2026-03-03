import { Hono } from "hono";
import {
  parseDecklist,
  scoreDeck,
  validateRegulation,
  autoBuild,
  suggestReplacements,
} from "@dm-ai/deck-engine";
import type { Format } from "@dm-ai/core";

const deckRouter = new Hono();

/** デッキリスト解析 */
deckRouter.post("/parse", async (c) => {
  const { decklist } = await c.req.json<{ decklist: string }>();
  const parsed = parseDecklist(decklist);
  return c.json(parsed);
});

/** デッキ評価 */
deckRouter.post("/evaluate", async (c) => {
  const { decklist, format = "original" } = await c.req.json<{
    decklist: string;
    format?: Format;
  }>();

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
  const {
    theme,
    format = "original",
    constraints = {},
  } = await c.req.json<{
    theme: string;
    format?: Format;
    constraints?: {
      requiredCards?: string[];
      excludeCards?: string[];
      civilizations?: string[];
      maxCost?: number;
    };
  }>();

  const result = await autoBuild(theme, format, constraints);
  return c.json(result);
});

/** デッキ改善提案 */
deckRouter.post("/suggest", async (c) => {
  const { decklist, goals = [] } = await c.req.json<{
    decklist: string;
    goals?: string[];
  }>();

  const parsed = parseDecklist(decklist);
  const suggestions = await suggestReplacements(parsed.entries, goals);
  return c.json({ suggestions });
});

export { deckRouter };
