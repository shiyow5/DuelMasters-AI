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

// embed のみモック (固定 768 次元)
vi.mock("@dm-ai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dm-ai/core")>();
  return {
    ...actual,
    embed: vi.fn(async (texts: string[]) =>
      texts.map(() => new Array(768).fill(0.1))
    ),
  };
});

describe.skipIf(!hasTestDb)("ingest:faq (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => truncateAll(sql));
  afterAll(async () => {
    await sql.end();
  });

  it("FAQ を doc_type=faq / meta.url 付きで取り込み、再実行で件数が増えない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            "<body>Q: 質問1ですか？ A: 回答1です。\nQ: 質問2ですか？ A: 回答2です。</body>"
          )
      )
    );
    const { runIngestFaq } = await import("../src/jobs/ingest-faq.js");
    const url = "https://example.com/faq";

    const r1 = await runIngestFaq("faq", [url], "2026-07-11");
    expect(r1.inserted).toBe(2);

    const rows = await sql`SELECT doc_type, chunk_meta FROM rule_chunks`;
    expect(rows.length).toBe(2);
    expect(rows[0].doc_type).toBe("faq");
    expect((rows[0].chunk_meta as Record<string, unknown>).url).toBe(url);

    await runIngestFaq("faq", [url], "2026-07-11");
    const count = await sql`SELECT count(*)::int as n FROM rule_chunks`;
    expect(count[0].n).toBe(2);

    vi.unstubAllGlobals();
  });
});
