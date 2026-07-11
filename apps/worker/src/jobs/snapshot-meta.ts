/**
 * メタスナップショット生成ジョブ。
 * tournament_results を期間+format で集計し meta_snapshots に UPSERT する。
 */
import { pathToFileURL } from "node:url";
import { getSql, closeDb } from "@dm-ai/db";
import { aggregateTierData, type Format } from "@dm-ai/core";

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export async function runSnapshotMeta(
  format: Format,
  weeks = 4
): Promise<{ created: boolean; archetypes: number }> {
  const sql = getSql();
  const periodEnd = new Date();
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - weeks * 7);

  const results = await sql`
    SELECT deck_archetype, COUNT(*)::int as count
    FROM tournament_results
    WHERE format = ${format} AND event_date >= ${isoDate(periodStart)}
    GROUP BY deck_archetype
    ORDER BY count DESC
  `;

  if (results.length === 0) {
    console.log("対象期間の大会結果がありません (スナップショットは作成しません)");
    await closeDb();
    return { created: false, archetypes: 0 };
  }

  const tierData = aggregateTierData(results);

  await sql`
    INSERT INTO meta_snapshots (format, period_start, period_end, tier_data)
    VALUES (${format}, ${isoDate(periodStart)}, ${isoDate(periodEnd)}, ${sql.json(tierData)})
    ON CONFLICT (format, period_start, period_end)
    DO UPDATE SET tier_data = EXCLUDED.tier_data
  `;

  console.log(
    `=== メタスナップショット生成完了: ${format} / ${tierData.length}アーキタイプ ===`
  );
  await closeDb();
  return { created: true, archetypes: tierData.length };
}

/** CLI 引数を検証する */
export function parseSnapshotArgs(
  argv: string[]
): { format: Format; weeks: number } | null {
  const format = argv[0];
  if (format !== "original" && format !== "advance") return null;
  const weeks = parseInt(argv[1] ?? "4", 10) || 4;
  return { format, weeks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseSnapshotArgs(process.argv.slice(2));
  if (!parsed) {
    console.error(
      "使用法: tsx src/jobs/snapshot-meta.ts <original|advance> [weeks=4]"
    );
    process.exit(1);
  }
  runSnapshotMeta(parsed.format, parsed.weeks)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
