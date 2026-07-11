import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** 環境変数が無い場合は null (ログイン機能を無効化して従来どおり動く) */
export const supabase = url && anonKey ? createClient(url, anonKey) : null;
