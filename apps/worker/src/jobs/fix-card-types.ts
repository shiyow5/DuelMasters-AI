/**
 * 既存 cards.type を CardType enum に正規化する補正スクリプト。
 * 変換できた行のみ UPDATE し、変換不能な種別は件数を列挙して残す。
 */
import { getSql, closeDb } from "@dm-ai/db";
import { normalizeCardType } from "../card-type-map.js";

async function main() {
  console.log("=== カード種別補正開始 ===");
  const sql = getSql();
  const rows = await sql`SELECT id, type FROM cards`;
  let updated = 0;
  const unknown: Record<string, number> = {};

  for (const row of rows) {
    const raw = row.type as string;
    const normalized = normalizeCardType(raw);
    if (normalized === null) {
      unknown[raw] = (unknown[raw] ?? 0) + 1;
      continue;
    }
    if (normalized !== raw) {
      await sql`UPDATE cards SET type = ${normalized}, updated_at = NOW() WHERE id = ${row.id as number}`;
      updated++;
    }
  }

  console.log(`=== カード種別補正完了: ${updated}件更新 ===`);
  if (Object.keys(unknown).length > 0) {
    console.warn("変換不能な種別 (要手動対応):", unknown);
  }
  await closeDb();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
