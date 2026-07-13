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
  factCoverage: number | null;
  judgeMean: number | null;
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
   * judgeAnswer が全問失敗しても judgeMean は null になる。両者を区別しないと、
   * judge 障害のときに「合格」と表示され、ゲートが judge の退行に盲目になる。
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

  if (judgeExpected && agg.judgeMean === null) {
    failures.push("judge スコアが1件も取れていない (judge 障害の可能性)");
  }

  const checks: Array<[string, number | null, number]> = [
    ["judge 平均", agg.judgeMean, THRESHOLDS.minJudgeMean],
    ["ツール recall", agg.toolRecall, THRESHOLDS.minToolRecall],
    ["ツール precision", agg.toolPrecision, THRESHOLDS.minToolPrecision],
    ["事実カバレッジ", agg.factCoverage, THRESHOLDS.minFactCoverage],
  ];
  for (const [label, value, min] of checks) {
    if (value !== null && value < min) {
      failures.push(`${label} ${value.toFixed(3)} < ${min}`);
    }
  }

  return { passed: failures.length === 0, failures };
}
