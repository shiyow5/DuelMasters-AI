import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { checkRegulationNames, type RegulationRow } from "@dm-ai/deck-engine";
import { getTestSql, hasTestDb, truncateAll, enableAppDb } from "../../../tests/helpers/db.js";
import { formatRegulationChecks, runTool } from "../src/tools.js";
import { factCoverage } from "../eval/metrics.js";
import type { GoldenItem } from "../eval/types.js";

/**
 * #178 の受入条件を決定的なテストで固定する。
 *
 * - 「ジョラゴン = 殿堂入り」「スパイラル・ゲート = 殿堂でない」
 *   (QA 11/02 No.33 / No.32・35。LLM が記憶で答えて揺れた)
 * - regulations に届かないときは「確認できなかった」と返し、言い切らない
 *
 * LLM は呼ばない。golden (eval/golden/seed.jsonl) に同じ問いを載せ、
 * ツールが返す文に golden の expectedFacts が必ず入ることを確かめる
 * (ツールの結果どおりに答えれば事実カバレッジが 1 になる)。
 *
 * 殿堂の行は公式 /rule/regulation/ (2026-11-03 取得, 127件) の表記に合わせている。
 * No.33 の「ジョラゴン」は公式リストでは《ジョット・ガン・ジョラゴン》(殿堂入り)。
 * スパイラル・ゲートはリストに無い。
 */

const JOLAGON = "ジョット・ガン・ジョラゴン";
const SPIRAL = "スパイラル・ゲート";

/** 公式リストから抜いた行 (取り違え検出用に、似た名前・別区分の行も入れる) */
const OFFICIAL_ROWS: RegulationRow[] = [
  { card_name: JOLAGON, restriction_type: "殿堂入り" },
  { card_name: "ヘブンズ・ゲート", restriction_type: "プレミアム殿堂" },
  { card_name: "ボルシャック・ドラゴン", restriction_type: "殿堂入り" },
];

/** cards テーブルで名前を引いた結果に相当 (規制なしのカードも含む) */
const CARD_NAMES = [JOLAGON, SPIRAL, "ヘブンズ・ゲート", "ボルシャック・ドラゴン"];

function toolText(name: string): string {
  return formatRegulationChecks(
    checkRegulationNames([name], OFFICIAL_ROWS, CARD_NAMES),
    "original",
    "2026-11-03",
  );
}

function loadGolden(): GoldenItem[] {
  const path = join(import.meta.dirname, "..", "eval", "golden", "seed.jsonl");
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GoldenItem);
}

function golden(id: string): GoldenItem {
  const item = loadGolden().find((x) => x.id === id);
  if (!item) throw new Error(`golden "${id}" がありません`);
  return item;
}

describe("golden: 殿堂の単独質問 (#178)", () => {
  it("ジョラゴンの問いがあり、check_regulation と「殿堂入り」を求める", () => {
    const item = golden("deck-regulation-jolagon");
    expect(item.question).toContain("ジョラゴン");
    expect(item.expectedTools).toContain("check_regulation");
    expect(item.expectedFacts).toEqual(expect.arrayContaining([JOLAGON, "殿堂入り"]));
    expect(item.expectEvidence).toBe(true);
  });

  it("スパイラル・ゲートの問いがあり、check_regulation と「制限なし」を求める", () => {
    const item = golden("deck-regulation-spiral-gate");
    expect(item.question).toContain(SPIRAL);
    expect(item.expectedTools).toContain("check_regulation");
    expect(item.expectedFacts).toContain("制限なし");
    expect(item.expectedFacts).not.toContain("殿堂入り");
    expect(item.expectEvidence).toBe(true);
  });
});

