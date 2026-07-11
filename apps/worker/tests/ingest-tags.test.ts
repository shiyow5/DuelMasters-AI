import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import {
  getTestSql,
  hasTestDb,
  enableAppDb,
  truncateAll,
} from "../../../tests/helpers/db.js";

// generateStructured のみモック (getSql 等は実物を使う)
vi.mock("@dm-ai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dm-ai/core")>();
  return {
    ...actual,
    generateStructured: vi.fn(async () => [{ name: "謎カード", tags: ["除去"] }]),
  };
});

describe.skipIf(!hasTestDb)("ingest:tags (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => truncateAll(sql));
  afterAll(async () => {
    await sql.end();
  });

  it("ルールで付くカードとLLMで付くカードが DB に反映される (冪等)", async () => {
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
});
