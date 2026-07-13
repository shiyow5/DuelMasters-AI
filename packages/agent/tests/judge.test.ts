import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { extractCardCandidates, buildCardGrounding, buildRuleGrounding } from "../eval/judge.js";

// 公式裁定の RAG はモックする (埋め込み API を叩かせない)。
const searchRulesMock = vi.hoisted(() => vi.fn());
vi.mock("@dm-ai/rag", () => ({ searchRules: (...a: unknown[]) => searchRulesMock(...a) }));

describe("buildRuleGrounding (単体)", () => {
  it("関連裁定を一次情報として提示し、記憶で反する判断をしないよう指示する", async () => {
    searchRulesMock.mockResolvedValueOnce({
      chunks: [{ text: "マナの数字の合計が、コストと同じであることが条件です。", meta: {} }],
    });
    const g = await buildRuleGrounding("マナはどう支払いますか？");
    expect(g).toContain("公式裁定");
    expect(g).toContain("コストと同じ");
    expect(g).toContain("あなた自身の記憶で下さないこと");
  });

  it("裁定が無ければ空文字", async () => {
    searchRulesMock.mockResolvedValueOnce({ chunks: [] });
    expect(await buildRuleGrounding("無関係な質問")).toBe("");
  });

  it("RAG が落ちても judge を落とさず空文字を返す", async () => {
    searchRulesMock.mockRejectedValueOnce(new Error("embedding API down"));
    expect(await buildRuleGrounding("質問")).toBe("");
  });
});

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
    await sql`INSERT INTO cards (name, civilizations, cost, type, power, text) VALUES
      ('忍蛇の聖沌 c0br4', '["darkness"]', 5, 'creature', 3000, 'テスト'),
      ('ボルシャック・ドラゴン', '["fire"]', 7, 'creature', 6000, 'テスト')`;
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

  it("文明/コスト/種別/パワーを正解として提示する", async () => {
    // judge は実在カードのスペックも捏造する (火の《死亡遊戯》を「闇文明」と断じた等)。
    // 名前だけの grounding では防げないため、スペックまで渡す。
    const g = await buildCardGrounding("4x ボルシャック・ドラゴン");
    expect(g).toContain("スペック");
    expect(g).toContain("ボルシャック・ドラゴン (火 / コスト7 / creature / パワー6000)");
    expect(g).toContain("文明・コスト・種別・パワーは上記が正解");
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
