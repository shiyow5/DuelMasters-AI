import { describe, it, expect } from "vitest";
import { parseDecklist } from "../src/parser.js";
import { validateRegulation, checkRestrictions } from "../src/validator.js";
import { regulationNameKey, mergeEntriesByName, twinpactSideKeys } from "../src/card-name.js";

// DATABASE_URL 無しで実行される前提 (vitest.config.ts で強制)。
// 殿堂チェックはスキップされ、固定の警告文が返る。
const DB_SKIP_WARNING = "殿堂データベースに接続できないため、殿堂チェックをスキップしました";

function list(n: number, prefix = "カード"): string {
  const lines: string[] = [];
  let rest = n;
  let i = 1;
  while (rest > 0) {
    const c = Math.min(4, rest);
    lines.push(`${c} ${prefix}${i}`);
    rest -= c;
    i++;
  }
  return lines.join("\n");
}

describe("validateRegulation 特性テスト (DB無し)", () => {
  it("40枚ちょうどは valid", async () => {
    const deck = parseDecklist(list(40));
    expect(await validateRegulation(deck, "original")).toEqual({
      valid: true,
      errors: [],
      warnings: [DB_SKIP_WARNING],
    });
  });

  it("39枚は枚数エラー", async () => {
    const deck = parseDecklist(list(39));
    expect(await validateRegulation(deck, "original")).toEqual({
      valid: false,
      errors: ["デッキは40枚ちょうどである必要があります (現在: 39枚)"],
      warnings: [DB_SKIP_WARNING],
    });
  });

  it("同名5枚は上限エラー (合計40枚)", async () => {
    const deck = parseDecklist("5 過剰カード\n" + list(35, "カードX"));
    expect(await validateRegulation(deck, "original")).toEqual({
      valid: false,
      errors: ["「過剰カード」は最大4枚までです (現在: 5枚)"],
      warnings: [DB_SKIP_WARNING],
    });
  });
});

describe("同じカードを複数行に分けて書いても合算する (B-03)", () => {
  it("2行に分けた同名5枚は上限エラー", async () => {
    const deck = parseDecklist("3 過剰カード\n2 過剰カード\n" + list(35, "カードX"));
    const res = await validateRegulation(deck, "original");
    expect(res.valid).toBe(false);
    expect(res.errors).toEqual(["「過剰カード」は最大4枚までです (現在: 5枚)"]);
  });

  it("表記ゆれで分けた同名5枚も上限エラー", async () => {
    const deck = parseDecklist(
      "4 ボルシャック・ドラゴン\n1 ボルシャックドラゴン\n" + list(35, "カードX"),
    );
    const res = await validateRegulation(deck, "original");
    expect(res.errors).toEqual(["「ボルシャック・ドラゴン」は最大4枚までです (現在: 5枚)"]);
  });
});

describe("regulationNameKey / mergeEntriesByName", () => {
  it("中黒・全角半角・囲み記号・空白・大小文字のゆれを同じキーにする", () => {
    const key = regulationNameKey("ボルシャック・ドラゴン");
    expect(regulationNameKey("ボルシャックドラゴン")).toBe(key);
    expect(regulationNameKey("《ボルシャック・ドラゴン》")).toBe(key);
    expect(regulationNameKey("ボルシャック ドラゴン")).toBe(key);
    expect(regulationNameKey("ボルシャック･ドラゴン")).toBe(key);
    expect(regulationNameKey("接続 CS-20")).toBe(regulationNameKey("接続　ＣＳ－２０"));
    expect(regulationNameKey("DG")).toBe(regulationNameKey("ｄｇ"));
  });

  it("別のカードは別キーのまま", () => {
    expect(regulationNameKey("ボルシャック・ドラゴン")).not.toBe(
      regulationNameKey("ボルシャック・ドギラゴン"),
    );
  });

  it("正規化キーで合算し、表示名は最初の行の表記", () => {
    const merged = mergeEntriesByName([
      { name: "《ヘブンズ・ゲート》", count: 1 },
      { name: "カードA", count: 4 },
      { name: "ヘブンズゲート", count: 2 },
    ]);
    expect([...merged.values()]).toEqual([
      { name: "《ヘブンズ・ゲート》", count: 3 },
      { name: "カードA", count: 4 },
    ]);
  });
});

