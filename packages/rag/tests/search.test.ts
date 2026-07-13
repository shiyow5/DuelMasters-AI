import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";

const DIM = 768;
/** 決定的な埋め込み。クエリとの近さを第0・第1成分で作る。 */
function vec(first: number, second: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = first;
  v[1] = second;
  return v;
}
const QUERY_VEC = vec(1, 0);
const NEAR = vec(0.6, 0.8); // 条文
const NEAREST = vec(0.99, 0.01); // 裁定 (条文よりクエリに近い)
const OPPOSITE = vec(-1, 0); // 例外規定 (ベクトルでもキーワードでも引けない)

// 埋め込みは実 API を叩かない。どのクエリでも同じベクトルを返すので、
// クエリごとの差はキーワード検索側だけに出る。
vi.mock("@dm-ai/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dm-ai/core")>()),
  embedSingle: vi.fn(async () => QUERY_VEC),
}));

const { searchRules } = await import("../src/search.js");

const QUESTION = "シールドをブレイクされた時、S・トリガーはいつ使えますか？";

describe.skipIf(!hasTestDb)("searchRules (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => {
    await truncateAll(sql);
    const rule = (text: string, meta: object, v: number[]) =>
      sql`INSERT INTO rule_chunks (doc_type, version, chunk_text, chunk_meta, embedding)
          VALUES ('comprehensive_rules', '1.50', ${text}, ${sql.json(meta)}, ${`[${v.join(",")}]`}::vector)`;

    // 裁定を大量に置き、条文より「クエリに近い」ベクトルを与える。
    // 実データ (裁定3246 / 条文600) で条文が1件も返らなかった状況を再現する。
    for (let i = 0; i < 20; i++) {
      await sql`INSERT INTO rule_chunks (doc_type, version, chunk_text, chunk_meta, embedding)
        VALUES ('ruling', 'v1', ${"Q: シールドの裁定" + i + "\nA: 回答"},
                ${sql.json({ qa_id: 1000 + i })}, ${`[${NEAREST.join(",")}]`}::vector)`;
    }
    await rule(
      "113. シールド\n113.6. プレイヤーは「S・トリガー」の使用宣言を行えます。",
      { section: "113", article: "113.6" },
      NEAR,
    );
    // 同じ節の例外規定。本則と語彙が違うのでベクトルでもキーワードでも引けない
    // (実データの 500.6「先攻プレイヤーの第1ターンはドローステップを飛ばします」と同じ状況)。
    await rule(
      "113. シールド\n113.9. 先に宣言したプレイヤーから順に処理する。",
      { section: "113", article: "113.9" },
      OPPOSITE,
    );
    // 別の節の条文。条文枠が 113.9 で埋まらないようにする詰め物。
    await rule("200. マナ\n200.1. マナゾーンの規定。", { section: "200", article: "200.1" }, NEAR);
    await rule("300. バトル\n300.1. バトルの規定。", { section: "300", article: "300.1" }, NEAR);
  });
  afterAll(async () => {
    await sql.end();
  });

  it("裁定が数で圧倒しても条文の枠を確保する", async () => {
    const r = await searchRules(QUESTION);
    const rules = r.chunks.filter((c) => c.meta.doc_type === "comprehensive_rules");
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(rules[0].meta.article).toBe("113.6");
  });

  it("doc_type で絞っても0件にならない (HNSW の後置フィルタ対策)", async () => {
    const r = await searchRules("S・トリガー", { docType: "comprehensive_rules" });
    expect(r.chunks.length).toBe(4);
    expect(r.chunks[0].meta.article).toBe("113.6");
  });

  it("検索結果に doc_type が載る (条文と裁定を引用時に区別できる)", async () => {
    const r = await searchRules(QUESTION);
    expect(r.chunks.every((c) => typeof c.meta.doc_type === "string")).toBe(true);
  });

  it("上位に来た条文の節から兄弟条文を補う (例外規定の取りこぼし対策)", async () => {
    const r = await searchRules(QUESTION);
    const articles = r.chunks.map((c) => c.meta.article);
    expect(articles).toContain("113.6");
    expect(articles).toContain("113.9");
  });

  it("sectionExpansion=0 なら節の展開をしない", async () => {
    const r = await searchRules(QUESTION, { sectionExpansion: 0 });
    expect(r.chunks.map((c) => c.meta.article)).not.toContain("113.9");
  });

  it("日本語のキーワード検索が効く (空白が無くても語を切り出せる)", async () => {
    // ベクトルは裁定の方が近い。キーワード「S・トリガー」は条文にしか無いので、
    // キーワード検索が死んでいると条文枠でしか出てこない。
    const r = await searchRules("S・トリガーの使用宣言について");
    expect(r.chunks[0].meta.article).toBe("113.6");
  });
});
