import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

let _supabase: SupabaseClient | null = null;
let _db: PostgresJsDatabase<typeof schema> | null = null;
let _sql: ReturnType<typeof postgres> | null = null;

/** Supabase クライアント (認証・ストレージ等) */
export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key =
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error(
        "SUPABASE_URL と、SUPABASE_SERVICE_ROLE_KEY または SUPABASE_ANON_KEY が必要です"
      );
    }
    _supabase = createClient(url, key);
  }
  return _supabase;
}

/** Drizzle ORM (SQL クエリ) */
export function getDb(): PostgresJsDatabase<typeof schema> {
  if (!_db) {
    _db = drizzle(getSql(), { schema });
  }
  return _db;
}

/** raw SQL クライアント */
export function getSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required");
    }
    _sql = postgres(databaseUrl);
  }
  return _sql;
}

/** 接続終了 */
export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
    _db = null;
  }
}

export { schema };
