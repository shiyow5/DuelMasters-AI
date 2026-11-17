import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { runTool } from "../src/tools.js";

describe("runTool search_cards バリデーション (単体)", () => {
  it("不正な civilization は throw せずエラーメッセージを返す", async () => {
    const result = await runTool("search_cards", {
      query: "x",
      civilization: "purple",
    });
    // throw せずにメッセージで返すこと (throw すると catch に飲まれて
    // 「一時的なエラー」に化け、agent が誤報する) と、**何が悪かったかを名指しする**こと。
    expect(result.text).toContain("不正です");
    expect(result.text).toContain("purple");
  });
});

describe.skipIf(!hasTestDb)("runTool search_cards フィルタ (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => {
    await truncateAll(sql);
    await sql`INSERT INTO cards (name, civilizations, cost, type, text) VALUES
      ('火の1', '["fire"]', 2, 'creature', 'ドラゴン'),
      ('水の1', '["water"]', 8, 'spell', 'ドラゴン')`;
  });
  afterAll(async () => {
    await sql.end();
  });

  it("civilization フィルタが効く", async () => {
    const r = await runTool("search_cards", { query: "ドラゴン", civilization: "fire" });
    expect(r.text).toContain("火の1");
    expect(r.text).not.toContain("水の1");
  });

  it("max_cost フィルタが効く", async () => {
    const r = await runTool("search_cards", { query: "ドラゴン", max_cost: 5 });
    expect(r.text).toContain("火の1");
    expect(r.text).not.toContain("水の1");
  });

  it("type フィルタが効く", async () => {
    const r = await runTool("search_cards", { query: "ドラゴン", type: "spell" });
    expect(r.text).toContain("水の1");
    expect(r.text).not.toContain("火の1");
  });
});

describe("runTool build_deck バリデーション (単体)", () => {
  // グラフの tools ノードは zod schema を通さず args を直接渡すため、runTool 側で検証する。
  // 不正な文明コードを黙って捨てると制約なしで構築が走り混色デッキが返るので、必ずエラーを返す。
  it("日本語など不正な文明コードは黙って無視せずエラーを返す", async () => {
    const r = await runTool("build_deck", { theme: "速攻", civilizations: ["火"] });
    expect(r.text).toContain("ツール引数が不正です");
  });
  it("civilizations が空配列ならエラーを返す", async () => {
    const r = await runTool("build_deck", { theme: "速攻", civilizations: [] });
    expect(r.text).toContain("ツール引数が不正です");
  });
  it("theme が無ければエラーを返す", async () => {
    const r = await runTool("build_deck", {});
    expect(r.text).toContain("ツール引数が不正です");
  });
});

describe.skipIf(!hasTestDb)("runTool build_deck 文明制約 (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => {
    await truncateAll(sql);
    // 火 8 種 (最大 32 枚 < DECK_SIZE) + 水 1 枚。文明未指定なら 40 枚に届かず水もフィラーに
    // 使われ、civ=fire なら水を除外する — の両方を安定して検証できる枚数。
    for (let i = 0; i < 8; i++) {
      await sql`INSERT INTO cards (name, civilizations, cost, type, text) VALUES
        (${"火クリーチャー" + i}, '["fire"]', ${1 + (i % 4)}, 'creature', '速攻アタッカー')`;
    }
    await sql`INSERT INTO cards (name, civilizations, cost, type, text) VALUES
      ('水クリーチャー', '["water"]', 3, 'creature', '速攻アタッカー')`;
  });
  afterAll(async () => {
    await sql.end();
  });

  it("civilizations=fire を渡すと水文明カードを含めない", async () => {
    const r = await runTool(
      "build_deck",
      { theme: "速攻", civilizations: ["fire"], max_cost: 5 },
      "advance",
    );
    expect(r.text).toContain("火クリーチャー");
    expect(r.text).not.toContain("水クリーチャー");
  });

  it("文明未指定なら水文明も候補に入り得る (制約なしの既定動作)", async () => {
    // 火のみだと 40 枚に満たないため水もフィラーに使われる = 文明制約が既定で無いことの確認。
    const r = await runTool("build_deck", { theme: "速攻" }, "advance");
    expect(r.text).toContain("水クリーチャー");
  });
});

