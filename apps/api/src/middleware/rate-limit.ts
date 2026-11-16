import type { Context, MiddlewareHandler } from "hono";
import { allowAnonymous } from "./auth.js";

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

/** Cloudflare Workers 上で動いているか。テストで差し替えられるよう関数に分離する。 */
export function isCloudflareWorkers(): boolean {
  return globalThis.navigator?.userAgent === "Cloudflare-Workers";
}

/**
 * binding が無いときに素通しして良いか。
 * Workers 上かつ ALLOW_ANONYMOUS が "true" でない (= 本番相当) なら通さない (fail-closed)。
 * Node (ローカル開発・テスト) と ALLOW_ANONYMOUS=true は素通し。
 */
function mayBypassWithoutBinding(c: Context): boolean {
  return !isCloudflareWorkers() || allowAnonymous(c);
}

/** 送信元 IP。Cloudflare が付ける CF-Connecting-IP を使う (X-Forwarded-For は詐称できる)。無ければ undefined。 */
function clientIp(c: Context): string | undefined {
  return c.req.header("cf-connecting-ip") || undefined;
}

function failClosed(c: Context, reason: string) {
  console.error(`[rate-limit] ${reason} (fail-closed)`);
  return c.json(SERVICE_ERROR, 503);
}

/**
 * IP 単位のレート制限。**optionalAuth より前**に置くこと。
 * 認証に失敗するリクエスト (不正 Bearer) も数えるのが目的。
 *
 * #258: binding 欠落時は Workers 本番相当なら 503 (fail-closed)。IP 欠落時は
 * limit() を呼ばずに 503 (共有キーに集約されるのを避ける)。
 */
export const rateLimitByIp: MiddlewareHandler = async (c, next) => {
  const limiter = getLimiter(c, "RATE_LIMITER_IP");
  if (!limiter) {
    if (mayBypassWithoutBinding(c)) return next();
    return failClosed(c, "RATE_LIMITER_IP binding が無い");
  }

  const ip = clientIp(c);
  if (!ip) return failClosed(c, "cf-connecting-ip が欠落");

  const { success } = await limiter.limit({ key: ip });
  if (!success) return c.json(TOO_MANY, 429);
  return next();
};

/** ユーザー単位のレート制限。**認証の後**に置くこと (userId が要る)。 */
export const rateLimitByUser: MiddlewareHandler = async (c, next) => {
  const limiter = getLimiter(c, "RATE_LIMITER_USER");
  if (!limiter) {
    if (mayBypassWithoutBinding(c)) return next();
    return failClosed(c, "RATE_LIMITER_USER binding が無い");
  }

  const key = c.get("userId") || clientIp(c);
  if (!key) return failClosed(c, "userId も cf-connecting-ip も無い");

  const { success } = await limiter.limit({ key });
  if (!success) return c.json(TOO_MANY, 429);
  return next();
};
