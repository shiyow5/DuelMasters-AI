// Cloudflare Workers エントリポイント。Hono アプリをそのまま fetch ハンドラとして公開する。
// (Node で起動する場合は node-server.ts を使う)
import app from "./app.js";

export default app;
