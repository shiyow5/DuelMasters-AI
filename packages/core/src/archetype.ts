/**
 * デッキアーキタイプ名の正規化。
 *
 * 大会結果の取込は LLM がページから自由記述でアーキタイプ名を抜くため、同じデッキが
 * 「アナカラージャオウガ」「アナカラー ジャオウガ」「【アナカラージャオウガ】」のように割れる。
 * このまま `GROUP BY deck_archetype` するとティア集計が名前ゆれの数だけ分裂して壊れる。
 *
 * ここでは「照合用キー」と「表示用の正表記」を分ける:
 * - `archetypeKey` … 集計のグルーピングに使う。表記差を潰すが**別デッキは潰さない**
 * - `canonicalizeArchetypes` … 同一キー内で最頻の表記を選び、表示に使う
 *
 * 既知アーキタイプの辞書は持たない。新デッキが出るたびに辞書更新が要る運用は続かないし、
 * 未知の名前を辞書に寄せると別デッキを誤って統合する危険がある。
 */

/** 丸括弧で囲まれた補足 (「(オリジナル)」「(4c)」等) */
const PARENTHETICAL = /\([^)]*\)/g;
/** 名前の意味を持たない装飾記号と空白。中黒は区切りなので落とす (長音符 ー は残す) */
const DECORATION = /[\s【】《》「」『』[\]{}・,,]/g;

/**
 * 集計キーを作る。NFKC で半角カナ・全角英数を吸収し、装飾と空白を落として小文字化する。
 *
 * 「アナカラージャオウガ」と「アナカラー墓地退化」のような**別デッキは別キーのまま**にする
 * (曖昧一致で寄せると異なるデッキを統合してしまう)。
 */
export function archetypeKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(PARENTHETICAL, "")
    .replace(DECORATION, "")
    .toLowerCase()
    .trim();
}

/** 集計行 (deck_archetype と出現数) */
export interface ArchetypeCount {
  deck_archetype: string;
  count: number | string;
}

/**
 * 同一キーに属する表記のうち、代表表記を選ぶ。
 *
 * 優先順: 出現数が多い → 短い → 辞書順。
 * 短さを次点に置くのは、装飾つき (「【…】」「… (オリジナル)」) のほうが長くなるため。
 *
 * @returns archetypeKey → 代表表記
 */
export function canonicalizeArchetypes(rows: ArchetypeCount[]): Map<string, string> {
  const groups = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const key = archetypeKey(row.deck_archetype);
    if (key === "") continue;
    const surfaces = groups.get(key) ?? new Map<string, number>();
    surfaces.set(row.deck_archetype, (surfaces.get(row.deck_archetype) ?? 0) + Number(row.count));
    groups.set(key, surfaces);
  }

  const canonical = new Map<string, string>();
  for (const [key, surfaces] of groups) {
    const best = [...surfaces.entries()].sort(
      ([aName, aCount], [bName, bCount]) =>
        bCount - aCount || aName.length - bName.length || (aName < bName ? -1 : 1),
    )[0][0];
    canonical.set(key, best);
  }
  return canonical;
}

/**
 * 表記ゆれで割れた集計行を1行にまとめる。出現数の降順。
 *
 * 取込時ではなく**集計時**に寄せる。tournament_results にはソースの表記をそのまま残しておき、
 * 正規化の規則を後から変えても再取込せずに済むようにするため。
 */
export function mergeArchetypeCounts(
  rows: ArchetypeCount[],
): Array<{ deck_archetype: string; count: number }> {
  const canonical = canonicalizeArchetypes(rows);
  const merged = new Map<string, number>();

  for (const row of rows) {
    const key = archetypeKey(row.deck_archetype);
    if (key === "") continue;
    merged.set(key, (merged.get(key) ?? 0) + Number(row.count));
  }

  return [...merged.entries()]
    .map(([key, count]) => ({ deck_archetype: canonical.get(key) as string, count }))
    .sort((a, b) => b.count - a.count || (a.deck_archetype < b.deck_archetype ? -1 : 1));
}

/**
 * ここから下は「アーキタイプ名 → カード」の照合 (#122)。
 *
 * 環境分析のデッキに**メインカードの画像**を出したい。カードは 11563件すべて画像 URL を
 * 持っているので、アーキタイプ名からカードを特定できればよい。
 *
 * ## アーキタイプ名は「色 + カード名」の複合語
 *
 * 素朴な部分一致では当たらない (実測 8件中2件)。色の接頭辞を落とすと 8件中5件が当たる:
 *
 *   トリーヴァ|アルファディオス → 《聖霊王アルファディオス》
 *   赤単|我我我               → 《我我我ガイアール・ブランド》
 *   アナカラー|デイヤー        → 《MEGATOON・ドッカンデイヤー》
 *
 * 残りは**そもそも単一カード名ではない** (「ドッコイループ」= コンボ名、
 * 「メタビート革命チェンジ」= キーワード能力名) ので、原理的に対応付けられない。
 *
 * **当たらないときは何も出さない。** 無関係なカードの画像を出すくらいなら空欄のほうがよい。
 */

/**
 * デュエル・マスターズの色の呼び名 (アーキタイプ名の接頭辞になる)。
 *
 * **長いものから順に試すこと。** 「赤」を先に当てると「赤単我我我」が「単我我我」になる。
 */
const COLOR_PREFIXES = [
  // 3色以上の通称
  "アナカラー",
  "トリーヴァ",
  "クローシス",
  "ドロマー",
  "デイガ",
  "ラッカ",
  "ネクラ",
  "シータ",
  "5c",
  "4c",
  // 単色
  "赤単",
  "青単",
  "白単",
  "黒単",
  "緑単",
  "光単",
  "水単",
  "闇単",
  "火単",
  "自然単",
  // 2色
  "赤青",
  "赤白",
  "赤黒",
  "赤緑",
  "青黒",
  "青白",
  "青緑",
  "黒赤",
  "黒緑",
  "黒白",
  "白青",
  "白黒",
  "白赤",
  "白緑",
  "緑青",
  "緑黒",
  "光水",
  "光闇",
  "光火",
  "光自然",
  "水闇",
  "水火",
  "水自然",
  "闇火",
  "闇自然",
  "火自然",
];

/** 長い接頭辞から試すために一度だけ並べ替える。 */
const SORTED_PREFIXES = [...COLOR_PREFIXES].sort((a, b) => b.length - a.length);

/**
 * アーキタイプ名から、カード名に相当する部分を取り出す。
 *
 * 色の接頭辞を1つ落とす (「赤単我我我」→「我我我」)。落とすと空になるなら落とさない
 * (「赤単」だけのアーキタイプ名は、そのまま返す)。
 */
export function archetypeCoreName(archetype: string): string {
  const trimmed = archetype.normalize("NFKC").trim();
  for (const prefix of SORTED_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      const rest = trimmed.slice(prefix.length).trim();
      if (rest !== "") return rest;
    }
  }
  return trimmed;
}
