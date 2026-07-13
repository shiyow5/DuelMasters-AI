/**
 * Supabase がリダイレクトで返してくる URL ハッシュの解釈。
 *
 * 招待・パスワード再設定のリンクは、Supabase の verify を経てから
 * **Site URL に `#access_token=...&type=invite` を付けて**戻ってくる。失敗時は
 * `#error=access_denied&error_code=otp_expired&...` が付く。
 *
 * これを読まないと:
 * - 招待された人はログインはできても**パスワードを設定できない**(次回から入れない)
 * - 期限切れリンクを踏んだ人には真っ白な画面しか出ず、何が起きたのか分からない
 */

/** パスワード設定画面に入るべき遷移。magiclink 等の未知の type では出さない。 */
const PASSWORD_SETUP_TYPES = new Set(["invite", "recovery"]);

export interface AuthHash {
  /** "invite" | "recovery" | null */
  type: string | null;
  /** Supabase の error_code (例 "otp_expired")。 */
  error: string | null;
  /** 人間向けの説明 (error_description)。 */
  description: string | null;
}

export function parseAuthHash(hash: string): AuthHash {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return { type: null, error: null, description: null };

  const params = new URLSearchParams(raw);
  const type = params.get("type");
  const error = params.get("error_code") ?? params.get("error");

  // **トークンを伴わない type= は信じない。**
  // ハッシュは利用者 (や攻撃者) が自由に書ける。type だけで判定すると、既にログイン済みの人に
  // `https://<本物のドメイン>/#type=invite` を踏ませるだけで、正規ドメイン上に
  // 「パスワードを設定してください」画面を出せてしまう (フィッシングの足場になる)。
  // 本物の招待/再設定の着地には、必ず Supabase が発行したトークンが伴う。
  const hasToken = params.has("access_token") || params.has("refresh_token");
  const setupType = type !== null && hasToken && PASSWORD_SETUP_TYPES.has(type) ? type : null;

  return {
    type: setupType,
    error: error,
    // URLSearchParams が + と %xx を復号する。
    description: params.get("error_description"),
  };
}
