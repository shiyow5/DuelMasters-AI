import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { deriveStrategy, autoBuild } from "../src/builder.js";
import { scoreDeck } from "../src/scorer.js";
import { parseDecklist } from "../src/parser.js";

/**
 * 戦略語彙マッピングと S・トリガー下限 (#128 Stage 1)。
 *
 * - deriveStrategy: 戦略語 → 制約 + コア語の抽出 (純関数、DB 非依存)。
 * - autoBuild: 戦略に沿った制約 (max_cost/クリーチャー比) が適用され、
 *   出力が兄弟の scoreDeck を「トリガー/受け札不足」で減点されないこと (構築↔評価の内部整合)。
 */

describe("deriveStrategy (純関数)", () => {
  it("速攻/アグロ系は maxCost を下げクリーチャー比を上げる", () => {
    for (const w of ["速攻", "アグロ", "ビートダウン"]) {
      const s = deriveStrategy(w);
      expect(s.profile?.maxCost).toBe(5);
      expect(s.profile?.minCreatureRatio).toBe(0.65);
      expect(s.core).toBe(""); // 戦略語だけ = コア無し
    }
  });

  it("コントロールは高カーブ許容 (maxCost 無し) でトリガー下限を上げる", () => {
    const s = deriveStrategy("コントロール");
    expect(s.profile?.maxCost).toBeUndefined();
    expect(s.profile?.triggerFloor).toBe(10);
    expect(s.profile?.minCreatureRatio).toBe(0.4);
  });

  it("戦略語を取り除いてコア語 (種族・カード名) を残す", () => {
    // 「ボルシャック速攻」→ 「ボルシャック」で検索 + 速攻制約。
    const s = deriveStrategy("ボルシャック速攻");
    expect(s.profile?.label).toContain("速攻");
    expect(s.core).toBe("ボルシャック");
  });

  it("戦略語が無いテーマは profile=null・コアはそのまま", () => {
    const s = deriveStrategy("ドラゴン");
    expect(s.profile).toBeNull();
    expect(s.core).toBe("ドラゴン");
  });

  it("複数の戦略語があれば最初に一致したものを主戦略にする", () => {
    // 「速攻」が先に定義されているので主戦略。両語ともコアから除かれる。
    const s = deriveStrategy("速攻コントロール");
    expect(s.profile?.label).toContain("速攻");
    expect(s.core).toBe("");
  });
});

