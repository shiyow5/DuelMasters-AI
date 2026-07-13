import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, truncateAll, enableAppDb } from "../../../tests/helpers/db.js";

const { runTool } = await import("../src/tools.js");

describe.skipIf(!hasTestDb)("search_cards (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await truncateAll(sql);
    const card = (
      name: string,
      civ: string[],
      cost: number,
      type: string,
      text: string,
      power: number | null = null,
    ) =>
      sql`INSERT INTO cards (name, civilizations, cost, type, races, text, power, official_id)
          VALUES (${name}, ${sql.json(civ)}, ${cost}, ${type}, ${sql.json([])}, ${text}, ${power}, ${name})`;

    await card(
      "ヘブンズ・ゲート",
      ["light"],
      6,
      "spell",
      "S・トリガー 光のブロッカーを2体まで出す",
    );
    await card("ボルシャック・ドラゴン", ["fire"], 6, "creature", "パワーアタッカー", 6000);
    await card("超竜バジュラ", ["fire"], 8, "creature", "攻撃時マナを3枚破壊", 12000);
    await card("青銅の鎧", ["nature"], 3, "creature", "出た時マナブースト", 1000);
  });

  it("中黒なしでもカード名で引ける (本番で 0件になっていたケース)", async () => {
    // 《ヘブンズ・ゲート》を「ヘブンズゲート」と書いても引けなければならない。
    // これが 0件になり、agent が「ツールの一時的なエラー」と誤報していた。
    const r = await runTool("search_cards", { query: "ヘブンズゲート" });
    expect(r.text).toContain("ヘブンズ・ゲート");
  });

  it("中黒ありでも従来どおり引ける", async () => {
    const r = await runTool("search_cards", { query: "ヘブンズ・ゲート" });
    expect(r.text).toContain("ヘブンズ・ゲート");
  });

  it("《》付きで書かれても引ける", async () => {
    const r = await runTool("search_cards", { query: "《ボルシャックドラゴン》" });
    expect(r.text).toContain("ボルシャック・ドラゴン");
  });

  it("コスト下限で検索できる (query なし)", async () => {
    // 「コスト7以上のクリーチャー」は min_cost が無いと**表現できず**、agent が
    // query に「コスト7以上」と意味的な語を突っ込んで 0件にしていた。
    const r = await runTool("search_cards", { min_cost: 7, type: "creature" });
    expect(r.text).toContain("超竜バジュラ");
    expect(r.text).not.toContain("青銅の鎧"); // コスト3は除外
  });

  it("文明の日本語表記でも検索できる", async () => {
    // Gemini は「火」と日本語で渡してくることがある。従来は zod が弾いていた。
    const r = await runTool("search_cards", { civilization: "火" });
    expect(r.text).toContain("ボルシャック・ドラゴン");
    expect(r.text).not.toContain("ヘブンズ・ゲート"); // 光は除外
  });

  it("0件は「エラーではない」と明示して返す", async () => {
    // **0件とエラーを agent が区別できないのが誤報の原因。** はっきり伝える。
    const r = await runTool("search_cards", { query: "存在しないカード名XYZ" });
    expect(r.text).toContain("0件");
    expect(r.text).toContain("エラーではありません");
  });

  it("絞り込みが1つも無ければ拒否する", async () => {
    const r = await runTool("search_cards", {});
    expect(r.text).toContain("検索条件");
  });

  it("テキストでも引ける (名前以外)", async () => {
    const r = await runTool("search_cards", { query: "マナブースト" });
    expect(r.text).toContain("青銅の鎧");
  });
});
