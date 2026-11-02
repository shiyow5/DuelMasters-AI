import { describe, it, expect } from "vitest";
import { parseDecklist } from "../src/parser.js";
import {
  checkRegulationNames,
  listRestrictedInDeck,
  loadRegulations,
  regulationTagForCard,
  restrictionLimitLabel,
} from "../src/regulation-check.js";
import { buildRegulationIndex, type RegulationRow } from "../src/regulation-index.js";

/** #178: 殿堂の区分を名前で引く (DB なし) */

const REGS: RegulationRow[] = [
  { card_name: "ボルシャック・ドラゴン", restriction_type: "殿堂入り" },
  { card_name: "ヘブンズ・ゲート", restriction_type: "プレミアム殿堂" },
  { card_name: "龍装艦 チェンジザ / 六奇怪の四 ～土を割る逆瀧～", restriction_type: "殿堂入り" },
  { card_name: "ジョラゴン・ビッグ1", restriction_type: "殿堂入り" },
  { card_name: "ボルメテウス・ホワイト・ドラゴン", restriction_type: "プレミアム殿堂コンビ" },
];

/** cards テーブルで見つかったカード名 (規制なしのカードも含む) */
const CARDS = [
  "ボルシャック・ドラゴン",
  "ヘブンズ・ゲート",
  "スパイラル・ゲート",
  "龍装艦 チェンジザ / 六奇怪の四 ～土を割る逆瀧～",
  "ジョラゴン・ビッグ1",
  "ボルメテウス・ホワイト・ドラゴン",
  "青銅の鎧",
];

function one(name: string, cards: readonly string[] = CARDS) {
  const [r] = checkRegulationNames([name], REGS, cards);
  return r!;
}

describe("checkRegulationNames: 区分", () => {
  it("殿堂入り", () => {
    expect(one("ボルシャック・ドラゴン")).toMatchObject({
      status: "restricted",
      restriction: "殿堂入り",
    });
  });

  it("プレミアム殿堂", () => {
    expect(one("ヘブンズ・ゲート")).toMatchObject({
      status: "restricted",
      restriction: "プレミアム殿堂",
    });
  });

  it("プレミアム殿堂コンビ", () => {
    expect(one("ボルメテウス・ホワイト・ドラゴン")).toMatchObject({
      status: "restricted",
      restriction: "プレミアム殿堂コンビ",
    });
  });

  it("制限なし (cards にあり、regulations に無い)", () => {
    // No.32: スパイラル・ゲートは殿堂ではない。記憶で殿堂扱いさせない根拠になる。
    expect(one("スパイラル・ゲート")).toEqual({
      name: "スパイラル・ゲート",
      status: "unrestricted",
    });
  });

  it("複数の名前を順番どおりに返す", () => {
    const r = checkRegulationNames(["スパイラル・ゲート", "ヘブンズ・ゲート"], REGS, CARDS);
    expect(r.map((x) => x.status)).toEqual(["unrestricted", "restricted"]);
    expect(r.map((x) => x.name)).toEqual(["スパイラル・ゲート", "ヘブンズ・ゲート"]);
  });
});

describe("checkRegulationNames: 表記ゆれ (validateRegulation と同じ照合)", () => {
  it("中黒なしでも当たる", () => {
    expect(one("ボルシャックドラゴン")).toMatchObject({
      status: "restricted",
      restriction: "殿堂入り",
      matchedName: "ボルシャック・ドラゴン",
    });
  });

  it("半角カナでも当たる", () => {
    expect(one("ﾍﾌﾞﾝｽﾞ･ｹﾞｰﾄ")).toMatchObject({
      status: "restricted",
      restriction: "プレミアム殿堂",
    });
  });

  it("《》・空白付きでも当たる", () => {
    expect(one("《 ボルシャック・ドラゴン 》")).toMatchObject({ restriction: "殿堂入り" });
  });

  it("ツインパクトの片面名でも当たる", () => {
    expect(one("龍装艦 チェンジザ")).toMatchObject({
      status: "restricted",
      restriction: "殿堂入り",
      matchedName: "龍装艦 チェンジザ / 六奇怪の四 ～土を割る逆瀧～",
    });
    expect(one("六奇怪の四 ～土を割る逆瀧～")).toMatchObject({ restriction: "殿堂入り" });
  });

  it("制限なしのカードも中黒なし・半角カナで「制限なし」と判定できる", () => {
    expect(one("スパイラルゲート").status).toBe("unrestricted");
    expect(one("ｽﾊﾟｲﾗﾙ･ｹﾞｰﾄ").status).toBe("unrestricted");
  });

  it("制限なしのツインパクトは片面名でも「制限なし」", () => {
    const cards = [...CARDS, "未規制の龍 / 未規制の呪文"];
    expect(one("未規制の龍", cards).status).toBe("unrestricted");
  });
});