describe.skipIf(!hasTestDb)("autoBuild 戦略制約とトリガー下限 (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });

  /** クリーチャー/呪文を1枚挿入。既定は非トリガーのクリーチャー。 */
  const card = (
    name: string,
    opts: { cost?: number; type?: string; trigger?: boolean; race?: string; text?: string } = {},
  ) =>
    sql`INSERT INTO cards (name, civilizations, cost, type, races, text, is_shield_trigger, official_id)
        VALUES (${name}, ${sql.json(["fire"])}, ${opts.cost ?? 3}, ${opts.type ?? "creature"},
                ${sql.json(opts.race ? [opts.race] : [])}, ${opts.text ?? ""},
                ${opts.trigger ?? false}, ${name})`;

  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("速攻: maxCost 未指定でも戦略から cost>5 が除外される", async () => {
    // 低コスト〜高コストのクリーチャーを用意。速攻なら 6以上は入らないはず。
    for (let i = 0; i < 12; i++) await card(`低${i}`, { cost: 2 + (i % 3) }); // cost 2-4
    for (let i = 0; i < 6; i++) await card(`高${i}`, { cost: 6 + (i % 2) }); // cost 6-7
    for (let i = 0; i < 8; i++)
      await card(`トリガー${i}`, { type: "spell", cost: 3, trigger: true });

    const r = await autoBuild("速攻", "original", { civilizations: ["fire"] });
    const rows =
      await sql`SELECT name, cost FROM cards WHERE name IN ${sql(r.entries.map((e) => e.name))}`;
    const maxCost = Math.max(...rows.map((x) => x.cost as number));
    expect(maxCost).toBeLessThanOrEqual(5);
    expect(r.strategy).toContain("速攻");
  });

  it("コントロール: 高コスト (7) のクリーチャーを締め出さない (maxCost の cap 無し)", async () => {
    // クリーチャーは高コスト(7)のみ。速攻なら maxCost5 で全滅するが、コントロールは cap 無しで採用できる。
    for (let i = 0; i < 8; i++) await card(`高竜${i}`, { cost: 7 });
    for (let i = 0; i < 10; i++)
      await card(`トリガー${i}`, { type: "spell", cost: 4, trigger: true });

    const r = await autoBuild("コントロール", "original", { civilizations: ["fire"] });
    const rows =
      await sql`SELECT name, cost, type FROM cards WHERE name IN ${sql(r.entries.map((e) => e.name))}`;
    const creatureCosts = r.entries.flatMap((e) => {
      const row = rows.find((x) => x.name === e.name);
      return (row?.type as string)?.includes("creature") ? [row!.cost as number] : [];
    });
    // 高コストクリーチャーが実際に採用されている (cap で締め出されていない)。
    expect(Math.max(...creatureCosts, 0)).toBeGreaterThanOrEqual(7);
  });

  it("トリガー下限: テーマがクリーチャーだけでも S・トリガーを8枚以上に補う (swap)", async () => {
    // テーマ「ドラゴン」に一致するのは非トリガーのクリーチャーだけ。40枚埋め切ってもトリガーを差し込む。
    for (let i = 0; i < 15; i++) await card(`竜${i}`, { cost: 3 + (i % 4), race: "ドラゴン" });
    // ドラゴンに一致しない S・トリガー呪文 (候補プール)。
    for (let i = 0; i < 10; i++)
      await card(`受け${i}`, { type: "spell", cost: 2 + (i % 3), trigger: true });

    const r = await autoBuild("ドラゴン", "original", { civilizations: ["fire"] });
    expect(r.totalCards).toBe(40);

    const rows =
      await sql`SELECT name, type, is_shield_trigger FROM cards WHERE name IN ${sql(r.entries.map((e) => e.name))}`;
    const meta = new Map(rows.map((x) => [x.name as string, x]));
    const triggers = r.entries.reduce(
      (s, e) => s + (meta.get(e.name)?.is_shield_trigger ? e.count : 0),
      0,
    );
    const creatures = r.entries.reduce(
      (s, e) => s + ((meta.get(e.name)?.type as string)?.includes("creature") ? e.count : 0),
      0,
    );
    expect(triggers).toBeGreaterThanOrEqual(8); // 下限を満たす
    expect(creatures).toBeGreaterThanOrEqual(22); // swap でクリーチャー下限を割らない
  });

  it("内部整合: autoBuild の出力を scoreDeck に通しても『トリガー/受け札不足』の警告が出ない", async () => {
    for (let i = 0; i < 15; i++) await card(`竜${i}`, { cost: 3 + (i % 4), race: "ドラゴン" });
    for (let i = 0; i < 10; i++)
      await card(`受け${i}`, { type: "spell", cost: 2 + (i % 3), trigger: true });

    const r = await autoBuild("ドラゴン", "original", { civilizations: ["fire"] });
    const score = await scoreDeck(
      parseDecklist(r.entries.map((e) => `${e.count} ${e.name}`).join("\n")),
    );

    expect(score.warnings.some((w) => w.includes("S・トリガーが"))).toBe(false);
    expect(score.warnings).not.toContain("受け札が少なく、攻撃に弱い構成です");
  });

  it("トリガー候補が無いプールでは 40枚を崩さない (下限を満たせなくても壊れない)", async () => {
    // トリガーが1枚も無い。ensureTriggerFloor は何もできないが、40枚は維持する。
    for (let i = 0; i < 15; i++) await card(`竜${i}`, { cost: 3, race: "ドラゴン" });
    const r = await autoBuild("ドラゴン", "original", { civilizations: ["fire"] });
    expect(r.totalCards).toBe(40);
  });
});
