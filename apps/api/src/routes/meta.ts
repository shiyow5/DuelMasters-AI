import { Hono } from "hono";
import { getSql } from "@dm-ai/db";
import { FORMATS, IngestUrlRequestSchema, aggregateTierData } from "@dm-ai/core";
import { extractTextFromHtml } from "@dm-ai/rag";
import { extractTournament } from "../tournament-extract.js";
import { requireInternal } from "../middleware/auth.js";

const metaRouter = new Hono();

/** Date → "YYYY-MM-DD" */
function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

/** IPv4 のプライベート/ループバック/リンクローカル/メタデータ宛先を判定する */
function isPrivateIPv4(host: string): boolean {
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === "0.0.0.0") return true;
  return false;
}

/**
 * IPv6 の "::ffff:a.b.c.d" (IPv4-mapped) から埋め込み IPv4 を取り出す。
 * WHATWG URL の hostname 正規化後は "::ffff:7f00:1" のように16進2グループ表記になるため両形式に対応する。
 */
function extractMappedIPv4(ip: string): string | null {
  const dotted = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dotted) return dotted[1];
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(".");
}

/** IPv6 のループバック/未指定/ユニークローカル/リンクローカル/IPv4-mapped プライベートを判定する */
function isPrivateIPv6(ip: string): boolean {
  if (ip === "::1" || ip === "::") return true; // ループバック・未指定

  const mappedV4 = extractMappedIPv4(ip);
  if (mappedV4) return isPrivateIPv4(mappedV4); // 埋め込み IPv4 側の判定を流用

  // 先頭グループの数値でユニークローカル/リンクローカルを判定する
  // (16進文字列の先頭一致では "00fc::1"(=0x00fc) のような桁落ちで誤判定しうるため数値化する)
  const firstGroup = ip.split(":")[0];
  if (/^[0-9a-f]{1,4}$/i.test(firstGroup)) {
    const val = parseInt(firstGroup, 16);
    if (val >= 0xfc00 && val <= 0xfdff) return true; // ユニークローカル fc00::/7
    if (val >= 0xfe80 && val <= 0xfebf) return true; // リンクローカル fe80::/10
  }
  return false;
}

/**
 * SSRF 対策: http(s) かつプライベート/ループバック/リンクローカル/メタデータ宛先でないことを確認する。
 * (DNS リバインディングまでは防げないため、公開運用では解決後 IP の再チェックも検討)
 */
function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;

  // IPv6 リテラルは hostname が "[::1]" のように角括弧付きで返るため剥がして正規化する
  let host = u.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  if (host === "localhost" || host.endsWith(".localhost")) return false;

  if (host.includes(":")) {
    if (isPrivateIPv6(host)) return false;
  } else {
    if (isPrivateIPv4(host)) return false;
  }
  return true;
}

/** ティアリスト取得 */
metaRouter.get("/tier", async (c) => {
  const format = c.req.query("format") ?? "original";
  if (!(FORMATS as readonly string[]).includes(format)) {
    return c.json({ error: `format は ${FORMATS.join(" | ")} のいずれかを指定してください` }, 400);
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
        AND period_end >= ${isoDate(periodStart)}
      ORDER BY period_end DESC
      LIMIT 1
    `;

    if (snapshots.length === 0) {
      // スナップショットがない場合は tournament_results から集計
      const results = await sql`
        SELECT deck_archetype, COUNT(*)::int as count,
               (COUNT(*) FILTER (WHERE placement <= 8))::int as top8_count
        FROM tournament_results
        WHERE format = ${format}
          AND event_date >= ${isoDate(periodStart)}
        GROUP BY deck_archetype
        ORDER BY count DESC
      `;

      if (results.length === 0) {
        return c.json({
          format,
          period: `${weeks}w`,
          period_start: isoDate(periodStart),
          period_end: isoDate(periodEnd),
          tier_data: [],
        });
      }

      const tierData = aggregateTierData(results);

      return c.json({
        format,
        period: `${weeks}w`,
        period_start: isoDate(periodStart),
        period_end: isoDate(periodEnd),
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
      period_start: isoDate(periodStart),
      period_end: isoDate(periodEnd),
      tier_data: [],
    });
  }
});

/** アーキタイプ詳細 */
metaRouter.get("/archetype/:name", async (c) => {
  const name = c.req.param("name");
  const format = c.req.query("format") ?? "original";
  if (!(FORMATS as readonly string[]).includes(format)) {
    return c.json({ error: `format は ${FORMATS.join(" | ")} のいずれかを指定してください` }, 400);
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
        COUNT(*)::int as total_entries,
        (COUNT(*) FILTER (WHERE placement = 1))::int as wins,
        (COUNT(*) FILTER (WHERE placement <= 4))::int as top4,
        (COUNT(*) FILTER (WHERE placement <= 8))::int as top8
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
    console.error("[api/meta] archetype 取得に失敗 (フォールバック応答を返します):", err);
    return c.json({
      archetype: name,
      format,
      stats: { total_entries: 0, wins: 0, top4: 0, top8: 0 },
      recent_results: [],
    });
  }
});

/** 大会結果ページの取り込み (Gemini 汎用抽出)。X-Internal-Key 必須 */
metaRouter.post("/ingest/url", requireInternal, async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = IngestUrlRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: "リクエストが不正です",
        details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      400,
    );
  }
  const { url, format } = parsed.data;
  if (!isPublicHttpUrl(url)) {
    return c.json(
      { error: "許可されていない URL です (内部/プライベート宛先は取得できません)" },
      400,
    );
  }

  let html: string;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.error("[api/meta] ページ取得失敗:", err);
    return c.json({ error: "ページを取得できませんでした" }, 502);
  }

  let extracted;
  try {
    extracted = await extractTournament(extractTextFromHtml(html));
  } catch (err) {
    console.error("[api/meta] 大会結果抽出失敗:", err);
    return c.json({ error: "大会結果を抽出できませんでした" }, 422);
  }

  const sql = getSql();
  let inserted = 0;
  let skipped = 0;
  for (const r of extracted.results) {
    const result = await sql`
      INSERT INTO tournament_results
        (event_name, event_date, format, participants, deck_archetype, placement, source_url)
      VALUES (${extracted.event_name}, ${extracted.event_date}, ${format},
              ${extracted.participants}, ${r.deck_archetype}, ${r.placement}, ${url})
      ON CONFLICT (event_name, event_date, format, deck_archetype, placement) DO NOTHING
    `;
    if (result.count > 0) inserted++;
    else skipped++;
  }

  return c.json({
    event_name: extracted.event_name,
    event_date: extracted.event_date,
    inserted,
    skipped,
  });
});

export { metaRouter };
