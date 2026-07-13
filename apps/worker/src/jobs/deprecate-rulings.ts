/**
 * レビュー済みの廃止裁定一覧を `chunk_meta.deprecated` に反映するジョブ (#92)。
 *
 * 裁定取込 (ingest-rulings) は qa_id 単位の DELETE+INSERT なので、そこで書いた印は
 * **次の週次 cron で消える**。そのため印は取込のたびに一覧から貼り直す
 * (runIngestRulings の最後で呼ぶ)。一覧が正・DB は写像、という向きにしておくと、
 * 誤検出の取り消しが「配列から1行消す」だけで済む。
 *
 * 一覧から外れた裁定の印は**明示的に剥がす**。これをやらないと、一度立てた印が
 * DB に残り続けて戻せなくなる (= 実質「削除」と同じ不可逆性になる)。
 */
import { pathToFileURL } from "node:url";
import { getSql, closeDb } from "@dm-ai/db";
import { DEPRECATED_RULINGS, type DeprecatedRuling } from "../data/deprecated-rulings.js";

type Sql = ReturnType<typeof getSql>;

export interface DeprecateResult {
  /** 印を付けた (または付け直した) 裁定の行数。 */
  flagged: number;
  /** 一覧から外れたので印を剥がした行数。 */
  cleared: number;
}

/**
 * 一覧を DB に反映する。冪等。
 *
 * @param list 省略時はレビュー済みの `DEPRECATED_RULINGS`。テストでは差し替える。
 */
export async function applyDeprecations(
  sql: Sql,
  list: DeprecatedRuling[] = DEPRECATED_RULINGS,
): Promise<DeprecateResult> {
  const keep = list.map((d) => String(d.qaId));

  return sql.begin(async (tx) => {
    const txSql = tx as unknown as Sql;

    // 一覧から外れた裁定の印を剥がす (誤検出の取り消しが効くようにする)。
    // 一覧が空のときは「印の付いた裁定すべて」が対象。NOT IN () は書けないので分ける。
    const cleared = await (keep.length > 0
      ? txSql`
          UPDATE rule_chunks
          SET chunk_meta = chunk_meta - 'deprecated' - 'deprecated_by' - 'deprecated_reason'
          WHERE doc_type = 'ruling'
            AND chunk_meta ? 'deprecated'
            AND chunk_meta->>'qa_id' NOT IN ${txSql(keep)}
          RETURNING id`
      : txSql`
          UPDATE rule_chunks
          SET chunk_meta = chunk_meta - 'deprecated' - 'deprecated_by' - 'deprecated_reason'
          WHERE doc_type = 'ruling' AND chunk_meta ? 'deprecated'
          RETURNING id`);

    let flagged = 0;
    for (const d of list) {
      const rows = await txSql`
        UPDATE rule_chunks
        SET chunk_meta = chunk_meta || ${sql.json({
          deprecated: true,
          deprecated_by: d.article,
          deprecated_reason: d.reason,
        })}::jsonb
        WHERE doc_type = 'ruling' AND chunk_meta->>'qa_id' = ${String(d.qaId)}
        RETURNING id`;
      flagged += rows.length;
    }

    return { flagged, cleared: cleared.length };
  });
}

export async function runDeprecateRulings(): Promise<DeprecateResult> {
  const sql = getSql();
  const result = await applyDeprecations(sql);
  console.log(
    `=== 廃止裁定の反映: 一覧${DEPRECATED_RULINGS.length}件 → 印付け${result.flagged}行 / 印を剥がした${result.cleared}行 ===`,
  );
  await closeDb();
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDeprecateRulings()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
