import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { AsyncLocalStorage } from "node:async_hooks";
import * as schema from "./schema.js";

type Sql = ReturnType<typeof postgres>;

// Node (worker / tests) 用のプロセス内シングルトン。
let _supabase: SupabaseClient | null = null;
let _db: PostgresJsDatabase<typeof schema> | null = null;
let _sql: Sql | null = null;

/**
 * 接続情報の注入。Cloudflare Workers には process.env が無く、接続情報は binding 経由でしか
 * 渡せないため、リクエストのミドルウェアから c.env の値を渡す。値は env 由来の定数なので、
 * 同一 isolate で並行リクエストが同じ値を書いても安全。未注入なら process.env にフォールバック。
 */
let _config: { databaseUrl?: string; supabaseUrl?: string; supabaseKey?: string } = {};
export function configureDb(cfg: {
  databaseUrl?: string;
  supabaseUrl?: string;
  supabaseKey?: string;
}): void {
  _config = { ..._config, ...cfg };
}

/**
 * リクエストスコープの sql クライアント。
 * Cloudflare Workers は「別リクエストの I/O を跨いで使えない」制約があるため、Workers 側は
 * リクエスト毎に生成した sql を AsyncLocalStorage に載せ、getSql() はそれを優先的に返す。
 * Node (シングルトン常駐) では ALS は未設定なので従来どおりプロセス内シングルトンを使う。
 */
const sqlStore = new AsyncLocalStorage<Sql>();

/** 接続文字列から postgres.js クライアントを生成する (Workers のミドルウェアが使用)。 */
export function createSql(connectionString: string): Sql {
  return postgres(connectionString);
}

/** 与えた sql を AsyncLocalStorage に載せて fn を実行する (Workers のリクエストスコープ接続)。 */
export function runWithSql<T>(sql: Sql, fn: () => T): T {
  return sqlStore.run(sql, fn);
}

/** Supabase クライアント (認証・ストレージ等)。HTTP ベースなのでシングルトン共有で問題ない。 */
export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    const url = _config.supabaseUrl ?? process.env.SUPABASE_URL;
    const key =
      _config.supabaseKey ??
      process.env.SUPABASE_SERVICE_ROLE_KEY ??
      process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error(
        "SUPABASE_URL と、SUPABASE_SERVICE_ROLE_KEY または SUPABASE_ANON_KEY が必要です",
      );
    }
    _supabase = createClient(url, key);
  }
  return _supabase;
}

/** raw SQL クライアント。Workers はリクエストスコープ、Node はプロセス内シングルトン。 */
export function getSql(): Sql {
  const scoped = sqlStore.getStore();
  if (scoped) return scoped;
  if (!_sql) {
    const databaseUrl = _config.databaseUrl ?? process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required");
    }
    _sql = postgres(databaseUrl);
  }
  return _sql;
}

/** Drizzle ORM (SQL クエリ)。sql の解決 (ALS or シングルトン) に追随する。 */
export function getDb(): PostgresJsDatabase<typeof schema> {
  const scoped = sqlStore.getStore();
  if (scoped) return drizzle(scoped, { schema });
  if (!_db) {
    _db = drizzle(getSql(), { schema });
  }
  return _db;
}

/** 接続終了 (Node のシングルトンのみ。Workers のリクエストスコープ接続はミドルウェアが閉じる)。 */
export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
    _db = null;
  }
}

export { schema };
