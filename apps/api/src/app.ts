import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { chatRouter } from "./routes/chat.js";
import { deckRouter } from "./routes/deck.js";
import { cardRouter } from "./routes/card.js";
import { metaRouter } from "./routes/meta.js";
import { recipesRouter } from "./routes/recipes.js";
import { userRouter } from "./routes/user.js";
import { conversationRouter } from "./routes/conversations.js";
import { optionalAuth, requireAuthUnlessAnonymous } from "./middleware/auth.js";
import { rateLimitByIp, rateLimitByUser } from "./middleware/rate-limit.js";
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
// IP 単位のレート制限。**認証より前**に置く: 不正な Bearer を投げ続けると optionalAuth が
// 毎回 Supabase の auth API を叩くため、認証の後ろにしか制限が無いとこの経路が無制限になる。
app.use("/api/*", rateLimitByIp);
// 認証を試みて userId を設定する (ここでは通す。弾くのは下のガード)
app.use("*", optionalAuth);

// ヘルスチェックは無認証で通す (監視のため)
app.get("/", (c) => c.json({ status: "ok", service: "dm-ai-api" }));
app.get("/health", (c) => c.json({ status: "ok" }));

// API は全てログイン必須。/api/chat は Gemini を叩くため、無認証で開けておくと第三者に
// 課金を消費される。読み取り系も含めて一律に閉じる。
app.use("/api/*", requireAuthUnlessAnonymous);
// ユーザー単位のレート制限 (本命)。認証の後に置く必要がある (userId を使うため)。
app.use("/api/*", rateLimitByUser);

// ルーティング
app.route("/api/chat", chatRouter);
app.route("/api/deck", deckRouter);
app.route("/api/card", cardRouter);
app.route("/api/meta", metaRouter);
app.route("/api/recipes", recipesRouter);
app.route("/api/user", userRouter);
app.route("/api/conversations", conversationRouter);

// 予期しない例外の共通ハンドリング (詳細はサーバーログのみに出し、クライアントには汎用文言を返す)
app.onError((err, c) => {
  console.error(`[api] ${c.req.method} ${c.req.path} で未処理エラー:`, err);
  return c.json({ error: "内部エラーが発生しました" }, 500);
});

export default app;
