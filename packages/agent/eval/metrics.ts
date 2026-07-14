import type { Citation } from "../src/state.js";
// 抽出は src/citations.ts に一本化する。ここに正規表現を再実装するとズレて指標が盲目になる。
import { citedArticles } from "../src/citations.js";

export { citedArticles };
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

/**
 * **本文に書いた条番号が、実際に retrieve した資料に含まれるか** (#99 の要)。
 *
 * LLM は実在しない条番号を平然と書く。#92 の裁定監査では 701.29a / 116.3a / 109.2c を
 * 捏造した。回答本文でも同じことが起きるので、「渡された資料にある条文だけを引く」という
 * 規律が守られているかを機械的に測る。
 *
 * 枝番 (501.2a) は親条文チャンク (501.2) の本文に埋まっており、citations には親の条番号しか
 * 載らない。枝番を捏造扱いすると**正しい引用まで落ちる** (#92 で実際にこの誤判定をやった)ので、
 * 親を retrieve していれば認める。
 *
 * @returns 0–1。条番号を1つも引いていなければ **null** (計測対象外)。
 *   「引用が無い」と「引用が全部でっちあげ」は違う。デッキ相談は条文を引かないのが正常なので、
 *   0 として平均に混ぜるとゲートが壊れる。
 */
export function citationGrounding(responseText: string, ungrounded: string[] = []): number | null {
  // 本文は **既にサニタイズ済み** (agent の toOutput が捏造番号を落としている) なので、
  // 本文だけ見ると常に 1.0 になり指標が死ぬ。落とした番号を足し戻して率を出す。
  const grounded = citedArticles(responseText).length;
  const total = grounded + ungrounded.length;
  if (total === 0) return null;
  return grounded / total;
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
    citationGrounding?: number | null;
    factCoverage?: number;
    hasEvidence?: boolean;
    judgeScore?: number;
    judgeFailed?: boolean;
    error?: string;
  }>,
): {
  n: number;
  errors: number;
  toolRecall: number | null;
  toolPrecision: number | null;
  citationRecall: number | null;
  citationPrecision: number | null;
  /**
   * 本文に書いた条番号が、実際に retrieve した資料にあった割合 (#99)。
   * 条番号を1つも引いていない問 (デッキ相談など) は平均に混ぜない。
   */
  citationGrounding: number | null;
  factCoverage: number | null;
  /**
   * 根拠 (引用 or ツール結果) が付いた割合 (#108)。expectEvidence の問だけが対象。
   * これが 1 未満 = 記憶だけで答えた問がある。
   */
  evidenceRate: number | null;
  judgeMean: number | null;
  /** judge を回したのに失敗した件数。部分的な judge 障害を検出する。 */
  judgeFailures: number;
} {
  const ok = results.filter((r) => !r.error);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    n: results.length,
    errors: results.length - ok.length,
    toolRecall: mean(ok.filter((r) => r.tool).map((r) => r.tool!.recall)),
    // toolPrecision: 無関係ツールを乱発する退化戦略を検出する (期待ツールに含まれない呼び出しを罰する)
    toolPrecision: mean(ok.filter((r) => r.tool).map((r) => r.tool!.precision)),
    citationRecall: mean(ok.filter((r) => r.citation).map((r) => r.citation!.recall)),
    citationPrecision: mean(ok.filter((r) => r.citation).map((r) => r.citation!.precision)),
    // null = 条番号を引いていない問。0 として混ぜると「引用しない = 悪い」になってしまう。
    citationGrounding: mean(
      ok.map((r) => r.citationGrounding).filter((v): v is number => v !== undefined && v !== null),
    ),
    factCoverage: mean(ok.filter((r) => r.factCoverage !== undefined).map((r) => r.factCoverage!)),
    // 根拠が要る問だけを分母にする。「根拠なしで断るのが正解」の問 (遊戯王など) は混ぜない。
    evidenceRate: mean(
      ok.filter((r) => r.hasEvidence !== undefined).map((r) => (r.hasEvidence ? 1 : 0)),
    ),
    judgeMean: mean(ok.filter((r) => r.judgeScore !== undefined).map((r) => r.judgeScore!)),
    judgeFailures: ok.filter((r) => r.judgeFailed).length,
  };
}
