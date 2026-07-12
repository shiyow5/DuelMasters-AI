/**
 * 精度 eval ランナー。golden set を読み、各問でエージェントを実行し、
 * ツール軌跡 / 引用 / 事実カバレッジ / LLM-as-judge を計測してレポートする。
 *
 * 実行 (実 API + DB を使う):
 *   set -a; . ./.env; set +a; \
 *   pnpm --filter @dm-ai/agent exec tsx eval/run.ts [goldenDir] [--no-judge] [--out=report.json]
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/index.js";
import { toolTrajectory, citationScore, factCoverage, aggregate } from "./metrics.js";
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
    if (item.rubric && !noJudge) {
      const j = await judgeAnswer(item.question, item.rubric, out.response);
      res.judgeScore = j.score;
      res.judgeReason = j.reason;
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
    `- ツール軌跡 recall: **${fmt(agg.toolRecall)}**`,
    `- 引用 recall / precision: **${fmt(agg.citationRecall)}** / ${fmt(agg.citationPrecision)}`,
    `- 事実カバレッジ: **${fmt(agg.factCoverage)}**`,
    `- judge 平均 (1-5): **${fmt(agg.judgeMean)}**`,
    "",
    "閾値目安: 引用recall≥0.8 / judge平均≥3.5 / ハルシネーションは judge 減点で捕捉",
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--")) ?? join(import.meta.dirname, "golden");
  const noJudge = args.includes("--no-judge");
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
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
