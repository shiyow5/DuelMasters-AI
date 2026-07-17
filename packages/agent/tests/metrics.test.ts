import { describe, it, expect } from "vitest";
import {
  prScore,
  toolTrajectory,
  citationScore,
  factCoverage,
  deckQuality,
  aggregate,
} from "../eval/metrics.js";
import { checkThresholds } from "../eval/thresholds.js";
import type { DeckQualityStats } from "../eval/types.js";

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

  it("構築デッキ品質の合格/不合格を数える (#140)", () => {
    const agg = aggregate([
      { deckQuality: { passed: true, failures: [] } },
      { deckQuality: { passed: false, failures: ["fire 文明の占有率 0.20 < 0.5"] } },
      {}, // expectedDeck なし = 計測対象外
      { error: "boom", deckQuality: { passed: false, failures: ["x"] } }, // error は除外
    ]);
    expect(agg.deckQualityItems).toBe(2); // 計測できたのは 2 件 (error 分は除外)
    expect(agg.deckQualityFailItems).toBe(1);
  });
});

describe("deckQuality (#140 構築デッキの数値品質)", () => {
  const stats = (o: Partial<DeckQualityStats> = {}): DeckQualityStats => ({
    archetype: "aggro",
    triggerCount: 8,
    lowCost: 20,
    overall: 90,
    civShares: { fire: 1 },
    totalCards: 40,
    ...o,
  });

  it("すべての基準を満たせば passed", () => {
    const r = deckQuality(
      { civilization: "fire", minCivShare: 0.5, archetype: "aggro", minOverall: 70 },
      stats(),
    );
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("アーキタイプが一致しなければ不合格", () => {
    const r = deckQuality({ archetype: "control" }, stats({ archetype: "aggro" }));
    expect(r.passed).toBe(false);
    expect(r.failures.join()).toContain("アーキタイプ");
  });

  it("中心文明の占有率が閾値未満なら不合格", () => {
    const r = deckQuality(
      { civilization: "fire", minCivShare: 0.5 },
      stats({ civShares: { fire: 0.3, water: 0.7 } }),
    );
    expect(r.passed).toBe(false);
    expect(r.failures.join()).toContain("fire");
  });

  it("minCivShare 未指定なら既定 0.5 を使う", () => {
    expect(deckQuality({ civilization: "fire" }, stats({ civShares: { fire: 0.49 } })).passed).toBe(
      false,
    );
    expect(deckQuality({ civilization: "fire" }, stats({ civShares: { fire: 0.51 } })).passed).toBe(
      true,
    );
  });

  it("指定した文明が1枚も無ければ占有率0で不合格", () => {
    const r = deckQuality({ civilization: "fire" }, stats({ civShares: { water: 1 } }));
    expect(r.passed).toBe(false);
  });

  it("トリガー/低コスト/総合スコアの下限を検査する", () => {
    expect(deckQuality({ minTrigger: 6 }, stats({ triggerCount: 5 })).passed).toBe(false);
    expect(deckQuality({ minLowCost: 15 }, stats({ lowCost: 10 })).passed).toBe(false);
    expect(deckQuality({ minOverall: 80 }, stats({ overall: 70 })).passed).toBe(false);
  });

  it("指定していない観点は検査しない (空 spec でも 40枚なら合格)", () => {
    expect(deckQuality({}, stats()).passed).toBe(true);
  });

  it("40枚に満たない不完全なデッキは spec によらず不合格 (#140 Codex 指摘)", () => {
    // カードプール不足で autoBuild が 20枚しか組めなくても、scoreDeck は -20 しか課さないので
    // 他の基準を通り抜けうる。枚数は spec と無関係に必ず検査する。
    const r = deckQuality({}, stats({ totalCards: 20 }));
    expect(r.passed).toBe(false);
    expect(r.failures.join()).toContain("20枚");
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

  it("構築デッキが品質基準を外した問が1件でもあれば落とす (#140)", () => {
    // judge は言葉で「火文明中心」と言えば通すが、実際に組まれたデッキが混色/重いなら
    // ここでしか捕まえられない。expectedDeck を持つ問の機械的ゲート。
    const r = checkThresholds({ ...OK, deckQualityFailItems: 1 });
    expect(r.passed).toBe(false);
    expect(r.failures.join()).toContain("構築デッキ");
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
