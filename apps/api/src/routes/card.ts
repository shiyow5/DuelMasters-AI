import { Hono } from "hono";
import { CardResolveRequestSchema } from "@dm-ai/core";
import { parseBody } from "../parse-body.js";
import { resolveCardImages } from "../card.js";

const cardRouter = new Hono();

/**
 * カード名 → 画像URL を一括で引く (#129 デッキのカード画像グリッド用)。
 *
 * body `{ names: string[] }` → `{ cards: [{ name, image_url|null }] }`。
 * 引けない名前は image_url=null で返す (UI はカード名テキストにフォールバックする)。
 */
cardRouter.post("/resolve", async (c) => {
  const body = await parseBody(c, CardResolveRequestSchema);
  if (!body.ok) return body.res;

  const images = await resolveCardImages(body.data.names);
  return c.json({
    cards: [...images].map(([name, image_url]) => ({ name, image_url })),
  });
});

export { cardRouter };