describe.skipIf(!hasTestDb)("runTool build_deck クリーチャー下限 (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  beforeEach(async () => {
    await truncateAll(sql);
    // テーマに一致するのは呪文だけ。クリーチャーはテーマ外から補充される。
    for (let i = 0; i < 10; i++) {
      await sql`INSERT INTO cards (name, civilizations, cost, type, text, is_shield_trigger) VALUES
        (${"速攻呪文" + i}, '["fire"]', 2, 'spell', '速攻で攻める', false)`;
    }
    for (let i = 0; i < 10; i++) {
      await sql`INSERT INTO cards (name, civilizations, cost, type, text) VALUES
        (${"火クリーチャー" + i}, '["fire"]', 2, 'creature', 'アタッカー')`;
    }
  });
  afterAll(async () => {
    await sql.end();
  });

  it("min_creatures がツール経由で autoBuild まで届く", async () => {
    // zod schema に無いキーは黙って捨てられるため、既定の 22 枚に落ちていないかを枚数で見る。
    const r = await runTool(
      "build_deck",
      { theme: "速攻", civilizations: ["fire"], min_creatures: 4 },
      "original",
    );
    const result = JSON.parse(r.text) as { entries: Array<{ name: string; count: number }> };
    const creatures = result.entries
      .filter((e) => e.name.startsWith("火クリーチャー"))
      .reduce((s, e) => s + e.count, 0);
    expect(creatures).toBe(4);
  });
});

describe("AGENT_TOOLS の JSON Schema (Gemini 互換)", () => {
  // Gemini の function declaration は exclusiveMinimum/exclusiveMaximum を受け付けず 400 を返す。
  // zod の .positive()/.negative()/.gt()/.lt() は排他境界を作り、JSON Schema 変換でこれらになる。
  // 実際に min_creatures: z.number().int().positive() で eval 35問すべてが ERR になった。
  //
  // zod の内部 (_def / _zod) には依存しない: @langchain/google-genai が function declaration 生成に使う
  // のと同じ変換 (@langchain/core の toJsonSchema。schemaToGenerativeAIParameters は package の
  // exports に無く import できない) で JSON Schema にし、その出力を再帰的に走査する。
  const FORBIDDEN = ["exclusiveMinimum", "exclusiveMaximum"];

  /** JSON Schema を再帰的に辿り、禁止キーを持つ位置 (JSON パス風) を集める。 */
  function findForbiddenKeys(value: unknown, path: string): string[] {
    if (Array.isArray(value)) {
      return value.flatMap((v, i) => findForbiddenKeys(v, `${path}[${i}]`));
    }
    if (typeof value !== "object" || value === null) return [];
    return Object.entries(value).flatMap(([k, v]) => [
      ...(FORBIDDEN.includes(k) ? [`${path}.${k}`] : []),
      ...findForbiddenKeys(v, `${path}.${k}`),
    ]);
  }

  it("検出関数が排他境界を検出できる (偽陰性防止)", async () => {
    const { z } = await import("zod");
    const { toJsonSchema } = await import("@langchain/core/utils/json_schema");
    const js = toJsonSchema(z.object({ n: z.number().int().positive() }));
    expect(findForbiddenKeys(js, "t").length).toBeGreaterThan(0);
  });

  it("排他境界 (.positive() 等) を使っていない", async () => {
    const { AGENT_TOOLS } = await import("../src/tools.js");
    const { toJsonSchema } = await import("@langchain/core/utils/json_schema");

    expect(AGENT_TOOLS.length).toBeGreaterThan(0);
    const offenders = AGENT_TOOLS.flatMap((t) => findForbiddenKeys(toJsonSchema(t.schema), t.name));
    expect(offenders).toEqual([]);
  });
});
