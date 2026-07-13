import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { chatRouter } from "./routes/chat.js";
import { deckRouter } from "./routes/deck.js";
import { metaRouter } from "./routes/meta.js";
import { userRouter } from "./routes/user.js";
import { optionalAuth, requireAuthUnlessAnonymous } from "./middleware/auth.js";
import { rateLimit } from "./middleware/rate-limit.js";
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
// 認証を試みて userId を設定する (ここでは通す。弾くのは下のガード)
app.use("*", optionalAuth);

// ヘルスチェックは無認証で通す (監視のため)
app.get("/", (c) => c.json({ status: "ok", service: "dm-ai-api" }));
app.get("/health", (c) => c.json({ status: "ok" }));

// API は全てログイン必須。/api/chat は Gemini を叩くため、無認証で開けておくと第三者に
// 課金を消費される。読み取り系も含めて一律に閉じる。
// レート制限は認証の後 (ユーザー単位でカウントするため)。
app.use("/api/*", requireAuthUnlessAnonymous);
app.use("/api/*", rateLimit);

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
