import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { parseDecklist } from "../src/parser.js";
import { scoreDeck } from "../src/scorer.js";

/**
 * #165 B-06: カードDBに無いカードは、スコアから黙って外さず、警告で名前を出す。
 */
describe.skipIf(!hasTestDb)("scoreDeck DB にないカード (統合 / #165 B-06)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });
  beforeEach(async () => {
    await truncateAll(sql);
  });

  const card = (name: string) =>
    sql`INSERT INTO cards (name, civilizations, cost, type, races, text, tags, is_shield_trigger, official_id)
        VALUES (${name}, ${sql.json(["fire"])}, 3, 'creature', ${sql.json([])}, '', ${sql.json([])}, false, ${name})`;

  it("一部が DB に無いと、その名前を警告に出す (同名は1回だけ)", async () => {
    await card("既知カード");
    const score = await scoreDeck(
      parseDecklist(["4 既知カード", "4 打ち間違いカード", "1 打ち間違いカード"].join("\n")),
    );
    expect(score.warnings).toContain(
      "カードDBで見つからないカードが1種類あり、スコアに入っていません: 打ち間違いカード",
    );
    // #128/#151 A: 同じ内容を構造化して返す (警告文字列は後方互換で維持)
    expect(score.unresolvedCards).toEqual(["打ち間違いカード"]);
  });

  it("全カードが DB にあれば、この警告は出ない", async () => {
    await card("既知カード");
    const score = await scoreDeck(parseDecklist("4 既知カード"));
    expect(score.warnings.some((w) => w.startsWith("カードDBで見つからない"))).toBe(false);
    expect(score.unresolvedCards).toEqual([]);
  });

  it("1枚も引けないときは「参考値」の警告だけにする (全カードを DB にないと言わない)", async () => {
    const score = await scoreDeck(parseDecklist("4 未登録A\n4 未登録B"));
    expect(score.warnings).toContain("カード情報を取得できなかったため、この評価は参考値です");
    expect(score.warnings.some((w) => w.startsWith("カードDBで見つからない"))).toBe(false);
  });
});
