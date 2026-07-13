/**
 * メタスナップショット生成ジョブ。期間+format で集計し meta_snapshots に UPSERT する。
 *
 * 集計元は2段構え:
 *  1. archetype_weekly_stats (週次入賞数ランキング) — **こちらが一次ソース**。
 *     取込元が集計している母集団の全量 (母数つき)。
 *  2. tournament_results (個別 CS 記事) — 週次ランキングが1週も無いときのフォールバック。
 *     記事化された CS だけの偏った標本なので、使えるなら 1 を使う。
 */
import { pathToFileURL } from "node:url";
import { getSql, closeDb } from "@dm-ai/db";
import { aggregateTierData, mergeArchetypeCounts, type Format } from "@dm-ai/core";

export type SnapshotSource = "weekly" | "events";

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export async function runSnapshotMeta(
  format: Format,
  weeks = 4,
): Promise<{ created: boolean; archetypes: number; source: SnapshotSource | null }> {
  const sql = getSql();
  const periodEnd = new Date();
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - weeks * 7);
  const since = isoDate(periodStart);

  // 週次ランキング (母集団の全量)。期間内に終わった週の入賞数を足し合わせる。
  const weekly = await sql`
    SELECT deck_archetype, SUM(entries)::int as count
    FROM archetype_weekly_stats
    WHERE format = ${format} AND period_end >= ${since}
    GROUP BY deck_archetype
    ORDER BY count DESC
  `;

  const results =
    weekly.length > 0
      ? weekly
      : await sql`
          SELECT deck_archetype, COUNT(*)::int as count
          FROM tournament_results
          WHERE format = ${format} AND event_date >= ${since}
          GROUP BY deck_archetype
          ORDER BY count DESC
        `;
  const source: SnapshotSource = weekly.length > 0 ? "weekly" : "events";

  if (results.length === 0) {
    console.log("対象期間の大会結果がありません (スナップショットは作成しません)");
    await closeDb();
    return { created: false, archetypes: 0, source: null };
  }

  // SQL の GROUP BY は「アナカラージャオウガ」と「アナカラー ジャオウガ」を別物として数える。
  // 取込元の表記は揺れるので、集計前に畳む。
  const tierData = aggregateTierData(
    mergeArchetypeCounts(
      results.map((r) => ({
        deck_archetype: r.deck_archetype as string,
        count: r.count as number,
      })),
    ),
  );

  await sql`
    INSERT INTO meta_snapshots (format, period_start, period_end, tier_data)
    VALUES (${format}, ${isoDate(periodStart)}, ${isoDate(periodEnd)}, ${sql.json(tierData)})
    ON CONFLICT (format, period_start, period_end)
    DO UPDATE SET tier_data = EXCLUDED.tier_data
  `;

  const label = source === "weekly" ? "週次ランキング" : "個別CS記事 (標本が偏る点に注意)";
  console.log(
    `=== メタスナップショット生成完了: ${format} / ${tierData.length}アーキタイプ / 集計元=${label} ===`,
  );
  await closeDb();
  return { created: true, archetypes: tierData.length, source };
}

/** CLI 引数を検証する */
export function parseSnapshotArgs(argv: string[]): { format: Format; weeks: number } | null {
  const format = argv[0];
  if (format !== "original" && format !== "advance") return null;
  const weeks = parseInt(argv[1] ?? "4", 10) || 4;
  return { format, weeks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseSnapshotArgs(process.argv.slice(2));
  if (!parsed) {
    console.error("使用法: tsx src/jobs/snapshot-meta.ts <original|advance> [weeks=4]");
    process.exit(1);
  }
  runSnapshotMeta(parsed.format, parsed.weeks)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
