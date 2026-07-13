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

describe.skipIf(!hasTestDb)("autoBuild クリーチャー下限の境界 (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });

  it("requiredCards のクリーチャーをクリーチャー下限に数える", async () => {
    // 必須カードだけでデッキが埋まるケース。全部クリーチャーなのに「0枚」と警告してはいけない。
    await truncateAll(sql);
    const names = Array.from({ length: 10 }, (_, i) => "必須クリーチャー" + i);
    for (const name of names) {
      await sql`INSERT INTO cards (name, civilizations, cost, type, text)
        VALUES (${name}, '["fire"]', 3, 'creature', '速攻アタッカー')`;
    }
    const r = await autoBuild("速攻", "original", { requiredCards: names });
    expect(r.totalCards).toBe(40);
    expect(r.weaknesses.some((w) => w.includes("クリーチャーが"))).toBe(false);
  });

  it("クリーチャーが下限に届かなくても40枚を埋める (予約枠を空のまま返さない)", async () => {
    // クリーチャーは1種(最大4枚)しかなく、残りはS・トリガーでもないテーマ呪文。
    // 予約したクリーチャー枠を埋められないまま打ち切ると40枚未満の違法デッキになる。
    await truncateAll(sql);
    await sql`INSERT INTO cards (name, civilizations, cost, type, text)
      VALUES ('唯一のクリーチャー', '["fire"]', 2, 'creature', '速攻アタッカー')`;
    for (let i = 0; i < 15; i++) {
      await sql`INSERT INTO cards (name, civilizations, cost, type, text, is_shield_trigger)
        VALUES (${"速攻呪文" + i}, '["fire"]', 2, 'spell', '速攻で攻める', false)`;
    }
    const r = await autoBuild("速攻", "original", { civilizations: ["fire"] });
    expect(r.totalCards).toBe(40);
    expect(r.weaknesses.some((w) => w.includes("攻撃役が不足"))).toBe(true);
  });

  it("下限で部分的にしか入らなかったカードを後のパスで上限まで積み増す", async () => {
    // minCreatures=3 は MAX_COPIES(4) の倍数でないため、境界のクリーチャーが3枚だけ入る。
    // そこで名前を使用済みに固定してしまうと、空きがあるのに4枚目を足せない。
    await truncateAll(sql);
    await sql`INSERT INTO cards (name, civilizations, cost, type, text)
      VALUES ('境界クリーチャー', '["fire"]', 2, 'creature', '速攻アタッカー')`;
    await sql`INSERT INTO cards (name, civilizations, cost, type, text, is_shield_trigger)
      VALUES ('速攻呪文', '["fire"]', 2, 'spell', '速攻で攻める', false)`;
    const r = await autoBuild("速攻", "original", { civilizations: ["fire"], minCreatures: 3 });
    expect(r.entries.find((e) => e.name === "境界クリーチャー")?.count).toBe(4);
  });
});

describe.skipIf(!hasTestDb)("autoBuild 必須カードの重複行 (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });

  it("同名カードが複数行あっても必須クリーチャーを二重に数えない", async () => {
    // cards.name に UNIQUE 制約は無く、upsert は official_id 単位。再録カード (別 official_id・
    // 同名) が入ると同名が複数行になる。種別を name で引くと採用枚数を行数ぶん足してしまい、
    // 4枚しか入っていないのに 8枚 と数えてクリーチャー補充が発火しなくなる。
    await truncateAll(sql);
    for (const officialId of ["dm-001", "dm-002"]) {
      await sql`INSERT INTO cards (name, civilizations, cost, type, text, official_id)
        VALUES ('重複クリーチャー', '["fire"]', 3, 'creature', '速攻アタッカー', ${officialId})`;
    }
    for (let i = 0; i < 10; i++) {
      await sql`INSERT INTO cards (name, civilizations, cost, type, text, is_shield_trigger)
        VALUES (${"速攻呪文" + i}, '["fire"]', 2, 'spell', '速攻で攻める', false)`;
    }
    const r = await autoBuild("速攻", "original", {
      requiredCards: ["重複クリーチャー"],
      minCreatures: 6,
    });
    // 実際のクリーチャーは4枚 (重複行を数えれば8枚) なので、下限6枚に足りず警告が出るはず。
    expect(r.weaknesses.some((w) => w.includes("攻撃役が不足"))).toBe(true);
  });
});
