import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { parseDecklist } from "../src/parser.js";
import { scoreDeck } from "../src/scorer.js";

/**
 * 役割バランス (#120)。
 *
 * ## 本番で起きていたこと
 *
 * `cards.tags` が **11563件すべて空**だった (ingest-tags が一度も走っていなかった)。
 * scorer は `roleBalance["受け"] ?? 0` を見るので、**タグが未整備でも 0 と読む**。結果:
 *
 * - S・トリガーを **20枚**積んだデッキに「受け札が少なく、攻撃に弱い構成です」と警告
 * - `calculateOverallScore` が 受け=0 で -15、フィニッシャー=0 で -10 →
 *   **どんなデッキも無条件に 25点減点**
 *
 * **「データが無い」と「0枚である」は違う。** 混同すると、正しいデッキに嘘の診断を返す。
 */

describe.skipIf(!hasTestDb)("役割バランス (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });

  /** カードを1枚入れる。tags を指定しなければ空 (= 本番の現状)。 */
  const card = (
    name: string,
    opts: { cost?: number; trigger?: boolean; tags?: string[]; type?: string } = {},
  ) =>
    sql`INSERT INTO cards (name, civilizations, cost, type, races, text, tags, is_shield_trigger, official_id)
        VALUES (${name}, ${sql.json(["light"])}, ${opts.cost ?? 3}, ${opts.type ?? "creature"},
                ${sql.json([])}, '', ${sql.json(opts.tags ?? [])}, ${opts.trigger ?? false}, ${name})`;

  /** 受けもドローもフィニッシャーも揃った、まともな40枚デッキ。 */
  async function seedGoodDeck(tags: boolean) {
    for (let i = 0; i < 5; i++) {
      await card(`受け${i}`, { trigger: true, cost: 5, tags: tags ? ["受け"] : [] });
    }
    for (let i = 0; i < 3; i++) {
      await card(`ドロー${i}`, { cost: 3, tags: tags ? ["ドロー"] : [] });
    }
    await card("フィニッシャー0", { cost: 8, tags: tags ? ["フィニッシャー"] : [] });
    await card("初動0", { cost: 2, tags: tags ? ["初動"] : [] });
    return parseDecklist(
      [
        ...Array.from({ length: 5 }, (_, i) => `4 受け${i}`),
        ...Array.from({ length: 3 }, (_, i) => `4 ドロー${i}`),
        "4 フィニッシャー0",
        "4 初動0",
      ].join("\n"),
    );
  }

  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("**タグが未整備なら、役割バランスの警告を出さない** (本番で出ていた誤警告)", async () => {
    // S・トリガー20枚・ドロー12枚のデッキ。タグだけが空 = 本番の状態。
    const deck = await seedGoodDeck(false);
    const score = await scoreDeck(deck);

    expect(score.triggerCount).toBe(20); // is_shield_trigger 列は正しく読めている
    expect(score.warnings).not.toContain("受け札が少なく、攻撃に弱い構成です");
    expect(score.suggestions).not.toContain("S・トリガーやブロッカーなどの受け札を追加しましょう");
    expect(score.suggestions).not.toContain("ドローソースを増やしてリソース確保を安定させましょう");
  });

  it("**タグが未整備なら、役割バランスで減点しない** (無条件 25点減点をやめる)", async () => {
    const deck = await seedGoodDeck(false);
    const score = await scoreDeck(deck);
    // タグ有りの同じデッキと同じ点数になること (役割による増減がゼロ)。
    await truncateAll(sql);
    const tagged = await seedGoodDeck(true);
    const taggedScore = await scoreDeck(tagged);

    expect(score.overall).toBe(taggedScore.overall);
  });

  it("**評価できていないことは隠さない** (黙って警告を消すだけにしない)", async () => {
    // #109 と同じ思想。データが無いなら「無い」と言う。黙ると「評価済み」に見える。
    const deck = await seedGoodDeck(false);
    const score = await scoreDeck(deck);
    expect(score.warnings.join()).toContain("役割");
  });

  /**
   * **受け札はタグを待たない** (#120)。
   *
   * `is_shield_trigger` はカードの列で、ブロッカー等のキーワードもテキストにある。
   * カード自身の情報だけで判定できるものを、派生データ (tags) 経由で見に行くから壊れた。
   * ここを直接参照にした以上、タグの有無に関わらず受け札の判定は常に正しい。
   */
  it("タグが無くても、S・トリガーが少なければ受け札不足を正しく警告する", async () => {
    // S・トリガー0枚・ブロッカー0枚。タグも無い。**これは本当に受け札が少ない。**
    for (let i = 0; i < 10; i++) {
      await card(`殴り${i}`, { cost: 4, tags: [] });
    }
    const deck = parseDecklist(Array.from({ length: 10 }, (_, i) => `4 殴り${i}`).join("\n"));
    const score = await scoreDeck(deck);

    expect(score.warnings).toContain("受け札が少なく、攻撃に弱い構成です");
  });

  it("タグが無くても、ブロッカーは受け札として数える (テキストから判定)", async () => {
    // S・トリガーではないがブロッカー。tags は空。
    for (let i = 0; i < 10; i++) {
      await sql`INSERT INTO cards (name, civilizations, cost, type, races, text, tags, is_shield_trigger, official_id)
                VALUES (${"壁" + i}, ${sql.json(["light"])}, 3, 'creature', ${sql.json([])},
                        'ブロッカー', ${sql.json([])}, false, ${"壁" + i})`;
    }
    const deck = parseDecklist(Array.from({ length: 10 }, (_, i) => `4 壁${i}`).join("\n"));
    const score = await scoreDeck(deck);

    expect(score.warnings).not.toContain("受け札が少なく、攻撃に弱い構成です");
  });

  it("タグがあれば、本当に受けが少ないデッキには警告する", async () => {
    // 受け0・ドロー0のデッキ。タグはある = データはある。今度は正しく警告すべき。
    for (let i = 0; i < 10; i++) {
      await card(`殴り${i}`, { cost: 4, tags: ["除去"] });
    }
    const deck = parseDecklist(Array.from({ length: 10 }, (_, i) => `4 殴り${i}`).join("\n"));
    const score = await scoreDeck(deck);

    expect(score.warnings).toContain("受け札が少なく、攻撃に弱い構成です");
    expect(score.suggestions).toContain("ドローソースを増やしてリソース確保を安定させましょう");
  });

  it("タグがあれば roleBalance が埋まる", async () => {
    const deck = await seedGoodDeck(true);
    const score = await scoreDeck(deck);
    expect(score.roleBalance["受け"]).toBe(20);
    expect(score.roleBalance["ドロー"]).toBe(12);
  });
});
