import type { Context, MiddlewareHandler } from "hono";

/**
 * レート制限 (Cloudflare Workers の Rate Limiting binding)。
 *
 * ダッシュボードの Rate Limiting Rules はゾーン単位で `*.workers.dev` には適用できない。
 * api は workers.dev に居るため Workers ネイティブの binding を使う。設定が wrangler.jsonc に
 * 残り CD で自動反映される利点もある。
 *
 * 2段構えにする:
 *
 * 1. **IP 単位 (認証より前)** — 不正な Bearer を投げ続けると optionalAuth が毎回 Supabase の
 *    auth API を叩く。認証の後ろにしか制限が無いと、この経路を無制限に叩けてしまう。
 * 2. **ユーザー単位 (認証より後)** — 本命。IP だけだと同一 NAT 配下が巻き添えになるうえ、
 *    IP を変えれば回避できる。ログイン必須にした以上、人単位で数えるのが正しい。
 */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

type LimiterName = "RATE_LIMITER_IP" | "RATE_LIMITER_USER";

function getLimiter(c: Context, name: LimiterName): RateLimiter | undefined {
  const env = c.env as Record<string, RateLimiter | undefined> | undefined;
  return env?.[name];
}

const TOO_MANY = { error: "リクエストが多すぎます。しばらく待って再試行してください" } as const;
const SERVICE_ERROR = { error: "一時的なエラーです。後ほど再度お試しください" } as const;

/**
 * 送信元 IP。Cloudflare が付ける CF-Connecting-IP を使う (X-Forwarded-For は詐称できる)。
 * 本番 Workers では必ず付く。欠落時は "unknown" にフォールバックするが、これは同一キーに
 * 集約される問題 (#258 L-4) がある。
 */
function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

/**
 * IP 単位のレート制限。**optionalAuth より前**に置くこと。
 * 認証に失敗するリクエスト (不正 Bearer) も数えるのが目的。
 *
 * #258 L-4: binding 欠落時は fail-closed。Workers 以外 (Node ローカル/テスト) のみ通す。
 */
export const rateLimitByIp: MiddlewareHandler = async (c, next) => {
  const limiter = getLimiter(c, "RATE_LIMITER_IP");
  if (!limiter) {
    // binding 無い = Node ローカル/テスト環境。素通し。
    return next();
  }

  const { success } = await limiter.limit({ key: clientIp(c) });
  if (!success) return c.json(TOO_MANY, 429);

  // IP ヘッダ欠落 → "unknown" キーに集約される。レート制限が実質機能しない。
  if (!c.req.header("cf-connecting-ip")) {
    console.error("[rate-limit] cf-connecting-ip が欠落 (fail-closed)");
    return c.json(SERVICE_ERROR, 503);
  }

  return next();
};

/** ユーザー単位のレート制限。**認証の後**に置くこと (userId が要る)。 */
export const rateLimitByUser: MiddlewareHandler = async (c, next) => {
  const limiter = getLimiter(c, "RATE_LIMITER_USER");
  if (!limiter) {
    // binding 無い = Node ローカル/テスト環境。素通し。
    return next();
  }

  const { success } = await limiter.limit({ key: c.get("userId") ?? clientIp(c) });
  if (!success) return c.json(TOO_MANY, 429);
  return next();
};
