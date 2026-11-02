/**
 * 取込データの鮮度チェック (読み取りだけ)。
 *
 * 取込の workflow は動いているのに、データが古い・欠けている状態を捕まえる。
 * 問題があれば `::error::` を出して exit 1 → freshness workflow が失敗し、Issue が起票される。
 *
 * | チェック | 見る列 | 既定の閾値 | 超えたら |
 * |---|---|---|---|
 * | weekly (週次ランキング) | archetype_weekly_stats.period_end | 9日 | fail |
 * | snapshot (メタ集計) | meta_snapshots.period_end | 8日 | fail |
 * | events (個別 CS 記事) | tournament_results.event_date | 14日 | warning だけ |
 *
 * - 「閾値以上に古い」で引っかける (age >= maxAge)。行が無い format も古いとみなす。
 * - meta_snapshots.period_end は「データの最終週」ではなく「snapshot を実行した日」。
 *   snapshot が動いていれば週次ランキングが欠けていても新しくなるので、weekly を別に見る。
 * - 日付の基準は JST。DATE 列は `::text` で文字列のまま受け取り、Date のタイムゾーン変換を挟まない。
 * - **workflow 自体が止まった場合 (public リポジトリの schedule は60日無活動で自動停止) は検知できない。**
 *   このチェックも同じ GitHub Actions で動くので、一緒に止まる。
 *
 * 使い方: tsx src/jobs/check-freshness.ts [--weekly-max-age=9] [--snapshot-max-age=8] [--events-max-age=14]
 */
import { pathToFileURL } from "node:url";
import { getSql, closeDb } from "@dm-ai/db";
import { FORMATS, type Format } from "@dm-ai/core";

type Sql = ReturnType<typeof getSql>;

export type FreshnessCheck = "weekly" | "snapshot" | "events";

export interface FreshnessThresholds {
  /** 週次ランキングの最終 period_end が今日から何日以上前なら fail か */
  weeklyMaxAge: number;
  /** メタスナップショットの最終 period_end が今日から何日以上前なら fail か */
  snapshotMaxAge: number;
  /** 個別 CS の最終 event_date が今日から何日以上前なら warning か */
  eventsMaxAge: number;
}

export const DEFAULT_THRESHOLDS: FreshnessThresholds = {
  weeklyMaxAge: 9,
  snapshotMaxAge: 8,
  eventsMaxAge: 14,
};

/** format ごとの最終日 (YYYY-MM-DD)。DB の `max(...)::text` をそのまま入れる */
export interface LatestDateRow {
  format: string;
  latest: string | null;
}

export interface FreshnessRows {
  weekly: LatestDateRow[];
  snapshot: LatestDateRow[];
  events: LatestDateRow[];
}

export interface FreshnessFinding {
  check: FreshnessCheck;
  format: Format;
  latest: string | null;
  /** 今日 (JST) − latest の日数。行が無ければ null */
  ageDays: number | null;
  maxAge: number;
  level: "ok" | "error" | "warning";
  message: string;
}

export interface FreshnessResult {
  ok: boolean;
  today: string;
  findings: FreshnessFinding[];
  errors: FreshnessFinding[];
  warnings: FreshnessFinding[];
}