describe("check_regulation の結果 (単体, 公式表記, #178)", () => {
  it("ジョラゴン (略称): 制限なしと言わず、《ジョット・ガン・ジョラゴン》[殿堂入り] を候補に出す", () => {
    const text = toolText("ジョラゴン");
    expect(text).toContain(`《${JOLAGON}》[殿堂入り]`);
    expect(text).toContain("制限なしと断定しないでください");
    expect(text).not.toMatch(/「ジョラゴン」: 制限なし/);
  });

  it("ジョット・ガン・ジョラゴン (正式名・中黒なし): 殿堂入り (1枚まで)", () => {
    expect(toolText(JOLAGON)).toContain(`「${JOLAGON}」: 殿堂入り (1枚まで)`);
    expect(toolText("ジョットガンジョラゴン")).toContain(
      "「ジョットガンジョラゴン」: 殿堂入り (1枚まで)",
    );
  });

  it("スパイラル・ゲート: 制限なし (4枚まで)。殿堂入り・プレミアム殿堂にしない", () => {
    const text = toolText(SPIRAL);
    expect(text).toContain(`「${SPIRAL}」: 制限なし (4枚まで)`);
    const line = text.split("\n").find((l) => l.includes(`「${SPIRAL}」`))!;
    expect(line).not.toMatch(/殿堂入り \(|プレミアム殿堂 \(/);
  });

  it("同じ問いを3回引いても毎回同じ結果 (受入条件「各3回」の決定的版)", () => {
    for (const name of ["ジョラゴン", JOLAGON, SPIRAL]) {
      const runs = [toolText(name), toolText(name), toolText(name)];
      expect(new Set(runs).size).toBe(1);
    }
  });

  it("ツールの結果どおりに答えれば golden の expectedFacts をすべて満たす", () => {
    const jol = golden("deck-regulation-jolagon");
    expect(factCoverage(jol.expectedFacts ?? [], toolText("ジョラゴン"))).toBe(1);
    const spi = golden("deck-regulation-spiral-gate");
    expect(factCoverage(spi.expectedFacts ?? [], toolText(SPIRAL))).toBe(1);
  });
});

describe("regulations 未接続 (単体, DATABASE_URL 空, #178 (e))", () => {
  it.each(["ジョラゴン", JOLAGON, SPIRAL])(
    "check_regulation(%s) は「確認できませんでした」で、区分を言い切らない",
    async (name) => {
      const r = await runTool("check_regulation", { card_names: [name] });
      expect(r.ok).toBe(false);
      expect(r.systemFailure).toBe(true);
      expect(r.text).toContain("確認できませんでした");
      expect(r.text).not.toContain("制限なし (4枚まで)");
      expect(r.text).not.toContain("殿堂入り (1枚まで)");
    },
  );
});

describe.skipIf(!hasTestDb)("殿堂の単独質問 (統合, 公式表記, #178)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await truncateAll(sql);
    const card = (name: string, cost: number) =>
      sql`INSERT INTO cards (name, civilizations, cost, type, races, text, official_id)
          VALUES (${name}, ${sql.json(["fire"])}, ${cost}, 'creature', ${sql.json([])}, '', ${name})`;
    await card(JOLAGON, 7);
    await card(SPIRAL, 2);
    for (const r of OFFICIAL_ROWS) {
      await sql`INSERT INTO regulations (format, restriction_type, card_name, effective_from)
                VALUES ('original', ${r.restriction_type}, ${r.card_name}, '2026-11-03')`;
    }
  });

  it("ジョラゴン: cards から《ジョット・ガン・ジョラゴン》[殿堂入り] を候補に出す", async () => {
    const r = await runTool("check_regulation", { card_names: ["ジョラゴン"] });
    expect(r.ok).not.toBe(false);
    expect(r.text).toContain(`《${JOLAGON}》[殿堂入り]`);
    expect(r.text).not.toMatch(/「ジョラゴン」: 制限なし/);
  });

  it("正式名で殿堂入り、スパイラル・ゲートは制限なし", async () => {
    const r = await runTool("check_regulation", { card_names: [JOLAGON, SPIRAL] });
    expect(r.text).toContain(`「${JOLAGON}」: 殿堂入り (1枚まで)`);
    expect(r.text).toContain(`「${SPIRAL}」: 制限なし (4枚まで)`);
  });

  it("search_cards の区分タグも同じ", async () => {
    expect((await runTool("search_cards", { query: "ジョラゴン" })).text).toContain(
      `${JOLAGON} [殿堂入り]`,
    );
    expect((await runTool("search_cards", { query: "スパイラル" })).text).toContain(
      `${SPIRAL} [制限なし]`,
    );
  });
});
