import { describe, it, expect } from "vitest";
import {
  prScore,
  toolTrajectory,
  citationScore,
  factCoverage,
  aggregate,
} from "../eval/metrics.js";
import { checkThresholds } from "../eval/thresholds.js";

describe("prScore", () => {
  it("完全一致で precision=recall=1", () => {
    const r = prScore(["a", "b"], ["a", "b"]);
    expect(r).toMatchObject({ matched: 2, recall: 1, precision: 1 });
  });
  it("一部一致", () => {
    const r = prScore(["a", "b"], ["a", "c"]);
    expect(r.recall).toBe(0.5); // 2 中 1
    expect(r.precision).toBe(0.5); // 2 中 1
  });
  it("expected 空は recall=1 (問わない)", () => {
    expect(prScore([], ["a"]).recall).toBe(1);
  });
  it("actual 空は precision=1 (誤検出なし)", () => {
    expect(prScore(["a"], []).precision).toBe(1);
    expect(prScore(["a"], []).recall).toBe(0);
  });
});

describe("toolTrajectory", () => {
  it("期待ツールが呼ばれていれば recall=1", () => {
    expect(toolTrajectory(["search_rules"], ["search_rules", "search_cards"]).recall).toBe(1);
  });
  it("期待ツール未呼び出しは recall=0", () => {
    expect(toolTrajectory(["evaluate_deck"], ["search_cards"]).recall).toBe(0);
  });
});

describe("citationScore", () => {
  it("citations の article を照合する", () => {
    const cites = [
      { article: "1234.5", text: "x" },
      { article: "9999", text: "y" },
    ];
    const r = citationScore(["1234.5"], cites);
    expect(r.recall).toBe(1);
    expect(r.matched).toBe(1);
  });
  it("数値 article も文字列化して照合", () => {
    expect(citationScore(["100"], [{ article: 100 }]).recall).toBe(1);
  });
  it("article 無し citation は無視", () => {
    expect(citationScore(["1"], [{ text: "no article" }]).recall).toBe(0);
  });
});

describe("factCoverage", () => {
  it("要点が含まれる割合 (空白・大小無視)", () => {
    expect(factCoverage(["S トリガー", "ブロック"], "Sトリガーはブロックされない")).toBe(1);
    expect(factCoverage(["A", "B"], "Aだけ")).toBe(0.5);
  });
  it("expected 空は 1", () => {
    expect(factCoverage([], "何でも")).toBe(1);
  });
});

describe("aggregate", () => {
  it("存在する指標のみ平均、error は除外", () => {
    const agg = aggregate([
      { tool: prScore(["a"], ["a"]), citation: prScore(["x"], ["x"]), judgeScore: 4 },
      { tool: prScore(["a"], []), judgeScore: 2 },
      { error: "boom" },
    ]);
    expect(agg.n).toBe(3);
    expect(agg.errors).toBe(1);
    expect(agg.toolRecall).toBe(0.5); // (1 + 0) / 2
    expect(agg.toolPrecision).toBe(1); // (1 + 1) / 2 (actual空は precision 1)
    expect(agg.citationRecall).toBe(1); // 1 件のみ
    expect(agg.judgeMean).toBe(3); // (4 + 2) / 2
    expect(agg.factCoverage).toBeNull(); // 該当なし
  });
});

describe("checkThresholds (CI 回帰ゲート)", () => {
  const OK = {
    n: 35,
    errors: 0,
    toolRecall: 0.97,
    toolPrecision: 1.0,
    citationRecall: null,
    citationPrecision: null,
    citationGrounding: 0.95,
    factCoverage: 0.84,
    judgeMean: 4.94,
    judgeFailures: 0,
  };

  it("v8 のベースライン相当なら通る", () => {
    expect(checkThresholds(OK).failures).toEqual([]);
    expect(checkThresholds(OK).passed).toBe(true);
  });

  it("エラーが1件でもあれば落とす", () => {
    // Gemini がツール定義を拒否した事故 (exclusiveMinimum) は全問 ERR になった。
    // CI ではツール定義の受理を検証できないため、eval のエラー件数がその番人になる。
    const r = checkThresholds({ ...OK, errors: 1 });
    expect(r.passed).toBe(false);
    expect(r.failures.join()).toContain("エラー");
  });

  it("judge 平均が閾値を下回れば落とす", () => {
    const r = checkThresholds({ ...OK, judgeMean: 4.0 });
    expect(r.passed).toBe(false);
    expect(r.failures.join()).toContain("judge");
  });

  it("toolRecall が閾値を下回れば落とす", () => {
    const r = checkThresholds({ ...OK, toolRecall: 0.5 });
    expect(r.passed).toBe(false);
    expect(r.failures.join()).toContain("ツール recall");
  });

  it("出典の裏取りが閾値を下回れば落とす (条番号の捏造が増えた) (#99)", () => {
    // agent 側の sanitizeCitations が本文からは落とすので利用者の目には触れないが、
    // **捏造が増えたこと自体**を退行として検出する。
    const r = checkThresholds({ ...OK, citationGrounding: 0.5 });
    expect(r.passed).toBe(false);
    expect(r.failures.join()).toContain("出典の裏取り");
  });

  it("条番号を1つも引かない run では出典ゲートを評価しない", () => {
    // deck/meta だけの golden なら条文を引かないのが正常。null を 0 とみなして
    // 落とすと、ゲートが誤爆して信用されなくなる。
    const r = checkThresholds({ ...OK, citationGrounding: null });
    expect(r.passed).toBe(true);
  });

  it("--no-judge なら judge 指標を評価しない", () => {
    // 高速実行でもゲートを通せるようにする (judge 以外は評価する)。
    expect(checkThresholds({ ...OK, judgeMean: null }, { judgeExpected: false }).passed).toBe(true);
  });

  it("judge を回すつもりだったのにスコアが1つも無ければ落とす", () => {
    // quota 切れ・スキーマエラー・キー不正で judgeAnswer が全問失敗すると judgeMean が null に
    // なる。null をスキップすると「合格」と表示され、judge 障害にゲートが盲目になる。
    const r = checkThresholds({ ...OK, judgeMean: null }, { judgeExpected: true });
    expect(r.passed).toBe(false);
    expect(r.failures.join()).toContain("judge");
  });

  it("既定は judge を回した前提 (安全側)", () => {
    expect(checkThresholds({ ...OK, judgeMean: null }).passed).toBe(false);
  });

  it("judge が一部だけ失敗しても落とす (成功分の平均で通してはいけない)", () => {
    // aggregate は1問でも judgeScore があれば非 null の平均を返す。quota 切れが途中で起きると
    // 採点できた少数の問だけで「合格」と表示され、残りの退行が見えなくなる。
    const r = checkThresholds({ ...OK, judgeMean: 4.9, judgeFailures: 12 });
    expect(r.passed).toBe(false);
    expect(r.failures.join()).toContain("12件で失敗");
  });

  it("--no-judge なら judge 失敗も評価しない", () => {
    expect(
      checkThresholds({ ...OK, judgeMean: null, judgeFailures: 35 }, { judgeExpected: false })
        .passed,
    ).toBe(true);
  });
});
