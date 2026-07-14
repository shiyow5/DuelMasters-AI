/**
 * eval の回帰ゲート。CI (eval.yml) はここを割ったら失敗させる。
 *
 * 閾値は v8 ベースライン (judge 4.94 / toolRecall 0.97 / prec 1.00 / factCov 0.84 / errors 0)
 * から余裕を取って置く。agent は temperature 0.3 で走るため judge は run 毎に揺れる。
 * 揺れで落ちるとゲートが信用されなくなるので、退行を捕まえつつ日常のブレは通す水準にする。
 */
export interface Aggregate {
  n: number;
  errors: number;
  toolRecall: number | null;
  toolPrecision: number | null;
  citationRecall: number | null;
  citationPrecision: number | null;
  /** 本文の条番号が資料にあった割合 (#99)。条番号を引かない問は計測対象外 (null)。 */
  citationGrounding: number | null;
  factCoverage: number | null;
  /** 根拠 (引用 or ツール結果) が付いた割合 (#108)。根拠が要る問だけが分母。 */
  evidenceRate: number | null;
  /** ツールが失敗した問の件数 (#109)。 */
  toolFailureItems?: number;
  judgeMean: number | null;
  /** judge を回したのに失敗した件数 (quota/スキーマ/キー不正)。 */
  judgeFailures?: number;
}

export const THRESHOLDS = {
  /**
   * エラーは1件も許さない。Gemini がツール定義を拒否した事故 (exclusiveMinimum で 400) は
   * CI では検出できず、eval を回して初めて全35問 ERR で発覚した。ここが唯一の番人になる。
   */
  maxErrors: 0,
  /** judge 平均 (1-5)。v8 は 4.94。 */
  minJudgeMean: 4.3,
  /** 期待したツールを呼べているか。v8 は 0.97。 */
  minToolRecall: 0.85,
  /** 余計なツールを呼んでいないか。v8 は 1.00。 */
  minToolPrecision: 0.85,
  /** 期待した事実に触れているか。v8 は 0.84。 */
  minFactCoverage: 0.7,
  /**
   * 回答本文に書いた条番号が、実際に retrieve した資料にあった割合 (#99)。
   *
   * **LLM は実在しない条番号を平然と書く。** eval で agent が【総合ルール 114.6】
   * 【総合ルール 114.6a】をでっち上げたのを確認した (114章は 114.4 までしか無い)。
   * agent 側の sanitizeCitations が本文からは落とすので利用者の目には触れないが、
   * **捏造が増えたこと自体を退行として検出する**ためにゲートを置く。
   *
   * ベースライン: rule モード23問で **0.95** (捏造は rule-deckout の1問のみ)。
   * 揺れで落ちないよう 0.8 に置く。nightly (全35問) のベースラインが取れたら締め直す。
   */
  minCitationGrounding: 0.8,
  /**
   * 根拠 (引用 or ツール結果) が付いた割合 (#108)。
   *
   * 本番実測で integrated のルール質問8問中1問 (12.5%) がツール未使用・引用0件で、
   * LLM の記憶だけで答えていた。web の既定モードが integrated なので利用者が普通に踏む。
   * retrieve を integrated にも通してこれを潰した。
   *
   * ツール呼び出しでは測れないことに注意 (事前 RAG が効くとモデルは search_rules を
   * 呼ばずに答える。それは正しい)。**引用かツールのどちらかがあること**を見ている。
   *
   * **ベースライン 0.97 (37/38)。** 落ちている1問は `deck-dendou`:
   * デッキリストが `4 (殿堂入りカード)` というプレースホルダで実カード名が無いため、
   * モデルは evaluate_deck を呼ばず「殿堂入りは1枚までなので違反」と記憶から断言して拒否する
   * (judge は 5 を付ける)。**主張自体は根拠ゼロ**なので指標は正しく捉えている。golden 側の
   * 欠陥なので別途直す。それまでこの1件を許容して 0.95 に置く
   * (本番で観測した 12.5% の退行 = 0.875 はこれで捕まる)。
   */
  minEvidenceRate: 0.95,
  /**
   * ツールが失敗した問の件数 (#109)。**1件も許さない。**
   *
   * ツールが失敗しても回答は返る (モデルが記憶で埋める) ため、judge も factCoverage も
   * 高いままになりうる。**#112 では本番で全ツールが CONNECTION_ENDED で死んでいたのに、
   * eval は judge 4.94 を出し続けていた。** 失敗そのものを数えないと検出できない。
   *
   * eval は実 DB・実 Gemini を叩くので、ここが 0 でないなら環境かコードが壊れている。
   */
  maxToolFailureItems: 0,
} as const;

export interface GateResult {
  passed: boolean;
  failures: string[];
}

export interface GateOptions {
  /**
   * judge を回した前提か (既定 true = 安全側)。
   *
   * `--no-judge` の高速実行では judgeMean が null になるが、それは意図した省略なので
   * 評価しない。一方、judge を回したのに quota 切れ・スキーマエラー・キー不正で
   * judgeAnswer が失敗しても judgeMean は残りの成功分から計算されてしまう。
   * 両者を区別しないと、judge が半分落ちていても「合格」と表示され、ゲートが盲目になる。
   */
  judgeExpected?: boolean;
}

/**
 * 閾値判定。計測していない指標 (null) は評価しない — ただし judge だけは
 * 「回すつもりだったのに取れなかった」を失敗として扱う (上記 GateOptions 参照)。
 */
export function checkThresholds(agg: Aggregate, options: GateOptions = {}): GateResult {
  const { judgeExpected = true } = options;
  const failures: string[] = [];

  if (agg.errors > THRESHOLDS.maxErrors) {
    failures.push(`エラー ${agg.errors}件 (上限 ${THRESHOLDS.maxErrors})`);
  }

  // ツールの失敗は回答に現れない (モデルが記憶で埋める)。ここでしか捕まえられない (#109)。
  const toolFailureItems = agg.toolFailureItems ?? 0;
  if (toolFailureItems > THRESHOLDS.maxToolFailureItems) {
    failures.push(
      `ツールが失敗した問 ${toolFailureItems}件 (上限 ${THRESHOLDS.maxToolFailureItems})`,
    );
  }

  if (judgeExpected) {
    if (agg.judgeMean === null) {
      failures.push("judge スコアが1件も取れていない (judge 障害の可能性)");
    }
    // 一部だけ成功した場合、judgeMean はその少数から計算されてしまう。
    // 採点できなかった問を無視した平均でゲートを通してはいけない。
    const judgeFailures = agg.judgeFailures ?? 0;
    if (judgeFailures > 0) {
      failures.push(`judge が ${judgeFailures}件で失敗 (採点できなかった問がある)`);
    }
  }

  const checks: Array<[string, number | null, number]> = [
    ["judge 平均", agg.judgeMean, THRESHOLDS.minJudgeMean],
    ["ツール recall", agg.toolRecall, THRESHOLDS.minToolRecall],
    ["ツール precision", agg.toolPrecision, THRESHOLDS.minToolPrecision],
    ["事実カバレッジ", agg.factCoverage, THRESHOLDS.minFactCoverage],
    ["出典の裏取り", agg.citationGrounding, THRESHOLDS.minCitationGrounding],
    ["根拠あり率", agg.evidenceRate, THRESHOLDS.minEvidenceRate],
  ];
  for (const [label, value, min] of checks) {
    if (value !== null && value < min) {
      failures.push(`${label} ${value.toFixed(3)} < ${min}`);
    }
  }

  return { passed: failures.length === 0, failures };
}
