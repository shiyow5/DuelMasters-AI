import type { MiddlewareHandler } from "hono";
import { configureDb, createSql, runWithSql } from "@dm-ai/db";
import { configureGemini, parseModelEnv } from "@dm-ai/core";
import { configureAgent } from "@dm-ai/agent";

/** Cloudflare Workers の env バインディング (Node 実行時は未設定でも動くよう全て optional)。 */
export type Bindings = {
  HYPERDRIVE?: { connectionString: string };
  INTERNAL_API_KEY?: string;
  GEMINI_API_KEY?: string;
  // 任意: モデルチェーン上書き (カンマ区切り)。Workers は process.env を読めないため env 経由で注入する。
  // core (Gemma 優先) と agent (flash-lite 優先) は順序が逆なので env を分ける。
  GEMINI_CHAT_MODELS?: string;
  GEMINI_STRUCTURED_MODELS?: string;
  AGENT_CHAT_MODELS?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_ANON_KEY?: string;
  WEB_URL?: string;
};

/**
 * リクエスト毎に env の接続情報を db/gemini レイヤへ注入する。
 * Workers では Hyperdrive のリクエストスコープ sql を AsyncLocalStorage に載せ、後続のハンドラ
 * (deck-engine / rag を含む) が引数なしの getSql() でそれを使えるようにする。
 * Node (c.env に env バインディングが無い) では process.env フォールバックに任せる。
 * 他のミドルウェア (cors の WEB_URL, auth の getSupabase) より前に実行する必要がある。
 */
export const dbEnv: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const env = c.env;
  configureDb({
    supabaseUrl: env.SUPABASE_URL,
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_ANON_KEY,
  });
  configureGemini({
    apiKey: env.GEMINI_API_KEY,
    chatModels: parseModelEnv(env.GEMINI_CHAT_MODELS),
    structuredModels: parseModelEnv(env.GEMINI_STRUCTURED_MODELS),
  });
  // LangGraph エージェント (@dm-ai/agent)。モデル上書きは agent 専用 env を使う
  // (core の GEMINI_CHAT_MODELS は Gemma 優先で、agent に渡すとツールループ収束が壊れる)。
  configureAgent({
    apiKey: env.GEMINI_API_KEY,
    chatModels: parseModelEnv(env.AGENT_CHAT_MODELS),
  });

  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString) {
    // Node: getSql()/getSupabase() が process.env を使う
    await next();
    return;
  }
  // Workers: Hyperdrive のリクエストスコープ接続を ALS に載せ、**本文を書き終えてから**閉じる
  const sql = createSql(connectionString);
  try {
    await runWithSql(sql, () => next());
  } catch (err) {
    c.executionCtx.waitUntil(sql.end());
    throw err;
  }
  const { res, closed } = closeAfterBody(c.res, () => sql.end());
  c.res = res;
  c.executionCtx.waitUntil(closed);
};

/**
 * 応答**本文の書き出しが完了してから** close() する。
 *
 * `next()` の解決は「本文を書き終えた」ことを意味しない。`streamSSE` は本文を書く前に
 * Response を返すため、next() 直後に接続を閉じると **ストリーム中に走るツールの DB クエリが
 * `write CONNECTION_ENDED` で全滅する** (#112。本番で search_cards / search_rules が全て死んでいた)。
 *
 * ルート側の opt-in (「ストリームするルートは寿命を延ばしてね」) にはしない。忘れれば無言で
 * 同じ壊れ方に戻り、しかも eval では検出できないため。**本文を包み直して構造的に保証する。**
 */
function closeAfterBody(
  original: Response,
  close: () => Promise<void>,
): { res: Response; closed: Promise<void> } {
  if (!original.body) return { res: original, closed: close() };

  const { readable, writable } = new TransformStream();
  const closed = original.body
    .pipeTo(writable)
    // クライアント切断 (ブラウザを閉じた等) で reject する。接続は下で必ず閉じる。
    .catch(() => {})
    .then(close);

  return { res: new Response(readable, original), closed };
}
