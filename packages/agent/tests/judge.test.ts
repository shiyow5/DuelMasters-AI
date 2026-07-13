import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { extractCardCandidates, buildCardGrounding } from "../eval/judge.js";

describe("extractCardCandidates (単体)", () => {
  it("《…》と「…」からカード名を抽出し重複を除く", () => {
    const r = extractCardCandidates(
      "《ボルシャック・ドラゴン》は強力で、「コッコ・ルピア」で軽くできる。再度《ボルシャック・ドラゴン》。",
    );
    expect(r.sort()).toEqual(["コッコ・ルピア", "ボルシャック・ドラゴン"]);
  });
  it("括弧が無ければ空", () => {
    expect(extractCardCandidates("S・トリガーの説明です。")).toEqual([]);
  });
  it("極端に長い/短い中身は拾わない", () => {
    expect(extractCardCandidates("《あ》《" + "x".repeat(50) + "》")).toEqual([]);
  });
});

describe.skipIf(!hasTestDb)("buildCardGrounding (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => {
    await truncateAll(sql);
    await sql`INSERT INTO cards (name, civilizations, cost, type, text) VALUES
      ('忍蛇の聖沌 c0br4', '["darkness"]', 5, 'creature', 'テスト'),
      ('ボルシャック・ドラゴン', '["fire"]', 7, 'creature', 'テスト')`;
  });
  afterAll(async () => {
    await sql.end();
  });

  it("実在カードは確認済み、未登録は未検出に分類する", async () => {
    const g = await buildCardGrounding(
      "《忍蛇の聖沌 c0br4》と《ボルシャック・ドラゴン》、それに《存在しないカードqwerty》を使う。",
    );
    expect(g).toContain("実在が確認できたカード");
    expect(g).toContain("忍蛇の聖沌 c0br4");
    expect(g).toContain("ボルシャック・ドラゴン");
    expect(g).toContain("DB未検出");
    expect(g).toContain("存在しないカードqwerty");
  });

  it("《》の無い素のデッキリスト表記でも実在カードを拾う (逆引き)", async () => {
    // 抽出方式では拾えず judge が誤って「架空」と減点していたケース。
    const g = await buildCardGrounding(
      "火文明の速攻デッキです。\n4x ボルシャック・ドラゴン\n4x 忍蛇の聖沌 c0br4",
    );
    expect(g).toContain("実在が確認できたカード");
    expect(g).toContain("ボルシャック・ドラゴン");
    expect(g).toContain("忍蛇の聖沌 c0br4");
  });

  it("実在カードが登場しなければ空文字", async () => {
    expect(await buildCardGrounding("S・トリガーの一般的な説明のみ。")).toBe("");
  });
});
