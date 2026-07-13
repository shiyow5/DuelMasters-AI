import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { autoBuild } from "../src/builder.js";

describe.skipIf(!hasTestDb)("autoBuild 制約 (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => {
    await truncateAll(sql);
    // テーマ「テスト」で引っかかる火/水/自然のカード群
    const cards = [
      { name: "火1", civ: ["fire"], cost: 2, tags: ["初動"] },
      { name: "火2", civ: ["fire"], cost: 3, tags: ["ブースト"] },
      { name: "水1", civ: ["water"], cost: 4, tags: ["ドロー"] },
      { name: "水2", civ: ["water"], cost: 6, tags: ["除去"] },
      { name: "自然1", civ: ["nature"], cost: 7, tags: ["フィニッシャー"] },
      { name: "火水", civ: ["fire", "water"], cost: 5, tags: ["受け"] },
      { name: "禁止札", civ: ["darkness"], cost: 3, tags: ["除去"] },
      { name: "制限札", civ: ["light"], cost: 4, tags: ["受け"] },
    ];
    for (const c of cards) {
      await sql`INSERT INTO cards (name, civilizations, cost, type, text, tags, is_shield_trigger)
        VALUES (${c.name}, ${sql.json(c.civ)}, ${c.cost}, 'creature', 'テスト効果', ${sql.json(c.tags)}, true)`;
    }
    await sql`INSERT INTO regulations (format, restriction_type, card_name, effective_from) VALUES
      ('original', 'プレミアム殿堂', '禁止札', '2024-01-01'),
      ('original', '殿堂入り', '制限札', '2024-01-01')`;
  });
  afterAll(async () => {
    await sql.end();
  });

  it("プレミアム殿堂カードは結果に含まれない", async () => {
    const r = await autoBuild("テスト", "original");
    expect(r.entries.find((e) => e.name === "禁止札")).toBeUndefined();
  });

  it("殿堂入りカードは count 1 でのみ入る", async () => {
    const r = await autoBuild("テスト", "original");
    const limited = r.entries.find((e) => e.name === "制限札");
    if (limited) expect(limited.count).toBe(1);
  });

  it("excludeCards のカードが入らない", async () => {
    const r = await autoBuild("テスト", "original", { excludeCards: ["火1"] });
    expect(r.entries.find((e) => e.name === "火1")).toBeUndefined();
  });

  it("civilizations: ['fire'] で水単色カードが入らない (多色は可)", async () => {
    const r = await autoBuild("テスト", "original", { civilizations: ["fire"] });
    expect(r.entries.find((e) => e.name === "水1")).toBeUndefined();
    expect(r.entries.find((e) => e.name === "水2")).toBeUndefined();
  });

  it("maxCost: 5 でコスト6以上が入らない", async () => {
    const r = await autoBuild("テスト", "original", { maxCost: 5 });
    expect(r.entries.find((e) => e.name === "水2")).toBeUndefined();
    expect(r.entries.find((e) => e.name === "自然1")).toBeUndefined();
  });

  it("requiredCards がプレミアム殿堂なら weaknesses に文言、entries に入らない", async () => {
    const r = await autoBuild("テスト", "original", {
      requiredCards: ["禁止札"],
    });
    expect(r.entries.find((e) => e.name === "禁止札")).toBeUndefined();
    expect(r.weaknesses.some((w) => w.includes("プレミアム殿堂のため採用できません"))).toBe(true);
  });
});

describe.skipIf(!hasTestDb)("autoBuild クリーチャー比率とコスト0除外 (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => {
    await truncateAll(sql);
    // テーマ「速攻」に一致するのは呪文だけ。クリーチャーはテーマ外にしかない状況を作る。
    // (実データの「火の速攻」がまさにこれで、クリーチャー0枚のデッキを返していた)
    for (let i = 0; i < 10; i++) {
      await sql`INSERT INTO cards (name, civilizations, cost, type, text, is_shield_trigger)
        VALUES (${"速攻呪文" + i}, '["fire"]', ${1 + (i % 3)}, 'spell', '速攻で攻める', true)`;
    }
    for (let i = 0; i < 10; i++) {
      await sql`INSERT INTO cards (name, civilizations, cost, type, text)
        VALUES (${"火クリーチャー" + i}, '["fire"]', ${1 + (i % 3)}, 'creature', 'アタッカー')`;
    }
    // コスト0の特殊カード (禁断・零龍など)。通常デッキに入れてはいけない。
    await sql`INSERT INTO cards (name, civilizations, cost, type, text)
      VALUES ('禁断カード', '["fire"]', 0, 'creature', '速攻'),
             ('零龍の儀', '["fire"]', 0, 'creature', 'アタッカー')`;
  });
  afterAll(async () => {
    await sql.end();
  });

  it("テーマに呪文しか一致しなくてもクリーチャーを最低枚数まで確保する", async () => {
    const r = await autoBuild("速攻", "original", { civilizations: ["fire"] });
    const rows =
      await sql`SELECT name, type FROM cards WHERE name IN ${sql(r.entries.map((e) => e.name))}`;
    const typeOf = new Map(rows.map((x) => [x.name as string, x.type as string]));
    const creatures = r.entries
      .filter((e) => (typeOf.get(e.name) ?? "").includes("creature"))
      .reduce((s, e) => s + e.count, 0);
    expect(creatures).toBeGreaterThanOrEqual(22); // DECK_SIZE 40 * 0.55
  });

  it("minCreatures を明示すればその枚数を満たす", async () => {
    const r = await autoBuild("速攻", "original", { civilizations: ["fire"], minCreatures: 8 });
    const rows =
      await sql`SELECT name, type FROM cards WHERE name IN ${sql(r.entries.map((e) => e.name))}`;
    const typeOf = new Map(rows.map((x) => [x.name as string, x.type as string]));
    const creatures = r.entries
      .filter((e) => (typeOf.get(e.name) ?? "").includes("creature"))
      .reduce((s, e) => s + e.count, 0);
    expect(creatures).toBeGreaterThanOrEqual(8);
  });

  it("コスト0の特殊カード(禁断/零龍)は入らない", async () => {
    const r = await autoBuild("速攻", "original", { civilizations: ["fire"] });
    expect(r.entries.find((e) => e.name === "禁断カード")).toBeUndefined();
    expect(r.entries.find((e) => e.name === "零龍の儀")).toBeUndefined();
  });
});
