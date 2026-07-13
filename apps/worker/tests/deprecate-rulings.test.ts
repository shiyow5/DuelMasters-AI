import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, truncateAll, enableAppDb } from "../../../tests/helpers/db.js";
import { applyDeprecations } from "../src/jobs/deprecate-rulings.js";
import type { DeprecatedRuling } from "../src/data/deprecated-rulings.js";

const VEC = `[${new Array(768).fill(0).join(",")}]`;

const ENTRY: DeprecatedRuling = {
  qaId: 34932,
  question: "「自分のターンのはじめに」で始まる能力があります。",
  article: "501.1",
  quote: "自分のカードのうちでどれをアンタップするかを決定し",
  rulingQuote: "トリガー能力をすべて使ってから、バトルゾーンとマナゾーンのカードをアンタップします",
  reason: "アンタップより先にトリガー能力を使うと答えており、501.1→501.2 の順序と逆。",
};

describe.skipIf(!hasTestDb)("applyDeprecations (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });

  const insertRuling = (qaId: number, meta: object = {}) =>
    sql`INSERT INTO rule_chunks (doc_type, version, chunk_text, chunk_meta, embedding)
        VALUES ('ruling', 'v1', ${`Q: 裁定${qaId}\nA: 回答`},
                ${sql.json({ qa_id: qaId, ...meta })}, ${VEC}::vector)`;

  const metaOf = async (qaId: number) => {
    const [row] = await sql`
      SELECT chunk_meta FROM rule_chunks
      WHERE doc_type='ruling' AND chunk_meta->>'qa_id' = ${String(qaId)}`;
    return row?.chunk_meta as Record<string, unknown> | undefined;
  };

  beforeEach(async () => {
    await truncateAll(sql);
    await insertRuling(34932);
    await insertRuling(38019);
  });

  it("一覧に載った裁定へ deprecated 印と根拠を付ける", async () => {
    const r = await applyDeprecations(sql, [ENTRY]);
    expect(r.flagged).toBe(1);

    const meta = await metaOf(34932);
    expect(meta?.deprecated).toBe(true);
    expect(meta?.deprecated_by).toBe("501.1");
    // 根拠を残す。後から「なぜ落とされたのか」を人が確認できないと、誤検出を見つけられない。
    expect(String(meta?.deprecated_reason)).toContain("501.1");
  });

  it("一覧に無い裁定には触らない", async () => {
    await applyDeprecations(sql, [ENTRY]);
    const meta = await metaOf(38019);
    expect(meta?.deprecated).toBeUndefined();
    expect(meta?.qa_id).toBe(38019);
  });

  it("既存の chunk_meta (url / qa_id) を壊さない", async () => {
    await truncateAll(sql);
    await insertRuling(34932, { url: "https://example.test/34932/" });
    await applyDeprecations(sql, [ENTRY]);

    const meta = await metaOf(34932);
    expect(meta?.url).toBe("https://example.test/34932/");
    expect(meta?.qa_id).toBe(34932);
    expect(meta?.deprecated).toBe(true);
  });

  it("一覧から外した裁定は印が消えて元に戻る (誤検出の取り消し)", async () => {
    // これが「削除ではなくフラグ」にした理由。一覧から1行消して流し直せば復活する。
    await applyDeprecations(sql, [ENTRY]);
    expect((await metaOf(34932))?.deprecated).toBe(true);

    const r = await applyDeprecations(sql, []);
    expect(r.cleared).toBe(1);

    const meta = await metaOf(34932);
    expect(meta?.deprecated).toBeUndefined();
    expect(meta?.deprecated_by).toBeUndefined();
    expect(meta?.deprecated_reason).toBeUndefined();
    expect(meta?.qa_id).toBe(34932); // 元の meta は残る
  });

  it("何度流しても同じ結果になる (冪等)", async () => {
    await applyDeprecations(sql, [ENTRY]);
    const second = await applyDeprecations(sql, [ENTRY]);
    expect(second.cleared).toBe(0);
    expect((await metaOf(34932))?.deprecated).toBe(true);

    const [{ count }] = await sql`SELECT count(*)::int FROM rule_chunks WHERE doc_type='ruling'`;
    expect(count).toBe(2); // 行は増えも減りもしない
  });

  it("一覧の裁定が DB に無くても落ちない (公式から消えた裁定)", async () => {
    const r = await applyDeprecations(sql, [{ ...ENTRY, qaId: 99999 }]);
    expect(r.flagged).toBe(0);
  });

  it("一覧に同じ qaId が2回載っていても件数を二重に数えない", async () => {
    // flagged はレビュー時の検算に使う。DB 上の対象行は1行なのに 2 と報告されると、
    // 「一覧の件数と DB の件数が合っているか」の確認が意味をなさなくなる。
    const r = await applyDeprecations(sql, [ENTRY, { ...ENTRY, reason: "重複エントリ" }]);
    expect(r.flagged).toBe(1);

    const [{ count }] = await sql`
      SELECT count(*)::int FROM rule_chunks
      WHERE doc_type='ruling' AND chunk_meta->>'deprecated' = 'true'`;
    expect(count).toBe(1);
  });
});
