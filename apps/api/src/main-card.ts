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
 * ## 解決の順序 (#131)
 *
 * 1. **種族ベースのアーキタイプ** (「デスパペット」) → その種族の代表カード。
 * 2. **カード名ベース** (「モルト系」→「モルト」) → 名前の先頭/末尾に一致するカード。
 *
 * アーキタイプ名には色の接頭辞 (「5C」) とデッキ名の飾り (「〜系」「〜ループ」) が付くので、
 * `archetypeCoreName` で落としてから照合する。落とさないと `%モルト系%` のように
 * **カード名には絶対に存在しない文字列**で引いてしまい、0件になる (本番で実際に起きていた)。
 *
 * ## それでも当たらないなら何も出さない
 *
 * 「メタビート革命チェンジ」(デッキ用語 + キーワード能力名) や「ダーバンデ」(該当カード0件) は
 * **そもそも単一カード名ではない / 実在しない**ので、原理的に対応付けられない。
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

  /** コア名で引けた1枚を、そのコアを持つ全アーキタイプに割り当てる。 */
  function assign(core: string, name: string, imageUrl: string): void {
    for (const archetype of byCore.get(core) ?? [])
      out.set(archetype, { name, image_url: imageUrl });
  }

  /**
   * 1. **種族ベースのアーキタイプ → その種族の代表カード** (#131)。
   *
   * 以前は種族名のコアを弾いて空欄にしていた (「代表カードを1枚選ぶ根拠が無い」)。だが本番の
   * 主要ティアで「デスパペット」等が空欄のままになり、実害が出た。**その種族のカードは
   * 「無関係なカード」ではない**ので、#122 の「無関係カードより空欄」の原則には反しない。
   *
   * 種族の「顔」として**最も重いカード** (フィニッシャー) を採る。同コストなら短い名前・
   * 名前順でタイブレークして決定的にする。
   */
  const raceRows = await sql`
    WITH core_names AS (
      SELECT core FROM jsonb_array_elements_text(${sql.json(cores)}::jsonb) AS core
    )
    SELECT DISTINCT ON (n.core) n.core, c.name, c.card_image_url
    FROM core_names n
    JOIN cards c
      ON c.card_image_url IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(c.races) r
       WHERE lower(translate(r, '・･ 　', '')) = lower(translate(n.core, '・･ 　', ''))
     )
    ORDER BY n.core, c.cost DESC NULLS LAST, length(c.name), c.name
  `;
  const resolvedByRace = new Set<string>();
  for (const row of raceRows) {
    const core = row.core as string;
    assign(core, row.name as string, row.card_image_url as string);
    resolvedByRace.add(core);
  }

  // 2. 種族で解決できなかったコアだけ、カード名で照合する。
  const nameCores = cores.filter((c) => !resolvedByRace.has(c));
  if (nameCores.length === 0) return out;

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
   * 2. **種族名は弾く** (`cards.races`)。種族ベースのアーキタイプは上の「種族の代表カード」
   *    パスで解決済み。ここまで残っているのは**画像付きのカードが1枚も無い種族**なので、
   *    名前だけ似た無関係カード (《ドラゴン・ラボ》) を当てるくらいなら空欄のままにする。
   *
   * 配列は **jsonb で渡す**。`sql.array()` は型推論が prepared statement のキャッシュ状態に
   * 依存し、1回目だけ `malformed array literal` で落ちることがある。
   */
  const rows = await sql`
    WITH core_names AS (
      SELECT core FROM jsonb_array_elements_text(${sql.json(nameCores)}::jsonb) AS core
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
    assign(row.core as string, row.name as string, row.card_image_url as string);
  }
  return out;
}
