import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { chatRouter } from "./routes/chat.js";
import { deckRouter } from "./routes/deck.js";
import { metaRouter } from "./routes/meta.js";
import { userRouter } from "./routes/user.js";
import { optionalAuth } from "./middleware/auth.js";
import { dbEnv, type Bindings } from "./db.js";

const app = new Hono<{ Bindings: Bindings }>();

// ミドルウェア
app.use("*", logger());
// env 注入 + リクエストスコープ DB (Workers)。他のミドルウェアより前に実行する。
app.use("*", dbEnv);
/**
 * CORS の許可オリジン。WEB_URL はカンマ区切りで複数指定できる。
 *
 * 移行期は workers.dev と独自ドメイン (dm-ai.shiyow.dev) の両方から web が配信されるため、
 * 単一オリジンしか許可できないとどちらかの web から api を叩けなくなる。
 * ローカル開発 (localhost:3000) は常に許可する。
 */
export function allowedOrigins(webUrl: string | undefined): string[] {
  const configured = (webUrl ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return ["http://localhost:3000", ...configured];
}

// CORS。WEB_URL は env 由来 (Workers=c.env / Node=process.env) のため per-request で解決する。
app.use("*", (c, next) => {
  const webUrl = c.env.WEB_URL ?? process.env.WEB_URL;
  return cors({
    origin: allowedOrigins(webUrl),
    // 許可ヘッダ/メソッドを明示 (Hono の既定エコー挙動に頼らず堅牢化する)
    allowHeaders: ["Content-Type", "Authorization", "X-Internal-Key", "X-User-Id"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })(c, next);
});
// 認証 (無認証でも通す。userId を設定するだけ)
app.use("*", optionalAuth);

// ヘルスチェック
app.get("/", (c) => c.json({ status: "ok", service: "dm-ai-api" }));
app.get("/health", (c) => c.json({ status: "ok" }));

// ルーティング
app.route("/api/chat", chatRouter);
app.route("/api/deck", deckRouter);
app.route("/api/meta", metaRouter);
app.route("/api/user", userRouter);

// 予期しない例外の共通ハンドリング (詳細はサーバーログのみに出し、クライアントには汎用文言を返す)
app.onError((err, c) => {
  console.error(`[api] ${c.req.method} ${c.req.path} で未処理エラー:`, err);
  return c.json({ error: "内部エラーが発生しました" }, 500);
});

export default app;
