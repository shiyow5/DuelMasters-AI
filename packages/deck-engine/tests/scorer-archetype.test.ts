import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { parseDecklist } from "../src/parser.js";
import { scoreDeck } from "../src/scorer.js";

/**
 * アーキタイプ別採点 (#140)。
 *
 * 単一の DECK_GUIDELINES を全デッキに当てると、アグロが低トリガーで一律減点される。
 * scoreDeck はアーキタイプ (aggro/midrange/control) を推定し、ARCHETYPE_GUIDELINES で
 * S・トリガー/低コストの目標を切り替える。**緩める方向のみ** (midrange/unknown は現行と同値)。
 *
 * ここでは「同じ 6 枚トリガーでも aggro なら無警告・midrange なら警告」という**対比**で、
 * 閾値がアーキタイプごとに切り替わっていることを直接確かめる (Issue #140 の受け入れ基準)。
 */
describe.skipIf(!hasTestDb)("アーキタイプ別採点 (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });
  beforeEach(async () => {
    await truncateAll(sql);
  });

  /** カードを1枚登録する。type / cost / S・トリガーを指定できる。 */
  const card = (
    name: string,
    opts: { cost?: number; type?: string; trigger?: boolean; text?: string } = {},
  ) =>
    sql`INSERT INTO cards (name, civilizations, cost, type, races, text, tags, is_shield_trigger, official_id)
        VALUES (${name}, ${sql.json(["fire"])}, ${opts.cost ?? 2}, ${opts.type ?? "creature"},
                ${sql.json([])}, ${opts.text ?? ""}, ${sql.json([])}, ${opts.trigger ?? false}, ${name})`;

  it("低トリガー(6枚)の火アグロは一律減点されない: archetype=aggro でトリガー警告が出ない", async () => {
    // 全てクリーチャー・コスト1〜3 = beatdown → aggro。S・トリガーは 6 枚 (=aggro の目安)。
    await card("trigA", { cost: 2, trigger: true });
    await card("trigB", { cost: 3, trigger: true });
    for (let i = 0; i < 9; i++) await card(`atk${i}`, { cost: i < 5 ? 1 : 2 });

    // 3+3 (トリガー6) + 8種×4 + 1種×2 (攻撃34) = 40。
    const deck = parseDecklist(
      ["3 trigA", "3 trigB", ...Array.from({ length: 8 }, (_, i) => `4 atk${i}`), "2 atk8"].join(
        "\n",
      ),
    );
    const score = await scoreDeck(deck);

    expect(score.archetype).toBe("aggro");
    expect(score.triggerCount).toBe(6);
    // aggro の目安は 6 枚。6 枚あるのでトリガー不足の警告は出ない (=一律減点されない)。
    expect(score.warnings.some((w) => w.includes("S・トリガー"))).toBe(false);
  });

  it("同じ 6 枚トリガーでも midrange なら警告が出る (閾値がアーキタイプで切り替わる証拠)", async () => {
    // クリーチャー比 0.5・平均コスト中程度 = midrange。トリガーは同じ 6 枚だが midrange 目安は 8。
    await card("mtrigA", { cost: 4, trigger: true, type: "spell" });
    await card("mtrigB", { cost: 5, trigger: true, type: "spell" });
    for (let i = 0; i < 5; i++) await card(`mcre${i}`, { cost: 5, type: "creature" });
    for (let i = 0; i < 3; i++)
      await card(`mspl${i}`, { cost: 4, type: "spell", text: "マナを増やす" });

    // トリガー6 + クリーチャー20 (5種×4) + 呪文14 (6+4+4) = 40。creatureRatio = 0.5。
    const deck = parseDecklist(
      [
        "3 mtrigA",
        "3 mtrigB",
        ...Array.from({ length: 5 }, (_, i) => `4 mcre${i}`),
        "6 mspl0",
        "4 mspl1",
        "4 mspl2",
      ].join("\n"),
    );
    const score = await scoreDeck(deck);

    expect(score.archetype).toBe("midrange");
    expect(score.triggerCount).toBe(6);
    // midrange は現行の 8 枚目安のまま。6 枚では不足警告が出る (=緩めていない=回帰なし)。
    expect(score.warnings.some((w) => w.includes("S・トリガー") && w.includes("推奨: 8枚"))).toBe(
      true,
    );
  });

  it("control は低コストを絞っても低コスト不足の警告を出さない (低コスト目標だけ緩和)", async () => {
    // クリーチャー0・除去12・受け8 = control。低コスト(3以下)は 12 枚 = 現行目安 15 未満だが
    // control 目安 8 以上なので警告しない。
    for (let i = 0; i < 3; i++)
      await card(`crm${i}`, { cost: 5, type: "spell", text: "相手のクリーチャーを1体破壊する" });
    for (let i = 0; i < 2; i++)
      await card(`sgd${i}`, { cost: 4, type: "spell", trigger: true, text: "相手を止める" });
    await card("lowdraw", { cost: 2, type: "spell", text: "カードを2枚引く" });
    await card("filler", { cost: 6, type: "spell", text: "山札を見る" });

    // 除去12 (3種×4, cost5) + 受け8 (2種×4, cost4) + 低コスト12 (cost2) + 中コスト8 (cost6) = 40。
    const deck = parseDecklist(
      ["4 crm0", "4 crm1", "4 crm2", "4 sgd0", "4 sgd1", "12 lowdraw", "8 filler"].join("\n"),
    );
    const score = await scoreDeck(deck);

    expect(score.archetype).toBe("control");
    expect(score.costCurve.low).toBe(12);
    // 低コスト 12 は現行目安 15 未満だが、control 目安 8 以上なので警告しない。
    expect(score.warnings.some((w) => w.includes("低コスト"))).toBe(false);
  });
});
