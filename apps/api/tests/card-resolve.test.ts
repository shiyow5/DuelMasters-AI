import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { resolveCardImages } from "../src/card.js";
import app from "../src/app.js";

/**
 * カード名 → 画像URL (#129)。
 *
 * デッキが実際に持つカード名を引くので、`resolveMainCards` (#122, 部分一致) と違い
 * **正規化した完全一致**であること、そして中黒/全角スペースのゆれを吸収することを固定する。
 * 引けない名前・画像なしカードは null で返し、**入力の全名前**が応答に含まれることも固定する。
 */
describe.skipIf(!hasTestDb)("resolveCardImages (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => {
    enableAppDb();
    // ルートレベルのテスト (下記) を内部キーで通すため。
    process.env.INTERNAL_API_KEY = "test-key";
  });
  afterAll(async () => {
    await sql.end();
  });

  /** POST /api/card/resolve を内部キーで叩く (Workers env は第3引数 = {} で Node フォールバック)。 */
  function postResolve(body: unknown) {
    return app.request(
      "/api/card/resolve",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": "test-key",
          "X-User-Id": "test",
        },
        body: JSON.stringify(body),
      },
      {},
    );
  }

  const card = (name: string, image: string | null = `https://img/${name}.jpg`) =>
    sql`INSERT INTO cards (name, civilizations, cost, type, races, text, card_image_url, official_id)
        VALUES (${name}, ${sql.json(["fire"])}, 5, 'creature', ${sql.json([])}, '', ${image}, ${name})`;

  beforeEach(async () => {
    await truncateAll(sql);
    await card("ボルシャック・ドラゴン");
    await card("王導聖霊 アルファディオス");
    // 英数コードを **半角** で持つカード。全角で貼られても引けるか (NFKC) の検証用。
    await card("接続 CS-20");
    await card("画像なしカード", null);
  });

  it("完全一致で画像URLを引く", async () => {
    const map = await resolveCardImages(["ボルシャック・ドラゴン"]);
    expect(map.get("ボルシャック・ドラゴン")).toBe("https://img/ボルシャック・ドラゴン.jpg");
  });

  it("中黒のゆれを吸収する (#111 と同じ手当て)", async () => {
    // ユーザーが中黒抜きで貼っても引ける。
    const map = await resolveCardImages(["ボルシャックドラゴン"]);
    expect(map.get("ボルシャックドラゴン")).toContain("http");
  });

  it("全角スペースのゆれを吸収する", async () => {
    const map = await resolveCardImages(["王導聖霊アルファディオス"]);
    expect(map.get("王導聖霊アルファディオス")).toContain("http");
  });

  it("全角/半角の英数のゆれを吸収する (NFKC。《接続 CS-20》を全角で引く)", async () => {
    // DB は半角「CS-20」で持つが、ユーザーが全角「ＣＳ－２０」で貼っても引ける。
    // agent の normalizeCardName が NFKC を使うのと同じクラスの手当て (#111 系)。
    const map = await resolveCardImages(["接続ＣＳ－２０"]);
    expect(map.get("接続ＣＳ－２０")).toContain("http");
  });

  it("引けない名前は null (無関係カードを出さない)", async () => {
    const map = await resolveCardImages(["存在しないカード"]);
    // 入力名は必ず応答に含める。値は null。
    expect(map.has("存在しないカード")).toBe(true);
    expect(map.get("存在しないカード")).toBeNull();
  });

  it("画像が無いカードは null (壊れた画像を出さない)", async () => {
    const map = await resolveCardImages(["画像なしカード"]);
    expect(map.get("画像なしカード")).toBeNull();
  });

  it("入力の全名前について1エントリ返す (見つかった/見つからないが混在)", async () => {
    const map = await resolveCardImages([
      "ボルシャック・ドラゴン",
      "存在しないカード",
      "画像なしカード",
    ]);
    expect(map.size).toBe(3);
    expect(map.get("ボルシャック・ドラゴン")).toContain("http");
    expect(map.get("存在しないカード")).toBeNull();
    expect(map.get("画像なしカード")).toBeNull();
  });

  it("重複した名前はまとめる", async () => {
    const map = await resolveCardImages(["ボルシャック・ドラゴン", "ボルシャック・ドラゴン"]);
    expect(map.size).toBe(1);
    expect(map.get("ボルシャック・ドラゴン")).toContain("http");
  });

  it("空配列でも落ちない", async () => {
    expect((await resolveCardImages([])).size).toBe(0);
  });

  it("ルート: 認証済みで叩くと {cards:[{name,image_url}]} を返す", async () => {
    const res = await postResolve({ names: ["ボルシャック・ドラゴン", "存在しないカード"] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      cards: Array<{ name: string; image_url: string | null }>;
    };
    expect(json.cards).toEqual(
      expect.arrayContaining([
        { name: "ボルシャック・ドラゴン", image_url: expect.stringContaining("http") },
        { name: "存在しないカード", image_url: null },
      ]),
    );
  });

  it("ルート: names が空だと 400 (DB に到達しない)", async () => {
    const res = await postResolve({ names: [] });
    expect(res.status).toBe(400);
  });
});
