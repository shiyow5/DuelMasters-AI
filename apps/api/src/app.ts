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
import { allowAnonymous, optionalAuth, requireAuthUnlessAnonymous } from "./middleware/auth.js";
import { rateLimitByIp, rateLimitByUser } from "./middleware/rate-limit.js";
import { dailyChatQuota } from "./middleware/daily-quota.js";
import { dbEnv, type Bindings } from "./db.js";
import { handleAppError } from "./error-handler.js";

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
 *
 * ローカル開発の localhost 許可は `ALLOW_ANONYMOUS=true` の時のみ (#257 L-3)。判定は認証と同じ
 * `allowAnonymous` (env ?? process.env) を使い、CORS と認証でずれないようにする (#273 R2)。
 * WEB_URL に書かれた localhost 系オリジンも同じ制限をかける。WEB_URL は正規の http(s) Origin
 * (スキーム + ホスト[:ポート] のみ) だけを受け付け、`*` / `null` / パス付きなどは捨てる。
 */
export function allowedOrigins(webUrl: string | undefined, allowLocalhost: boolean): string[] {
  const configured: string[] = [];
  for (const raw of (webUrl ?? "").split(",")) {
    const origin = normalizeOrigin(raw.trim());
    if (!origin || (!allowLocalhost && isLocalOrigin(origin))) continue;
    configured.push(origin);
  }
  // 正規化後に重複したものは 1 つにまとめる (localhost:3000 の重複も含む)
  return [...new Set(allowLocalhost ? ["http://localhost:3000", ...configured] : configured)];
}

/**
 * 正規の http(s) Origin に正規化する。不正なら null。
 *
 * 末尾スラッシュ・大文字ホスト・既定ポート明示 (`:443` / `:80`) は `URL.origin` で正規化して受け付ける
 * (ブラウザの Origin ヘッダと同じ形に揃える)。`*` / `null` / パス・クエリ・フラグメント・認証情報付き /
 * 非 http(s) は null。
 */
function normalizeOrigin(o: string): string | null {
  try {
    const u = new URL(o);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) return null;
    // `https://a.example?x` のようなクエリだけ/`#` だけの形は URL では search/hash が空になるため文字列でも弾く
    if (/[?#]/.test(o)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** localhost 系ホストか。localhost / *.localhost (末尾ドット可) / 127.0.0.0/8 / 0.0.0.0 / [::1]。 */
function isLocalOrigin(o: string): boolean {
  const h = new URL(o).hostname.replace(/\.$/, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
    h === "0.0.0.0" ||
    h === "[::1]"
  );
}

// CORS。WEB_URL は env 由来 (Workers=c.env / Node=process.env) のため per-request で解決する。
app.use("*", (c, next) => {
  const webUrl = c.env.WEB_URL ?? process.env.WEB_URL;
  return cors({
    origin: allowedOrigins(webUrl, allowAnonymous(c)),
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
// ユーザー単位の日次クォータ (F-1)。Gemini を叩く /api/chat (と /api/chat/stream) だけに掛ける。
// "/api/chat/*" は "/api/chat" 自体にも一致する。
app.use("/api/chat/*", dailyChatQuota());

// ルーティング
app.route("/api/chat", chatRouter);
app.route("/api/deck", deckRouter);
app.route("/api/card", cardRouter);
app.route("/api/meta", metaRouter);
app.route("/api/recipes", recipesRouter);
app.route("/api/user", userRouter);
app.route("/api/conversations", conversationRouter);

// 予期しない例外の共通ハンドリング (詳細はサーバーログのみに出し、クライアントには汎用文言を返す)
app.onError(handleAppError);

export default app;
