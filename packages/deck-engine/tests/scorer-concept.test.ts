import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { parseDecklist } from "../src/parser.js";
import { scoreDeck } from "../src/scorer.js";

/**
 * デッキ戦略コンセプトによる減点緩和 (#130)。
 *
 * ループ/コンボ・コントロールは受けやフィニッシャーを**意図的に絞る**ことがある。
 * ビートダウン前提のテンプレで一律減点すると、まともなコンボデッキが不当に低スコアになる。
 * concept を推定できたときは該当の減点を軽くし、軽くしたことを警告で明示する。
 * ただし**ゼロにはしない** (本当に不足した悪いデッキを見逃さないため)。
 */
describe.skipIf(!hasTestDb)("コンセプトによる減点緩和 (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });
  beforeEach(async () => {
    await truncateAll(sql);
  });

  /** 高コスト・受けなしのカードを1枚入れる。text でコンボ信号の有無を切り替える。 */
  const card = (name: string, text: string, cost = 5) =>
    sql`INSERT INTO cards (name, civilizations, cost, type, races, text, tags, is_shield_trigger, official_id)
        VALUES (${name}, ${sql.json(["fire"])}, ${cost}, 'creature', ${sql.json([])},
                ${text}, ${sql.json([])}, false, ${name})`;

  /** コンボ信号あり/なしだけが違う、受け0・高コストの 40枚デッキを作る。 */
  async function seedDeck(comboText: boolean) {
    // **3種**のカードでコンボ信号の有無を切り替える (combo 判定は種類数 >= 3)。残り7種は無地。
    await card("エンジンA", comboText ? "この効果を無限に繰り返す" : "パワーを+1000する");
    await card("エンジンB", comboText ? "好きなだけ唱えてもよい" : "スピードアタッカーを得る");
    await card("エンジンC", comboText ? "コストを繰り返し軽減する" : "パワーを+2000する");
    for (let i = 0; i < 7; i++) await card(`無地${i}`, "");
    return parseDecklist(
      [
        "4 エンジンA",
        "4 エンジンB",
        "4 エンジンC",
        ...Array.from({ length: 7 }, (_, i) => `4 無地${i}`),
      ].join("\n"),
    );
  }

  it("コンボと推定されたら受け0の減点を緩和し、警告で意図的な可能性を明示する", async () => {
    const deck = await seedDeck(true);
    const score = await scoreDeck(deck);

    expect(score.concept).toBe("combo");
    // 受け0だが「攻撃に弱い」と断じない。コンボ型では意図的な可能性を明示する。
    expect(score.warnings.some((w) => w.includes("コンボ") && w.includes("意図的"))).toBe(true);
    expect(score.warnings).not.toContain("受け札が少なく、攻撃に弱い構成です");
  });

  it("同じ構成でもコンボ信号が無ければ unknown で、通常どおり減点・警告する", async () => {
    const deck = await seedDeck(false);
    const score = await scoreDeck(deck);

    expect(score.concept).toBe("unknown");
    // 緩和しない = 通常の厳しい警告が出る。
    expect(score.warnings).toContain("受け札が少なく、攻撃に弱い構成です");
  });

  it("コンボ緩和ありの方が、緩和なし (unknown) より高スコアになる", async () => {
    const comboDeck = await seedDeck(true);
    const comboScore = await scoreDeck(comboDeck);
    await truncateAll(sql);
    const plainDeck = await seedDeck(false);
    const plainScore = await scoreDeck(plainDeck);

    // 構成は同一 (コンボ信号テキストの有無だけ違う)。緩和のぶん combo の方が高い。
    expect(comboScore.overall).toBeGreaterThan(plainScore.overall);
  });

  it("超無限進化の進化デッキは combo と誤判定せず、緩和もしない (#137 実カード文面)", async () => {
    // 本番の実際の文面。素の「無限」を信号にすると2種6枚以上でこれが combo 扱いになり、受け0の
    // 減点が不当に緩和されていた。ループ文脈 (無限に) に絞ったので、進化デッキは unknown = 緩和なし。
    await card(
      "進化デーモン",
      "超無限進化：デーモン・コマンド・クリーチャー１体以上の上に置く。",
      8,
    );
    await card(
      "進化ドラゴン",
      "超無限墓地進化：クリーチャーを１体以上自分の墓地から選び重ねる。",
      7,
    );
    for (let i = 0; i < 8; i++) await card(`無地${i}`, "", 6);
    const deck = parseDecklist(
      [
        "4 進化デーモン",
        "4 進化ドラゴン",
        ...Array.from({ length: 8 }, (_, i) => `4 無地${i}`),
      ].join("\n"),
    );
    const score = await scoreDeck(deck);

    expect(score.concept).not.toBe("combo");
    // 緩和されていない = 受け0の通常の厳しい警告が出る (combo 扱いなら緩和され警告文が変わっていた)。
    expect(score.warnings).toContain("受け札が少なく、攻撃に弱い構成です");
  });
});
