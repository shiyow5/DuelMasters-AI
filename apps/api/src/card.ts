import { getSql } from "@dm-ai/db";

/**
 * カード名 → 画像URL (#129)。
 *
 * デッキの各カードの画像をグリッド表示するために、名前から `card_image_url` を引く。
 * カードは全件 `card_image_url` を持つ。
 *
 * ## 照合は「正規化した完全一致」
 *
 * `resolveMainCards` (#122) は「アーキタイプ名 → 代表カード」を**部分一致**で当てるが、
 * こちらは**デッキが実際に持つカード名**を引くので、別カードへ誤爆させない完全一致にする。
 * ただし次のゆれは吸収する:
 * - 中黒 (・)・全角/半角スペース・囲み記号 (#111 でカード検索が中黒で全滅したのと同じ translate 集合)
 * - **全角/半角の英数** (NFKC 幅畳み)。《接続 CS-20》のように英数コードを含むカード名があり、
 *   ユーザーが全角「ＣＳ－２０」で貼っても引けるようにする
 *   (agent の `normalizeCardName` が NFKC を使うのと同じ意図)。
 *   両側に同じ SQL 式 (`normalize(..., NFKC)`) をかけるので照合は対称のまま。
 *
 * ## 引けない名前は null
 *
 * 一致するカードが無い / 画像が無いときは **null** を返す。壊れた画像や無関係な画像を
 * 出すくらいなら、UI 側でカード名テキストにフォールバックさせる。
 * **入力のすべての名前**について1エントリを返す (見つからなくても応答に残す)。
 */

/** 照合時に落とす記号 (main-card.ts と同じ集合。ドリフトさせない)。 */
const NAME_NORMALIZE_CHARS = "・･ 　《》「」『』【】";

export async function resolveCardImages(names: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const unique = [...new Set(names)];
  if (unique.length === 0) return out;
  // 見つからなかった名前も応答に含めるため、まず全名前を null で埋める。
  for (const name of unique) out.set(name, null);

  try {
    const sql = getSql();
    const rows = await sql`
      WITH input AS (
        SELECT DISTINCT elem AS name
        FROM jsonb_array_elements_text(${sql.json(unique)}::jsonb) AS elem
      )
      SELECT DISTINCT ON (i.name) i.name AS input_name, c.card_image_url
      FROM input i
      JOIN cards c
        -- normalize(..., NFKC) で全角/半角 (英数含む) を畳んでから、記号を落として小文字化。
        -- 両側に同じ式をかけるので照合は対称 (DB 列が全角でも入力が全角でも一致する)。
        ON lower(translate(normalize(c.name, NFKC), ${NAME_NORMALIZE_CHARS}, ''))
         = lower(translate(normalize(i.name, NFKC), ${NAME_NORMALIZE_CHARS}, ''))
       AND c.card_image_url IS NOT NULL
      -- 同名正規化が複数当たったら短い名前 (素の名前に近い方) を採る。
      ORDER BY i.name, length(c.name), c.name
    `;
    for (const row of rows) {
      out.set(row.input_name as string, row.card_image_url as string);
    }
  } catch (err) {
    // DB 未接続でも落とさない。全 null で返し、UI はカード名テキストにフォールバックする。
    console.warn(
      "カード画像の解決に失敗したため、画像なしで返します:",
      err instanceof Error ? err.message : err,
    );
  }
  return out;
}
