import { Hono } from "hono";
import { getSql } from "@dm-ai/db";
import { FORMATS } from "@dm-ai/core";

const metaRouter = new Hono();

/** ティアリスト取得 */
metaRouter.get("/tier", async (c) => {
  const format = c.req.query("format") ?? "original";
  if (!(FORMATS as readonly string[]).includes(format)) {
    return c.json(
      { error: `format は ${FORMATS.join(" | ")} のいずれかを指定してください` },
      400
    );
  }
  const period = c.req.query("period") ?? "4w";

  const weeks = parseInt(period.replace("w", ""), 10) || 4;
  const periodEnd = new Date();
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - weeks * 7);

  try {
    const sql = getSql();

    // スナップショットから最新を取得
    const snapshots = await sql`
      SELECT tier_data, period_start, period_end, created_at
      FROM meta_snapshots
      WHERE format = ${format}
        AND period_end >= ${periodStart.toISOString().split("T")[0]}
      ORDER BY period_end DESC
      LIMIT 1
    `;

    if (snapshots.length === 0) {
      // スナップショットがない場合は tournament_results から集計
      const results = await sql`
        SELECT deck_archetype, COUNT(*) as count,
               COUNT(*) FILTER (WHERE placement <= 8) as top8_count
        FROM tournament_results
        WHERE format = ${format}
          AND event_date >= ${periodStart.toISOString().split("T")[0]}
        GROUP BY deck_archetype
        ORDER BY count DESC
      `;

      if (results.length === 0) {
        return c.json({
          format,
          period: `${weeks}w`,
          period_start: periodStart.toISOString().split("T")[0],
          period_end: periodEnd.toISOString().split("T")[0],
          tier_data: [],
        });
      }

      const totalEntries = results.reduce(
        (sum, r) => sum + (r.count as number),
        0
      );

      const tierData = results.map((r) => {
        const usageRate = (r.count as number) / totalEntries;
        const tier =
          usageRate >= 0.15 ? "Tier1" : usageRate >= 0.08 ? "Tier2" : "Tier3";
        return {
          tier,
          archetype: r.deck_archetype as string,
          usage_rate: Math.round(usageRate * 1000) / 10,
          win_rate: null,
          sample_decklist: null,
        };
      });

      return c.json({
        format,
        period: `${weeks}w`,
        period_start: periodStart.toISOString().split("T")[0],
        period_end: periodEnd.toISOString().split("T")[0],
        tier_data: tierData,
      });
    }

    return c.json({
      format,
      period: `${weeks}w`,
      period_start: snapshots[0].period_start,
      period_end: snapshots[0].period_end,
      tier_data: snapshots[0].tier_data,
    });
  } catch (err) {
    console.error("[api/meta] tier 取得に失敗 (フォールバック応答を返します):", err);
    // DB未接続の場合は空データを返す
    return c.json({
      format,
      period: `${weeks}w`,
      period_start: periodStart.toISOString().split("T")[0],
      period_end: periodEnd.toISOString().split("T")[0],
      tier_data: [],
    });
  }
});

/** アーキタイプ詳細 */
metaRouter.get("/archetype/:name", async (c) => {
  const name = c.req.param("name");
  const format = c.req.query("format") ?? "original";
  if (!(FORMATS as readonly string[]).includes(format)) {
    return c.json(
      { error: `format は ${FORMATS.join(" | ")} のいずれかを指定してください` },
      400
    );
  }

  try {
    const sql = getSql();

    const results = await sql`
      SELECT event_name, event_date, placement, participants, source_url
      FROM tournament_results
      WHERE deck_archetype = ${name} AND format = ${format}
      ORDER BY event_date DESC
      LIMIT 20
    `;

    const stats = await sql`
      SELECT
        COUNT(*) as total_entries,
        COUNT(*) FILTER (WHERE placement = 1) as wins,
        COUNT(*) FILTER (WHERE placement <= 4) as top4,
        COUNT(*) FILTER (WHERE placement <= 8) as top8
      FROM tournament_results
      WHERE deck_archetype = ${name} AND format = ${format}
    `;

    return c.json({
      archetype: name,
      format,
      stats: stats[0],
      recent_results: results,
    });
  } catch (err) {
    console.error(
      "[api/meta] archetype 取得に失敗 (フォールバック応答を返します):",
      err
    );
    return c.json({
      archetype: name,
      format,
      stats: { total_entries: 0, wins: 0, top4: 0, top8: 0 },
      recent_results: [],
    });
  }
});

/** URLオンデマンド取り込み */
metaRouter.post("/ingest/url", async (c) => {
  const { url } = await c.req.json<{ url: string }>();

  // 現時点ではURLを保存のみ (パース実装は段階的に)
  return c.json({
    message: "URL取り込みは今後のアップデートで実装されます",
    url,
    status: "pending",
  });
});

export { metaRouter };
