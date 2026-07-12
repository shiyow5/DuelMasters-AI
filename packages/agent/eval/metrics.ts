import type { Citation } from "../src/state.js";
import type { PR } from "./types.js";

/** 集合の precision/recall。expected が空なら「評価対象外」として recall=1 とする。 */
export function prScore(expected: string[], actual: string[]): PR {
  const exp = new Set(expected);
  const act = new Set(actual);
  let matched = 0;
  for (const e of exp) if (act.has(e)) matched += 1;
  return {
    matched,
    expected: exp.size,
    actual: act.size,
    // expected が空 = この観点は問わない → recall 1。actual が空 = precision 1 (誤検出なし)。
    recall: exp.size === 0 ? 1 : matched / exp.size,
    precision: act.size === 0 ? 1 : matched / act.size,
  };
}

/** ツール軌跡: 呼ばれるべきツールが実際に呼ばれたか。 */
export function toolTrajectory(expected: string[], actualToolNames: string[]): PR {
  return prScore(expected, actualToolNames);
}

/** 引用照合: citations から条番号 (article) を取り出して照合する。 */
export function citationScore(expected: string[], citations: Citation[]): PR {
  const actual = citations
    .map((c) =>
      typeof c.article === "string" || typeof c.article === "number" ? String(c.article) : "",
    )
    .filter(Boolean);
  return prScore(expected, actual);
}

/** 事実カバレッジ: 期待する要点が回答テキストに含まれる割合 (空白・大小無視の部分一致)。 */
export function factCoverage(expectedFacts: string[], responseText: string): number {
  if (expectedFacts.length === 0) return 1;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const hay = norm(responseText);
  let hit = 0;
  for (const f of expectedFacts) if (hay.includes(norm(f))) hit += 1;
  return hit / expectedFacts.length;
}

/** ItemResult 配列を集計する (存在する指標のみ平均する)。 */
export function aggregate(
  results: Array<{
    tool?: PR;
    citation?: PR;
    factCoverage?: number;
    judgeScore?: number;
    error?: string;
  }>,
): {
  n: number;
  errors: number;
  toolRecall: number | null;
  citationRecall: number | null;
  citationPrecision: number | null;
  factCoverage: number | null;
  judgeMean: number | null;
} {
  const ok = results.filter((r) => !r.error);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    n: results.length,
    errors: results.length - ok.length,
    toolRecall: mean(ok.filter((r) => r.tool).map((r) => r.tool!.recall)),
    citationRecall: mean(ok.filter((r) => r.citation).map((r) => r.citation!.recall)),
    citationPrecision: mean(ok.filter((r) => r.citation).map((r) => r.citation!.precision)),
    factCoverage: mean(ok.filter((r) => r.factCoverage !== undefined).map((r) => r.factCoverage!)),
    judgeMean: mean(ok.filter((r) => r.judgeScore !== undefined).map((r) => r.judgeScore!)),
  };
}
