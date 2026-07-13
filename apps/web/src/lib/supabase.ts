import { createClient } from "@supabase/supabase-js";
import { parseAuthHash, type AuthHash } from "./auth-hash";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * 着地時の URL ハッシュ (招待 / パスワード再設定 / エラー)。
 *
 * **createClient より前に読むこと。** supabase-js は `detectSessionInUrl` が既定で有効で、
 * 初期化時にハッシュを読んでセッションを張り、**そのハッシュを URL から消す**。
 * あとから `window.location.hash` を見ても遅い (空になっている)。
 * ここはモジュールのトップレベルなので、createClient より確実に先に走る。
 */
export const initialAuthHash: AuthHash =
  typeof window === "undefined"
    ? { type: null, error: null, description: null }
    : parseAuthHash(window.location.hash);

/** 環境変数が無い場合は null (ログイン機能を無効化して従来どおり動く) */
export const supabase = url && anonKey ? createClient(url, anonKey) : null;
