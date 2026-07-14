/**
 * 精度 eval ランナー。golden set を読み、各問でエージェントを実行し、
 * ツール軌跡 / 引用 / 事実カバレッジ / LLM-as-judge を計測してレポートする。
 *
 * 実行 (実 API + DB を使う):
 *   set -a; . ./.env; set +a; \
 *   pnpm --filter @dm-ai/agent exec tsx eval/run.ts [goldenDir] [--no-judge] [--gate] [--out=report.json]
 *
 * --gate: 閾値 (eval/thresholds.ts) を割ったら exit 1。CI の回帰ゲート用。
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/index.js";
import {
  toolTrajectory,
  citationScore,
  citationGrounding,
  citedArticles,
  factCoverage,
  aggregate,
} from "./metrics.js";
import { checkThresholds, THRESHOLDS } from "./thresholds.js";
import { judgeAnswer } from "./judge.js";
import type { GoldenItem, ItemResult } from "./types.js";

function loadGolden(dir: string): GoldenItem[] {
  const items: GoldenItem[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    const lines = readFileSync(join(dir, f), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const l of lines) items.push(JSON.parse(l) as GoldenItem);
  }
  return items;
}

async function evalItem(item: GoldenItem, noJudge: boolean): Promise<ItemResult> {
  const t0 = Date.now();
  try {
    const out = await runAgent({
      message: item.question,
      mode: item.mode,
      format: item.format,
      history: item.history,
    });
    const res: ItemResult = { id: item.id, mode: item.mode, latencyMs: Date.now() - t0 };
    if (item.expectedTools) {
      res.tool = toolTrajectory(
        item.expectedTools,
        (out.toolCalls ?? []).map((t) => t.name),
      );
    }
    if (item.expectedCitations) {
      res.citation = citationScore(item.expectedCitations, out.citations ?? []);
    }
    if (item.expectedFacts) res.factCoverage = factCoverage(item.expectedFacts, out.response);
    // 根拠が付いたか (#108)。
    //
    // **ツールを「呼んだ」かでは測れない。** 2つの理由がある:
    // 1. 事前 RAG が条文を渡すとモデルは search_rules を呼ばずに答える。それは正しい。
    // 2. **ツールが失敗しても AIMessage.tool_calls は残る。** 呼び出し数を見ると、
    //    ツールが全滅しても「根拠あり」になり、#112 の失敗モード (ツール全滅 →
    //    モデルが記憶から捏造) を素通しする。
    // だから「引用が付いた」か「ツールが**実際にデータを取れた**」かで測る。
    if (item.expectEvidence) {
      res.hasEvidence = (out.citations?.length ?? 0) > 0 || out.toolSuccesses > 0;
    }
    // ツールの失敗は**全問で**記録する (#109)。失敗しても回答は返ってしまうので、
    // ここで見ないと「本番でツールが全滅しているのに eval は満点」が起きる (#112)。
    res.toolFailures = out.toolFailures;
    // 本文に書いた条番号が、実際に retrieve した資料にあるか (#99)。
    // LLM は実在しない条番号を平然と書くので、ここが唯一の機械的な番人になる。
    res.citationGrounding = citationGrounding(out.response, out.ungroundedCitations ?? []);
    // 退行を後から追えるように、本文と引いた条番号をレポートへ残す。
    res.response = out.response;
    res.citedArticles = citedArticles(out.response);
    res.ungroundedCitations = out.ungroundedCitations;
    if (item.rubric && !noJudge) {
      // judge 失敗 (構造化出力/quota/一時エラー) を item 全体の失敗にせず、
      // 既算出の tool/fact/citation 指標を保持する (judge 障害を agent 失敗に見せない)。
      try {
        const j = await judgeAnswer(item.question, item.rubric, out.response);
        res.judgeScore = j.score;
        res.judgeReason = j.reason;
      } catch (err) {
        res.judgeReason = `judge失敗: ${(err as Error).message}`;
        res.judgeFailed = true;
      }
    }
    return res;
  } catch (err) {
    return {
      id: item.id,
      mode: item.mode,
      latencyMs: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}

function fmt(n: number | null): string {
  return n === null ? "-" : n.toFixed(2);
}

function renderReport(agg: ReturnType<typeof aggregate>): string {
  return [
    "## Eval Report",
    "",
    `- 対象: ${agg.n}件 (エラー ${agg.errors})`,
    `- ツール軌跡 recall / precision: **${fmt(agg.toolRecall)}** / **${fmt(agg.toolPrecision)}**`,
    `- 引用 recall / precision: **${fmt(agg.citationRecall)}** / ${fmt(agg.citationPrecision)}`,
    `- 出典の裏取り (本文の条番号が資料にあるか): **${fmt(agg.citationGrounding)}**`,
    `- 根拠あり率 (引用 or ツール結果。1未満 = 記憶だけで答えた問がある): **${fmt(agg.evidenceRate)}**`,
    `- **システム障害でツールが落ちた問: ${agg.toolFailureItems}件** (0 でなければならない)`,
    `- 事実カバレッジ: **${fmt(agg.factCoverage)}**`,
    `- judge 平均 (1-5): **${fmt(agg.judgeMean)}**` +
      (agg.judgeFailures > 0 ? ` (**judge 失敗 ${agg.judgeFailures}件**)` : ""),
    "",
    // 閾値はここに書き写さず thresholds.ts から出す (二重管理で食い違うのを防ぐ)。
    `回帰ゲートの閾値: エラー ${THRESHOLDS.maxErrors}件 / judge平均 ≥ ${THRESHOLDS.minJudgeMean} / ` +
      `ツールrecall ≥ ${THRESHOLDS.minToolRecall} / ツールprecision ≥ ${THRESHOLDS.minToolPrecision} / ` +
      `事実カバレッジ ≥ ${THRESHOLDS.minFactCoverage}`,
  ].join("\n");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--")) ?? join(import.meta.dirname, "golden");
  const noJudge = args.includes("--no-judge");
  const gate = args.includes("--gate");
  const outPath = args.find((a) => a.startsWith("--out="))?.slice(6);

  const items = loadGolden(dir);
  console.log(`=== eval 開始: golden ${items.length}件 (judge=${!noJudge}) ===`);
  const results: ItemResult[] = [];
  for (const item of items) {
    const r = await evalItem(item, noJudge);
    results.push(r);
    console.log(
      `  ${r.id} [${r.mode}] ${
        r.error
          ? "ERR " + r.error
          : `judge=${r.judgeScore ?? "-"} tool=${fmt(r.tool?.recall ?? null)} facts=${fmt(r.factCoverage ?? null)} ${r.latencyMs}ms`
      }`,
    );
  }
  const agg = aggregate(results);
  const report = renderReport(agg);
  console.log("\n" + report);
  if (outPath) {
    writeFileSync(
      outPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), agg, results }, null, 2),
    );
    console.log(`\nレポート出力: ${outPath}`);
  }

  // --gate: 閾値割れで失敗させる (CI の回帰ゲート)。
  if (gate) {
    // --no-judge は意図的な省略。judge を回したのにスコアが無い場合は障害として落とす。
    const { passed, failures } = checkThresholds(agg, { judgeExpected: !noJudge });
    if (!passed) {
      console.error("\n=== 回帰ゲート失敗 ===");
      for (const f of failures) console.error(`  - ${f}`);
      return 1;
    }
    console.log("\n回帰ゲート: 合格");
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