describe("checkRegulationNames: カード名を特定できないとき", () => {
  it("略称は「制限なし」と言わず、名前を含むカードを区分つきで候補に出す (No.33)", () => {
    const r = one("ジョラゴン");
    expect(r.status).toBe("unknown_name");
    if (r.status !== "unknown_name") return;
    expect(r.candidates).toContainEqual({ name: "ジョラゴン・ビッグ1", restriction: "殿堂入り" });
  });

  it("どこにも無い名前は候補なしの unknown_name (制限なしにしない)", () => {
    const r = one("存在しないカードXYZ");
    expect(r).toEqual({ name: "存在しないカードXYZ", status: "unknown_name", candidates: [] });
  });

  it("cards を引けなかった (空) ときも、規制に当たる名前は区分を返し、それ以外は unknown_name", () => {
    expect(one("ボルシャック・ドラゴン", []).status).toBe("restricted");
    expect(one("スパイラル・ゲート", []).status).toBe("unknown_name");
  });
});

describe("listRestrictedInDeck (#178 (c))", () => {
  it("殿堂入りを1枚だけ入れたデッキでも列挙する (違反がなくても返す)", () => {
    const deck = parseDecklist("1 ボルシャック・ドラゴン\n4 青銅の鎧\n4 スパイラル・ゲート");
    expect(listRestrictedInDeck(deck, REGS)).toEqual([
      { name: "ボルシャック・ドラゴン", restriction: "殿堂入り", count: 1, limit: "1枚まで" },
    ]);
  });

  it("規制カードが無ければ空配列", () => {
    const deck = parseDecklist("4 青銅の鎧\n4 スパイラル・ゲート");
    expect(listRestrictedInDeck(deck, REGS)).toEqual([]);
  });

  it("表記ゆれ・ツインパクト片面で書いた行も同じ規制として合算する", () => {
    const deck = parseDecklist(
      "1 龍装艦 チェンジザ / 六奇怪の四 ～土を割る逆瀧～\n1 龍装艦チェンジザ\n1 ﾍﾌﾞﾝｽﾞｹﾞｰﾄ",
    );
    expect(listRestrictedInDeck(deck, REGS)).toEqual([
      {
        name: "龍装艦 チェンジザ / 六奇怪の四 ～土を割る逆瀧～」「龍装艦チェンジザ",
        restriction: "殿堂入り",
        count: 2,
        limit: "1枚まで",
      },
      {
        name: "ﾍﾌﾞﾝｽﾞｹﾞｰﾄ",
        restriction: "プレミアム殿堂",
        count: 1,
        limit: "デッキに入れられない",
      },
    ]);
  });
});

describe("regulationTagForCard (#178 (b))", () => {
  const index = buildRegulationIndex(REGS);
  it("区分を [ ] で付ける", () => {
    expect(regulationTagForCard("ボルシャック・ドラゴン", index)).toBe("[殿堂入り]");
    expect(regulationTagForCard("ヘブンズ・ゲート", index)).toBe("[プレミアム殿堂]");
    expect(regulationTagForCard("ボルメテウス・ホワイト・ドラゴン", index)).toBe(
      "[プレミアム殿堂コンビ]",
    );
    expect(regulationTagForCard("スパイラル・ゲート", index)).toBe("[制限なし]");
  });

  it("regulations を読めなかったら「確認できず」(制限なしと書かない)", () => {
    expect(regulationTagForCard("スパイラル・ゲート", null)).toBe("[殿堂区分: 確認できず]");
  });
});

describe("restrictionLimitLabel", () => {
  it("区分ごとの枚数", () => {
    expect(restrictionLimitLabel("殿堂入り")).toBe("1枚まで");
    expect(restrictionLimitLabel("プレミアム殿堂")).toBe("デッキに入れられない");
    expect(restrictionLimitLabel("制限なし")).toBe("4枚まで");
  });
});

describe("loadRegulations (DB 無し, #178 (e))", () => {
  it("接続できなければ例外を投げず ok:false を返す", async () => {
    const r = await loadRegulations("original");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("接続できませんでした");
  });
});
