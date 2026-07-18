import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { parseDecklist } from "../src/parser.js";
import { scoreDeck } from "../src/scorer.js";

/**
 * 種族トライバルの軽量シナジー信号 (#141)。
 *
 * scoreDeck は支配種族が過半を占めるとき synergy を返し、種族シナジーが期待できる旨を
 * suggestions に添える。**採点 (overall) は動かさない** (情報提供のみ)。
 */
describe.skipIf(!hasTestDb)("種族トライバルシナジー (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });
  beforeEach(async () => {
    await truncateAll(sql);
  });

  const card = (name: string, races: string[], cost = 3) =>
    sql`INSERT INTO cards (name, civilizations, cost, type, races, text, tags, is_shield_trigger, official_id)
        VALUES (${name}, ${sql.json(["fire"])}, ${cost}, 'creature', ${sql.json(races)},
                '', ${sql.json([])}, false, ${name})`;

  it("支配種族が過半なら synergy を返し、シナジー期待の提案を添える", async () => {
    // 8種 × 各4枚 = 32枚がジョーカーズ、残り2種8枚は無種族。ジョーカーズ 32/40 = 0.8。
    for (let i = 0; i < 8; i++) await card(`ジョーカー${i}`, ["ジョーカーズ"]);
    for (let i = 0; i < 2; i++) await card(`無種族${i}`, []);
    const deck = parseDecklist(
      [
        ...Array.from({ length: 8 }, (_, i) => `4 ジョーカー${i}`),
        ...Array.from({ length: 2 }, (_, i) => `4 無種族${i}`),
      ].join("\n"),
    );
    const score = await scoreDeck(deck);

    expect(score.synergy?.tribe).toBe("ジョーカーズ");
    expect(score.synergy?.count).toBe(32);
    expect(
      score.suggestions.some((s) => s.includes("ジョーカーズ") && s.includes("シナジー")),
    ).toBe(true);
  });

  it("種族がバラけたデッキは synergy が null で、シナジー提案も出ない", async () => {
    for (let i = 0; i < 10; i++) await card(`混成${i}`, [`種族${i % 5}`]); // 5種族が各8枚 = 0.2
    const deck = parseDecklist(Array.from({ length: 10 }, (_, i) => `4 混成${i}`).join("\n"));
    const score = await scoreDeck(deck);

    expect(score.synergy).toBeNull();
    expect(score.suggestions.some((s) => s.includes("シナジー"))).toBe(false);
  });

  it("種族シナジーは overall を動かさない (情報提供のみ)", async () => {
    // 同一構成で種族だけ差し替える。トライバル版と非トライバル版で overall が一致することを確認。
    for (let i = 0; i < 8; i++) await card(`T${i}`, ["ハンター"]);
    for (let i = 0; i < 2; i++) await card(`X${i}`, []);
    const tribalDeck = parseDecklist(
      [
        ...Array.from({ length: 8 }, (_, i) => `4 T${i}`),
        ...Array.from({ length: 2 }, (_, i) => `4 X${i}`),
      ].join("\n"),
    );
    const tribalScore = await scoreDeck(tribalDeck);

    await truncateAll(sql);
    // 種族をすべて別々にしてトライバルを崩す (それ以外は同一)。
    for (let i = 0; i < 8; i++) await card(`T${i}`, [`個別${i}`]);
    for (let i = 0; i < 2; i++) await card(`X${i}`, []);
    const plainDeck = parseDecklist(
      [
        ...Array.from({ length: 8 }, (_, i) => `4 T${i}`),
        ...Array.from({ length: 2 }, (_, i) => `4 X${i}`),
      ].join("\n"),
    );
    const plainScore = await scoreDeck(plainDeck);

    expect(tribalScore.synergy?.tribe).toBe("ハンター");
    expect(plainScore.synergy).toBeNull();
    // 加点していないので overall は一致する。
    expect(tribalScore.overall).toBe(plainScore.overall);
  });
});