const CHECK_LABELS: Record<FreshnessCheck, string> = {
  weekly: "週次ランキング (archetype_weekly_stats)",
  snapshot: "メタスナップショット (meta_snapshots)",
  events: "個別CS (tournament_results)",
};

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** その瞬間の JST の日付 (YYYY-MM-DD) */
export function jstDate(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD 同士の日数差 (to − from) */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * 鮮度を判定する (純粋関数。DB に触らない)。
 *
 * @param rows 各テーブルの format ごとの最終日
 * @param now 判定の基準時刻。JST の日付に直して比べる
 * @param thresholds 閾値 (日数)
 */
export function evaluateFreshness(
  rows: FreshnessRows,
  now: Date,
  thresholds: FreshnessThresholds = DEFAULT_THRESHOLDS,
): FreshnessResult {
  const today = jstDate(now);
  const plan: Array<{ check: FreshnessCheck; maxAge: number; failLevel: "error" | "warning" }> = [
    { check: "weekly", maxAge: thresholds.weeklyMaxAge, failLevel: "error" },
    { check: "snapshot", maxAge: thresholds.snapshotMaxAge, failLevel: "error" },
    { check: "events", maxAge: thresholds.eventsMaxAge, failLevel: "warning" },
  ];

  const findings: FreshnessFinding[] = [];
  for (const { check, maxAge, failLevel } of plan) {
    for (const format of FORMATS) {
      const raw = rows[check].find((r) => r.format === format)?.latest ?? null;
      // DB から ISO 以外が来たら「読めない = 行が無い」扱いにする (黙って ok にしない)
      const latest = raw && ISO_DATE.test(raw.slice(0, 10)) ? raw.slice(0, 10) : null;
      const label = `${CHECK_LABELS[check]} / ${format}`;
      if (latest === null) {
        findings.push({
          check,
          format,
          latest: null,
          ageDays: null,
          maxAge,
          level: failLevel,
          message: `${label}: 行がありません (閾値 ${maxAge}日)`,
        });
        continue;
      }
      const ageDays = daysBetween(latest, today);
      const stale = ageDays >= maxAge;
      findings.push({
        check,
        format,
        latest,
        ageDays,
        maxAge,
        level: stale ? failLevel : "ok",
        message: stale
          ? `${label}: 最終日 ${latest} は ${ageDays}日前 (閾値 ${maxAge}日以上で${failLevel === "error" ? "失敗" : "警告"})`
          : `${label}: 最終日 ${latest} (${ageDays}日前)`,
      });
    }
  }

  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warning");
  return { ok: errors.length === 0, today, findings, errors, warnings };
}

/** DB から各テーブルの最終日を読む。read only トランザクションで SELECT だけを流す */
export async function fetchFreshnessRows(): Promise<FreshnessRows> {
  const sql = getSql();
  return sql.begin("read only", async (tx) => {
    // postgres の TransactionSql 型は呼び出せない型になっている (既存の deprecate-rulings と同じ回避)
    const txSql = tx as unknown as Sql;
    const weekly = await txSql<LatestDateRow[]>`
      SELECT format, max(period_end)::text AS latest
      FROM archetype_weekly_stats GROUP BY format
    `;
    const snapshot = await txSql<LatestDateRow[]>`
      SELECT format, max(period_end)::text AS latest
      FROM meta_snapshots GROUP BY format
    `;
    const events = await txSql<LatestDateRow[]>`
      SELECT format, max(event_date)::text AS latest
      FROM tournament_results GROUP BY format
    `;
    return { weekly: [...weekly], snapshot: [...snapshot], events: [...events] };
  }) as Promise<FreshnessRows>;
}

/** 鮮度を判定してログに出す。exit はしない (CLI 側で結果から決める) */
export async function runCheckFreshness(
  thresholds: FreshnessThresholds = DEFAULT_THRESHOLDS,
  now: Date = new Date(),
): Promise<FreshnessResult> {
  const rows = await fetchFreshnessRows();
  const result = evaluateFreshness(rows, now, thresholds);

  console.log(`=== 鮮度チェック (今日 JST ${result.today}) ===`);
  for (const f of result.findings) {
    if (f.level === "error") console.log(`::error::${f.message}`);
    else if (f.level === "warning") console.log(`::warning::${f.message}`);
    else console.log(`ok: ${f.message}`);
  }
  console.log(
    result.ok
      ? `=== 鮮度チェック: OK (警告 ${result.warnings.length}件) ===`
      : `=== 鮮度チェック: NG (失敗 ${result.errors.length}件 / 警告 ${result.warnings.length}件) ===`,
  );
  return result;
}

const ARG_KEYS: Record<string, keyof FreshnessThresholds> = {
  "--weekly-max-age": "weeklyMaxAge",
  "--snapshot-max-age": "snapshotMaxAge",
  "--events-max-age": "eventsMaxAge",
};

/** CLI 引数を検証する。不正なら null */
export function parseFreshnessArgs(argv: string[]): FreshnessThresholds | null {
  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (const arg of argv) {
    const [key, value] = arg.split("=", 2);
    const field = ARG_KEYS[key];
    if (!field || value === undefined || !/^\d+$/.test(value)) return null;
    const n = parseInt(value, 10);
    if (n < 1) return null;
    thresholds[field] = n;
  }
  return thresholds;
}

/**
 * 実行時エラーを、公開してよい要点 (code と name) だけの1行にする。
 *
 * このログの末尾は公開 Issue と Step Summary に貼られる (freshness.yml)。
 * postgres.js の接続エラーは message や本体にホスト名・DB ユーザー名を含みうるので、
 * message も err 本体も出さない。code / name は英数字と `_` だけの短い値に限って出す。
 */
export function describeRunError(err: unknown): string {
  const pick = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_]{1,40}$/.test(v) ? v : null);
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    code?: unknown;
    name?: unknown;
  };
  const code = pick(e.code);
  const name = pick(e.name);
  const parts = [code && `code=${code}`, name && `name=${name}`].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "詳細なし";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const thresholds = parseFreshnessArgs(process.argv.slice(2));
  if (!thresholds) {
    console.error(
      "使用法: tsx src/jobs/check-freshness.ts [--weekly-max-age=9] [--snapshot-max-age=8] [--events-max-age=14] (1以上の整数)",
    );
    process.exit(2);
  }
  runCheckFreshness(thresholds)
    .then(async (r) => {
      await closeDb();
      process.exit(r.ok ? 0 : 1);
    })
    .catch(async (err) => {
      // err 本体・message は出さない (接続情報を含みうる。describeRunError 参照)。
      console.error(
        `::error::鮮度チェックを実行できませんでした (${describeRunError(err)})。接続情報を含みうるので詳細は出していません`,
      );
      await closeDb().catch(() => undefined);
      process.exit(1);
    });
}
