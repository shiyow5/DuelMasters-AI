import { archetypeCoreName } from "@dm-ai/core";
import { getSql } from "@dm-ai/db";

/**
 * アーキタイプ名 → メインカードの画像 (#122)。
 *
 * 環境分析のデッキカードに、そのデッキを象徴するカードの画像を出す。
 * カードは 11563件すべて `card_image_url` を持っている。
 *
 * ## **読み取り時**に解決する
 *
 * スナップショット (`meta_snapshots.tier_data`) に焼き込まない。カード画像は「表示の都合」で
 * あって集計結果ではないし、照合の規則を改善したときに**再スナップショットを待たずに効く**
 * ようにしたい。1リクエストにつき1クエリ増えるだけ。
 *
 * ## 当たらないなら何も出さない
 *
 * 「ドッコイループ」(コンボ名) や「メタビート革命チェンジ」(キーワード能力名) は
 * **そもそも単一カード名ではない**ので、原理的に対応付けられない。
 * **無関係なカードの画像を出すくらいなら空欄のほうがよい。**
 */

export interface MainCard {
  name: string;
  image_url: string;
}

/**
 * デッキの**戦略**を表す語。カード名ではないので、これがコア名になったら諦める。
 *
 * 実データで踏んだ誤検出:
 *   5Cコントロール → 《消火機装コントロール・ファイア》
 *
 * 種族名 (「ドラゴン」「スノーフェアリー」) は `cards.races` から動的に弾けるが、
 * 戦略名は DB に無いので列挙するしかない。**辞書は最小限に留める** — 増やすほど
 * 「知らない語だから出さない」判断が増え、正当な一致まで落ちる。
 */
const STRATEGY_WORDS = [
  "コントロール",
  "ビート",
  "ビートダウン",
  "メタビート",
  "ループ",
  "ランプ",
  "アグロ",
  "ミッドレンジ",
  "ワンショット",
  "ハンデス",
  "バーン",
  "デッキ",
];

/**
 * アーキタイプ名の配列に対して、メインカードをまとめて引く。
 *
 * 照合は「色の接頭辞を落としたコア名がカード名に含まれるか」。DB 側もカード名を正規化して
 * 比較する (中黒・空白・囲み記号を落として小文字化)。#111 で本番のカード検索が中黒で
 * 全滅したのと同じ手当て。
 *
 * 同名候補が複数あるときは**名前が短いもの**を採る。「アルファディオス」に対して
 * 《聖霊王アルファディオス》と《王導聖霊 アルファディオス》があるとき、素の名前に近い方が
 * そのアーキタイプの象徴である可能性が高い。
 */
export async function resolveMainCards(archetypes: string[]): Promise<Map<string, MainCard>> {
  const out = new Map<string, MainCard>();
  if (archetypes.length === 0) return out;

  // コア名 → そのコア名を持つアーキタイプ名 (複数ありうる)
  const byCore = new Map<string, string[]>();
  for (const a of archetypes) {
    const core = archetypeCoreName(a);
    // 1文字のコア名は誤爆する (どのカード名にも含まれる)。捨てる。
    if (core.length < 2) continue;
    const list = byCore.get(core) ?? [];
    list.push(a);
    byCore.set(core, list);
  }
  if (byCore.size === 0) return out;

  const sql = getSql();
  const cores = [...byCore.keys()];

  /**
   * コア名ごとに、最も短いカード名を1件だけ引く (DISTINCT ON)。
   *
   * ## **部分一致では緩すぎる**
   *
   * 素朴な `LIKE '%コア名%'` だと、実データでこうなった:
   *
   *   5Cコントロール → 《消火機装コントロール・ファイア》   ← 「コントロール」は戦略名
   *   5Cドラゴン    → 《ドラゴン・ラボ》                  ← 「ドラゴン」は種族名
   *
   * **無関係なカード画像を出すのは、何も出さないより悪い。** 2つの条件で絞る:
   *
   * 1. **カード名の先頭か末尾に一致すること** (途中に埋まっているだけでは採らない)。
   *    《我我我ガイアール・ブランド》は「我我我」で始まり、《聖霊王アルファディオス》は
   *    「アルファディオス」で終わる。一方《消火機装コントロール・ファイア》の
   *    「コントロール」は真ん中にあるので落ちる。
   * 2. **種族名は弾く** (`cards.races`)。「ドラゴン」「スノーフェアリー」「グランセクト」は
   *    種族ベースのアーキタイプで、**代表カードを1枚選ぶ根拠が無い**。
   *
   * 配列は **jsonb で渡す**。`sql.array()` は型推論が prepared statement のキャッシュ状態に
   * 依存し、1回目だけ `malformed array literal` で落ちることがある。
   */
  const rows = await sql`
    WITH core_names AS (
      SELECT core FROM jsonb_array_elements_text(${sql.json(cores)}::jsonb) AS core
    ),
    -- 種族名と一致するコア名は、代表カードを選べないので捨てる
    races AS (
      SELECT DISTINCT lower(translate(r, '・･ 　', '')) AS race
      FROM cards, jsonb_array_elements_text(races) r
    )
    SELECT DISTINCT ON (n.core) n.core, c.name, c.card_image_url
    FROM core_names n
    JOIN cards c
      ON c.card_image_url IS NOT NULL
     AND lower(translate(c.name, '・･ 　《》「」『』【】', ''))
         LIKE '%' || lower(translate(n.core, '・･ 　《》「」『』【】', '')) || '%'
    WHERE lower(translate(n.core, '・･ 　', '')) NOT IN (SELECT race FROM races)
      AND lower(translate(n.core, '・･ 　', '')) NOT IN (
        SELECT jsonb_array_elements_text(${sql.json(STRATEGY_WORDS)}::jsonb)
      )
    -- 先頭/末尾に一致するものを優先し、次に短い名前 (素の名前に近い方)。
    ORDER BY n.core,
      CASE
        WHEN lower(translate(c.name, '・･ 　《》「」『』【】', ''))
             LIKE lower(translate(n.core, '・･ 　《》「」『』【】', '')) || '%' THEN 0
        WHEN lower(translate(c.name, '・･ 　《》「」『』【】', ''))
             LIKE '%' || lower(translate(n.core, '・･ 　《》「」『』【】', '')) THEN 1
        ELSE 2
      END,
      length(c.name), c.name
  `;

  for (const row of rows) {
    const core = row.core as string;
    const card: MainCard = {
      name: row.name as string,
      image_url: row.card_image_url as string,
    };
    for (const archetype of byCore.get(core) ?? []) out.set(archetype, card);
  }
  return out;
}
