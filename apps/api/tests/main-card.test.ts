import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { resolveMainCards } from "../src/main-card.js";

/**
 * アーキタイプ名 → メインカードの画像 (#122)。
 *
 * 純関数 (`archetypeCoreName`) のテストだけでは「本番のカード名に当たるか」は分からない。
 * **実 DB で照合が成立すること**を固定する。
 */
describe.skipIf(!hasTestDb)("resolveMainCards (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => enableAppDb());
  afterAll(async () => {
    await sql.end();
  });

  const card = (
    name: string,
    image: string | null = `https://img/${name}.jpg`,
    races: string[] = [],
    cost = 6,
  ) =>
    sql`INSERT INTO cards (name, civilizations, cost, type, races, text, card_image_url, official_id)
        VALUES (${name}, ${sql.json(["light"])}, ${cost}, 'creature', ${sql.json(races)}, '', ${image}, ${name})`;

  beforeEach(async () => {
    await truncateAll(sql);
    await card("聖霊王アルファディオス");
    await card("王導聖霊 アルファディオス");
    await card("我我我ガイアール・ブランド");
    await card("MEGATOON・ドッカンデイヤー");
    await card("ゴールド・ウィリデ");
    // 種族「ドラゴン」を持つ本物のドラゴン。**名前に「ドラゴン」は含まない** (#131)。
    await card("ボルシャック・NEX", "https://img/nex.jpg", ["ドラゴン"], 7);
    await card("小さな竜", "https://img/small.jpg", ["ドラゴン"], 2);
    // 名前に「ドラゴン」を含むが**種族はドラゴンでない**カード (名前一致の誤爆元)
    await card("ドラゴン・ラボ", "https://img/dragonlab.jpg", ["メカ"]);
    // 戦略名が名前の真ん中に埋まっているカード (誤検出の元)
    await card("消火機装コントロール・ファイア");
  });

  it("色の接頭辞を落として引く (トリーヴァアルファディオス → 《聖霊王アルファディオス》)", async () => {
    const map = await resolveMainCards(["トリーヴァアルファディオス"]);
    expect(map.get("トリーヴァアルファディオス")?.name).toBe("聖霊王アルファディオス");
    expect(map.get("トリーヴァアルファディオス")?.image_url).toContain("http");
  });

  it("候補が複数あれば名前が短い方を採る", () => {
    // 《聖霊王アルファディオス》と《王導聖霊 アルファディオス》。素の名前に近い方が
    // そのアーキタイプの象徴である可能性が高い。
    return resolveMainCards(["トリーヴァアルファディオス"]).then((map) => {
      expect(map.get("トリーヴァアルファディオス")?.name).toBe("聖霊王アルファディオス");
    });
  });

  it("**中黒の有無を問わない** (#111 と同じ手当て)", async () => {
    const map = await resolveMainCards(["赤単我我我"]);
    expect(map.get("赤単我我我")?.name).toBe("我我我ガイアール・ブランド");
  });

  it("接頭辞が無いアーキタイプも引ける", async () => {
    const map = await resolveMainCards(["ウィリデ"]);
    expect(map.get("ウィリデ")?.name).toBe("ゴールド・ウィリデ");
  });

  it("**引けないアーキタイプには何も返さない** (無関係なカードを出さない)", async () => {
    // 「ドッコイループ」はコンボ名、「メタビート革命チェンジ」はキーワード能力名。
    // **そもそも単一カード名ではない**ので、原理的に対応付けられない。
    const map = await resolveMainCards(["ドッコイループ", "メタビート革命チェンジ"]);
    expect(map.get("ドッコイループ")).toBeUndefined();
    expect(map.get("メタビート革命チェンジ")).toBeUndefined();
  });

  /**
   * **無関係なカード画像を出すのは、何も出さないより悪い。**
   *
   * 本番データで実際に踏んだ誤検出:
   *   5Cコントロール → 《消火機装コントロール・ファイア》   ← 「コントロール」は戦略名
   *   5Cドラゴン    → 《ドラゴン・ラボ》                  ← 「ドラゴン」は種族名
   */
  it("**戦略名は弾く** (5Cコントロール → 《消火機装コントロール・ファイア》を出さない)", async () => {
    const map = await resolveMainCards(["5Cコントロール"]);
    expect(map.get("5Cコントロール")).toBeUndefined();
  });

  /**
   * 種族ベースのアーキタイプ (#131)。
   *
   * 以前は「代表カードを1枚選ぶ根拠が無い」として**空欄**にしていた。しかし本番の主要ティアで
   * 「デスパペット」(種族) 等が空欄のままで、ユーザーから「メインカード表示が解決していない」と
   * 報告された。**その種族のカードは「無関係なカード」ではない**ので、#122 の
   * 「無関係カードより空欄」の原則には反しない。種族の「顔」= 最も重いカードを出す。
   */
  it("**種族ベースのアーキタイプはその種族の代表カードを出す** (最も重いカード)", async () => {
    const map = await resolveMainCards(["5Cドラゴン"]);
    // ドラゴン種族のうちコスト最大 (7) の《ボルシャック・NEX》。《小さな竜》(2) ではない。
    expect(map.get("5Cドラゴン")?.name).toBe("ボルシャック・NEX");
  });

  it("種族一致は名前一致に勝つ (《ドラゴン・ラボ》を出さない)", async () => {
    // 《ドラゴン・ラボ》は名前に「ドラゴン」を含むだけで**種族はドラゴンでない**。
    // 種族で解決できるアーキタイプに、名前だけ似た無関係カードを当てない。
    const map = await resolveMainCards(["5Cドラゴン"]);
    expect(map.get("5Cドラゴン")?.name).not.toBe("ドラゴン・ラボ");
  });

  it("名前の途中に一致するだけでも採る (先頭/末尾の一致を優先する)", async () => {
    // 《頂上連結 ロッド・ゾージア5th》のように、コア名が接尾辞の前に埋まることがある。
    // 先頭/末尾しか認めないと、こうした正当な一致を落とす (実測で確認)。
    await card("頂上連結 ロッド・ゾージア5th");
    const map = await resolveMainCards(["5Cゾージア"]);
    expect(map.get("5Cゾージア")?.name).toBe("頂上連結 ロッド・ゾージア5th");
  });

  it("画像が無いカードは採らない (壊れた画像を出さない)", async () => {
    await truncateAll(sql);
    await card("画像なしカード", null);
    const map = await resolveMainCards(["画像なしカード"]);
    expect(map.get("画像なしカード")).toBeUndefined();
  });

  it("1文字のコア名は捨てる (どのカード名にも当たって誤爆する)", async () => {
    const map = await resolveMainCards(["赤単A"]);
    expect(map.size).toBe(0);
  });

  it("空配列でも落ちない", async () => {
    expect((await resolveMainCards([])).size).toBe(0);
  });

  it("まとめて引ける (1リクエスト1クエリ)", async () => {
    const map = await resolveMainCards(["赤単我我我", "アナカラーデイヤー", "ウィリデ"]);
    expect(map.size).toBe(3);
  });
});
