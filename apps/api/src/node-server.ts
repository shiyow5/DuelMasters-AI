// Node で起動するためのエントリポイント (ローカル開発 / E2E)。
// 本番 (Cloudflare Workers) では index.ts の `export default app` が使われる。
import { serve } from "@hono/node-server";
import app from "./app.js";

const port = parseInt(process.env.PORT ?? "3001", 10);
console.log(`DM-AI API server starting on port ${port}`);

serve({ fetch: app.fetch, port });
