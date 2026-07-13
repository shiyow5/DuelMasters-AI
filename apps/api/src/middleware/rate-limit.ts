import type { Context, MiddlewareHandler } from "hono";

/**
 * レート制限 (Cloudflare Workers の Rate Limiting binding)。
 *
 * ダッシュボードの Rate Limiting Rules はゾーン単位で、`*.workers.dev` には適用できない。
 * api は workers.dev に居るため、Workers ネイティブの binding を使う。設定が wrangler.jsonc に
 * 残り CD で自動反映される利点もある。
 *
 * キーはユーザー単位。IP だと同一 NAT 配下のユーザーが巻き添えになるし、逆に IP を変えれば
 * 回避できてしまう。ログイン必須にした以上、人単位で数えるのが正しい。
 * (認証より後に置くこと。userId が無いと機能しない)
 */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

function getLimiter(c: Context): RateLimiter | undefined {
  const env = c.env as { RATE_LIMITER?: RateLimiter } | undefined;
  return env?.RATE_LIMITER;
}

export const rateLimit: MiddlewareHandler = async (c, next) => {
  const limiter = getLimiter(c);
  // binding が無い環境 (Node のローカル/テスト) では素通しする。
  // Workers では wrangler.jsonc で必ず注入されるので、本番で無効になることはない。
  if (!limiter) return next();

  const key = c.get("userId") ?? "anonymous";
  const { success } = await limiter.limit({ key });
  if (!success) {
    return c.json({ error: "リクエストが多すぎます。しばらく待って再試行してください" }, 429);
  }
  return next();
};
