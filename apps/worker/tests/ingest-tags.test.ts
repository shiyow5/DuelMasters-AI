import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";

/**
 * 役割タグ付与 (#120)。
 *
 * ## cron に入れる前に潰しておくこと
 *
 * `onlyEmpty` は `jsonb_array_length(tags) = 0` で対象を選んでいた。ところが
 * **LLM がタグを1つも返さなかったカードは tags = [] のまま残る**ので、次回実行で必ず
 * 再選択され、また LLM に投げられる。cron に組み込むと**毎週再課金され、永久に収束しない**。
 *
 * 「タグが空である」ことと「タグ付けを試したか」は別の情報。`tags_updated_at` で分ける。
 */

const generateStructuredMock = vi.fn();

vi.mock("@dm-ai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dm-ai/core")>();
  return {
    ...actual,
    generateStructured: (...args: unknown[]) => generateStructuredMock(...args),
  };
});

describe.skipIf(!hasTestDb)("ingest:tags (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => {
    await truncateAll(sql);
    generateStructuredMock.mockReset();
    // 既定: バッチ内の 1番目 (= 謎カード) に「除去」を付ける。
    // **名前ではなく通し番号で返す** (Gemini が名前を改変しても壊れないようにしたため)。
    generateStructuredMock.mockResolvedValue([{ no: 1, tags: ["除去"] }]);
  });
  afterAll(async () => {
    await sql.end();
  });

  it("ルールで付くカードとLLMで付くカードが DB に反映される", async () => {
    const { runIngestTags } = await import("../src/jobs/ingest-tags.js");
    await sql`INSERT INTO cards (name, cost, type, text, is_shield_trigger) VALUES
      ('受けカード', 3, 'creature', '', true),
      ('謎カード', 5, 'creature', 'よく分からない効果', false)`;

    const summary = await runIngestTags({ onlyEmpty: true });
    expect(summary.ruleCount).toBeGreaterThanOrEqual(1);
    expect(summary.llmCount).toBe(1);

    const rows = await sql`SELECT name, tags FROM cards ORDER BY name`;
    const map = new Map(rows.map((r) => [r.name as string, r.tags as string[]]));
    expect(map.get("受けカード")).toContain("受け");
    expect(map.get("謎カード")).toContain("除去");
  });

  it("**LLM が空を返したカードにも「試行済み」印を打つ** (毎週再課金しない)", async () => {
    // これが無いと、タグが付かなかったカードを cron のたびに LLM へ投げ直す。
    const { runIngestTags } = await import("../src/jobs/ingest-tags.js");
    await sql`INSERT INTO cards (name, cost, type, text, is_shield_trigger) VALUES
      ('タグ無しカード', 5, 'creature', 'よく分からない効果', false)`;
    generateStructuredMock.mockResolvedValue([{ no: 1, tags: [] }]);

    const first = await runIngestTags({ onlyEmpty: true });
    expect(first.emptyCount).toBe(1);

    const rows = await sql`SELECT tags, tags_updated_at FROM cards`;
    expect(rows[0].tags).toEqual([]); // タグは空のまま
    expect(rows[0].tags_updated_at).not.toBeNull(); // **でも試行済み**

    // 2回目: LLM を呼ばない
    generateStructuredMock.mockClear();
    const second = await runIngestTags({ onlyEmpty: true });
    expect(second.llmCount).toBe(0);
    expect(second.emptyCount).toBe(0);
    expect(generateStructuredMock).not.toHaveBeenCalled();
  });

  it("2回目は新規カードだけを対象にする (増分)", async () => {
    const { runIngestTags } = await import("../src/jobs/ingest-tags.js");
    await sql`INSERT INTO cards (name, cost, type, text, is_shield_trigger) VALUES
      ('受けカード', 3, 'creature', '', true)`;
    await runIngestTags({ onlyEmpty: true });

    // 新弾が入った
    await sql`INSERT INTO cards (name, cost, type, text, is_shield_trigger) VALUES
      ('新カード', 3, 'creature', '', true)`;
    const second = await runIngestTags({ onlyEmpty: true });

    // 既存の「受けカード」は再処理しない
    expect(second.ruleCount).toBe(1);
    const rows = await sql`SELECT name, tags FROM cards WHERE name = '新カード'`;
    expect(rows[0].tags).toContain("受け");
  });

  it("**LLM の結果は通し番号で突き合わせる** (名前を改変されても取りこぼさない)", async () => {
    // Gemini はカード名を正規化・改変することがある。名前で照合していると黙って
    // タグ無しに落ち、tags_updated_at で「試行済み」が刻まれて**二度と再試行されない**。
    const { runIngestTags } = await import("../src/jobs/ingest-tags.js");
    await sql`INSERT INTO cards (name, cost, type, text, is_shield_trigger) VALUES
      ('《謎の　カード》', 5, 'creature', 'よく分からない効果', false)`;
    // 名前を勝手に整形して返してくる LLM
    generateStructuredMock.mockResolvedValue([{ no: 1, tags: ["除去"] }]);

    const summary = await runIngestTags({ onlyEmpty: true });

    expect(summary.llmCount).toBe(1);
    const rows = await sql`SELECT tags FROM cards`;
    expect(rows[0].tags).toContain("除去");
  });
});