describe("checkRestrictions 殿堂判定 (B-02/B-03)", () => {
  const regs = [
    { card_name: "ボルメテウス・サファイア・ドラゴン", restriction_type: "プレミアム殿堂" },
    { card_name: "勝利龍装 クラッシュ“覇道”", restriction_type: "殿堂入り" },
    { card_name: "ヘブンズ・ゲート", restriction_type: "殿堂入り" },
    { card_name: "カードP", restriction_type: "プレミアム殿堂コンビ" },
  ];
  const check = (text: string) =>
    checkRestrictions(mergeEntriesByName(parseDecklist(text).entries), regs);

  it("完全一致のプレミアム殿堂はエラー (従来どおり)", () => {
    expect(check("1 ボルメテウス・サファイア・ドラゴン").errors).toEqual([
      "「ボルメテウス・サファイア・ドラゴン」はプレミアム殿堂のため使用できません",
    ]);
  });

  it("中黒を落としたプレミアム殿堂もエラー (表記ゆれ)", () => {
    expect(check("1 ボルメテウスサファイアドラゴン").errors).toEqual([
      "「ボルメテウスサファイアドラゴン」はプレミアム殿堂のため使用できません",
    ]);
  });

  it("《》付き・半角中黒のプレミアム殿堂もエラー", () => {
    expect(check("1 《ボルメテウス･サファイア･ドラゴン》").errors).toHaveLength(1);
  });

  it("全角スペース・全角記号の殿堂入り2枚はエラー", () => {
    expect(check("2 勝利龍装　クラッシュ“覇道”").errors).toEqual([
      "「勝利龍装　クラッシュ“覇道”」は殿堂入りのため1枚までです (現在: 2枚)",
    ]);
  });

  it("殿堂入りを1枚ずつ2行に分けてもエラー (合算)", () => {
    expect(check("1 ヘブンズ・ゲート\n1 ヘブンズ・ゲート").errors).toEqual([
      "「ヘブンズ・ゲート」は殿堂入りのため1枚までです (現在: 2枚)",
    ]);
  });

  it("殿堂入りを表記ゆれで2行に分けてもエラー", () => {
    expect(check("1 ヘブンズ・ゲート\n1 《ヘブンズゲート》").errors).toEqual([
      "「ヘブンズ・ゲート」は殿堂入りのため1枚までです (現在: 2枚)",
    ]);
  });

  it("殿堂入り1枚はOK", () => {
    expect(check("1 ヘブンズゲート")).toEqual({ errors: [], warnings: [] });
  });

  it("プレミアム殿堂コンビは警告", () => {
    expect(check("1 カードＰ").warnings).toEqual([
      "「カードＰ」はプレミアム殿堂コンビです。組み合わせを確認してください",
    ]);
  });

  it("規制のないカードは何も出ない", () => {
    expect(check("4 ボルシャック・ドラゴン")).toEqual({ errors: [], warnings: [] });
  });
});

describe("checkRestrictions 引用符のゆれ (#167 優先1)", () => {
  const regs = [{ card_name: "“轟轟轟”ブランド", restriction_type: "プレミアム殿堂" }];
  const check = (text: string) =>
    checkRestrictions(mergeEntriesByName(parseDecklist(text).entries), regs);

  it("曲がった引用符・ASCII 引用符・全角引用符・引用符なしが同じキーになる", () => {
    const key = regulationNameKey("“轟轟轟”ブランド");
    expect(regulationNameKey('"轟轟轟"ブランド')).toBe(key);
    expect(regulationNameKey("＂轟轟轟＂ブランド")).toBe(key);
    expect(regulationNameKey("‘轟轟轟’ブランド")).toBe(key);
    expect(regulationNameKey("'轟轟轟'ブランド")).toBe(key);
    expect(regulationNameKey("轟轟轟ブランド")).toBe(key);
  });

  it.each(["“轟轟轟”ブランド", '"轟轟轟"ブランド', "轟轟轟ブランド", "《“轟轟轟”ブランド》"])(
    "%s はプレミアム殿堂として当たる",
    (name) => {
      expect(check(`1 ${name}`).errors).toEqual([
        `「${name}」はプレミアム殿堂のため使用できません`,
      ]);
    },
  );
});

