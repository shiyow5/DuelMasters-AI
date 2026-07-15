/**
 * 戦略語 → 構築制約のマッピング (#128 Stage 1)。
 *
 * 「速攻」「コントロール」等の**戦略語はカードテキストにほぼ出現しない**。literal ILIKE で
 * 探すと `themeCards` がほぼ 0件になり、以降はコスト昇順フィラーだけの「テーマ非依存の低コスト山」に
 * 退化する。そこで戦略語を検出したら (a) それを構造化制約 (max_cost / クリーチャー比 / トリガー下限)
 * へ翻訳し、(b) テーマ文字列から戦略語を**取り除いて**、残りの意味のある語 (種族・カード名) で検索する。
 */

export interface StrategyProfile {
  /** 最大コスト上限 (ユーザー指定が優先)。 */
  maxCost?: number;
  /** クリーチャーの最低比率 (ユーザーの minCreatures 指定が優先)。 */
  minCreatureRatio?: number;
  /** S・トリガーの下限。DECK_GUIDELINES.triggerCount より下げることはない。 */
  triggerFloor?: number;
  /** strategy 文言に出す短いラベル。 */
  label: string;
}

/**
 * **短すぎる/曖昧な語は入れない。** 「ビート」は種族《ビートジョッキー》に、「ランプ」は
 * 「トランプ」に部分一致して誤爆する。列挙するのは境界一致でも意味が一意に定まる語だけにする。
 */
const STRATEGY_PROFILES: Array<{ words: string[]; profile: StrategyProfile }> = [
  {
    // 速攻/アグロ: 低コスト・クリーチャー主体で押し切る。高コストを切り、クリーチャー比を上げる。
    words: ["速攻", "アグロ", "ビートダウン", "ラッシュ", "ウィニー"],
    profile: { maxCost: 5, minCreatureRatio: 0.65, label: "速攻 (低コスト・クリーチャー主体)" },
  },
  {
    // コントロール: 受けを厚くし高コストを許容する。クリーチャー比は下げ、トリガー下限を上げる。
    words: ["コントロール", "制圧"],
    profile: {
      minCreatureRatio: 0.4,
      triggerFloor: 10,
      label: "コントロール (受け厚め・高コスト許容)",
    },
  },
  {
    words: ["ミッドレンジ"],
    profile: { maxCost: 7, minCreatureRatio: 0.55, label: "ミッドレンジ" },
  },
  {
    words: ["マナ加速"],
    profile: { minCreatureRatio: 0.45, label: "ランプ (マナ加速)" },
  },
];

export interface DerivedStrategy {
  profile: StrategyProfile | null;
  /** 戦略語を取り除いたテーマ (種族・カード名などの実体)。空なら「戦略だけ」の指定。 */
  core: string;
}

/**
 * テーマ文字列から戦略プロファイルを抽出し、戦略語を取り除いたコア語を返す。
 *
 * 例: 「ボルシャック速攻」→ profile=速攻, core="ボルシャック" (「ボルシャック」で検索 + 速攻制約)。
 *     「コントロール」→ profile=コントロール, core="" (コア無し = 制約主導で構築)。
 *
 * **境界一致に限定する** (テーマ全体 / 接頭辞 / 接尾辞)。部分文字列一致だと「トランプ」が
 * 「ランプ」に、種族名の途中が戦略語に誤爆する。DM のテーマは「ボルシャック速攻」「5Cコントロール」の
 * ように**戦略語が接尾辞**で付くのが普通なので、これで実用上の表記はほぼ拾える。
 * 複数の戦略語があれば**最初に一致したものを主戦略**とする (語はすべて取り除く)。
 */
export function deriveStrategy(theme: string): DerivedStrategy {
  // 「〜デッキ」「〜型」の接尾辞は戦略語の後ろに付きがち。先に落として境界一致の精度を上げる。
  let core = theme
    .trim()
    .replace(/(デッキ|デック|型)$/, "")
    .trim();
  let profile: StrategyProfile | null = null;
  for (const { words, profile: p } of STRATEGY_PROFILES) {
    for (const w of words) {
      if (core === w) {
        profile = profile ?? p;
        core = "";
      } else if (core.endsWith(w)) {
        profile = profile ?? p;
        core = core.slice(0, -w.length).trim();
      } else if (core.startsWith(w)) {
        profile = profile ?? p;
        core = core.slice(w.length).trim();
      }
    }
  }
  return { profile, core: core.trim() };
}
