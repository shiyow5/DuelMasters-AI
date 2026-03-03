import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { chatRouter } from "./routes/chat.js";
import { deckRouter } from "./routes/deck.js";
import { metaRouter } from "./routes/meta.js";

const app = new Hono();

// ミドルウェア
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: [
      "http://localhost:3000",
      process.env.WEB_URL ?? "",
    ].filter(Boolean),
  })
);

// ヘルスチェック
app.get("/", (c) => c.json({ status: "ok", service: "dm-ai-api" }));
app.get("/health", (c) => c.json({ status: "ok" }));

// ルーティング
app.route("/api/chat", chatRouter);
app.route("/api/deck", deckRouter);
app.route("/api/meta", metaRouter);

// サーバー起動
const port = parseInt(process.env.PORT ?? "3001", 10);
console.log(`DM-AI API server starting on port ${port}`);

serve({ fetch: app.fetch, port });