describe("checkRestrictions ツインパクトの片面名 (#167 優先2)", () => {
  const regs = [
    { card_name: "龍装艦 チェンジザ / 六奇怪の四 ～土を割る逆瀧～", restriction_type: "殿堂入り" },
    { card_name: "テスト片面X", restriction_type: "プレミアム殿堂" },
  ];
  const check = (text: string) =>
    checkRestrictions(mergeEntriesByName(parseDecklist(text).entries), regs);

  it("規制が両面・デッキが片面A だけでも当たる", () => {
    expect(check("2 龍装艦 チェンジザ").errors).toEqual([
      "「龍装艦 チェンジザ」は殿堂入りのため1枚までです (現在: 2枚)",
    ]);
  });

  it("規制が両面・デッキが片面B だけでも当たる", () => {
    expect(check("2 六奇怪の四 ～土を割る逆瀧～").errors).toHaveLength(1);
  });

  it.each([
    "龍装艦 チェンジザ / 六奇怪の四 ～土を割る逆瀧～",
    "龍装艦 チェンジザ/六奇怪の四 ～土を割る逆瀧～",
    "龍装艦 チェンジザ／六奇怪の四 ～土を割る逆瀧～",
    "龍装艦 チェンジザ　／　六奇怪の四 ～土を割る逆瀧～",
    "《龍装艦チェンジザ / 六奇怪の四～土を割る逆瀧～》",
  ])("両面表記・区切りのゆれでも当たる: %s", (name) => {
    expect(check(`2 ${name}`).errors).toEqual([
      `「${name}」は殿堂入りのため1枚までです (現在: 2枚)`,
    ]);
  });

  it("規制が片面だけ・デッキが両面表記でも当たる (逆向き)", () => {
    expect(check("1 テスト片面X / テスト片面Y").errors).toEqual([
      "「テスト片面X / テスト片面Y」はプレミアム殿堂のため使用できません",
    ]);
  });

  it("両面表記と片面表記を別の行に書いても枚数を合算する", () => {
    expect(
      check("1 龍装艦 チェンジザ / 六奇怪の四 ～土を割る逆瀧～\n1 龍装艦チェンジザ").errors,
    ).toEqual([
      "「龍装艦 チェンジザ / 六奇怪の四 ～土を割る逆瀧～」「龍装艦チェンジザ」は殿堂入りのため1枚までです (現在: 2枚)",
    ]);
  });

  it("殿堂入りの片面1枚はOK", () => {
    expect(check("1 龍装艦 チェンジザ")).toEqual({ errors: [], warnings: [] });
  });
});

describe("checkRestrictions 片面分割で無関係なカードを誤爆しない (#167)", () => {
  const regs = [
    { card_name: "ボルシャック / ドラゴン", restriction_type: "プレミアム殿堂" },
    { card_name: "ドラゴン", restriction_type: "殿堂入り" },
  ];
  const check = (text: string) =>
    checkRestrictions(mergeEntriesByName(parseDecklist(text).entries), regs);

  it("片面名を部分に含むだけの別カードは当たらない (照合は完全一致のまま)", () => {
    expect(check("4 ボルシャック・ドラゴン")).toEqual({ errors: [], warnings: [] });
    expect(check("4 ボルシャック・ドラゴン / 別の呪文")).toEqual({ errors: [], warnings: [] });
    expect(check("4 ボルシャックの書")).toEqual({ errors: [], warnings: [] });
  });

  it("別の規制の全体名と同じ片面名は、全体名の規制が優先する", () => {
    // 「ドラゴン」は単体で殿堂入り。ツインパクト側の片面 (プレミアム殿堂) で上書きしない。
    expect(check("1 ドラゴン")).toEqual({ errors: [], warnings: [] });
    expect(check("2 ドラゴン").errors).toEqual([
      "「ドラゴン」は殿堂入りのため1枚までです (現在: 2枚)",
    ]);
  });

  it("/ を2つ以上含む名前・片側が空の名前は分けない", () => {
    const r = [{ card_name: "ア / イ / ウ", restriction_type: "プレミアム殿堂" }];
    const c = (t: string) => checkRestrictions(mergeEntriesByName(parseDecklist(t).entries), r);
    expect(c("1 ア")).toEqual({ errors: [], warnings: [] });
    expect(c("1 イ / ウ")).toEqual({ errors: [], warnings: [] });
    expect(c("1 ア / イ / ウ").errors).toHaveLength(1);
  });

  it("twinpactSideKeys はちょうど2面のときだけ分ける", () => {
    expect(twinpactSideKeys(regulationNameKey("A / B"))).toEqual(["a", "b"]);
    expect(twinpactSideKeys(regulationNameKey("A／B"))).toEqual(["a", "b"]);
    expect(twinpactSideKeys(regulationNameKey("AB"))).toEqual([]);
    expect(twinpactSideKeys(regulationNameKey("A /"))).toEqual([]);
    expect(twinpactSideKeys(regulationNameKey("A/B/C"))).toEqual([]);
  });
});
