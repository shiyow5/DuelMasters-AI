import { describe, it, expect } from "vitest";
import { classifyRegulations, applyRegulationToRequired } from "../src/regulation-rules.js";

describe("classifyRegulations", () => {
  it("3種の restriction_type を banned/limited に分類し、コンビは除外", () => {
    const reg = classifyRegulations([
      { card_name: "禁止A", restriction_type: "プレミアム殿堂" },
      { card_name: "制限B", restriction_type: "殿堂入り" },
      { card_name: "コンビC", restriction_type: "プレミアム殿堂コンビ" },
    ]);
    expect(reg.isBanned("禁止A")).toBe(true);
    expect(reg.isLimited("制限B")).toBe(true);
    expect(reg.isBanned("コンビC")).toBe(false);
    expect(reg.isLimited("コンビC")).toBe(false);
    expect(reg.isBanned("制限B")).toBe(false);
    expect(reg.isLimited("禁止A")).toBe(false);
  });
});

describe("applyRegulationToRequired", () => {
  const reg = classifyRegulations([
    { card_name: "禁止A", restriction_type: "プレミアム殿堂" },
    { card_name: "制限B", restriction_type: "殿堂入り" },
  ]);

  it("banned は不採用+警告、limited は count 1、通常は count 4", () => {
    const { adopted, warnings } = applyRegulationToRequired(["禁止A", "制限B", "通常C"], reg);
    expect(adopted).toEqual([
      { name: "制限B", count: 1 },
      { name: "通常C", count: 4 },
    ]);
    expect(warnings).toEqual(["「禁止A」はプレミアム殿堂のため採用できません"]);
  });

  it("空配列は空結果", () => {
    expect(applyRegulationToRequired([], reg)).toEqual({
      adopted: [],
      warnings: [],
    });
  });
});

// ---- #167 PR-B: 完全一致の残りを正規化キー + ツインパクト片面に揃える ----

describe("applyRegulationToRequired 表記ゆれ (#167)", () => {
  const reg = classifyRegulations([
    { card_name: "ボルシャック・ドラゴン", restriction_type: "プレミアム殿堂" },
    { card_name: "“轟轟轟”ブランド", restriction_type: "プレミアム殿堂" },
    { card_name: "龍装艦 チェンジザ", restriction_type: "殿堂入り" },
  ]);
  const banned = (name: string) => applyRegulationToRequired([name], reg);

  it.each(["ボルシャック・ドラゴン", "ボルシャック･ドラゴン", "ボルシャックドラゴン"])(
    "中黒のゆれ %s でもプレミアム殿堂として不採用",
    (name) => {
      expect(banned(name)).toEqual({
        adopted: [],
        warnings: [`「${name}」はプレミアム殿堂のため採用できません`],
      });
    },
  );

  it.each(["“轟轟轟”ブランド", '"轟轟轟"ブランド', "＂轟轟轟＂ブランド", "轟轟轟ブランド"])(
    "引用符のゆれ %s でもプレミアム殿堂として不採用",
    (name) => {
      expect(banned(name).adopted).toEqual([]);
      expect(banned(name).warnings).toHaveLength(1);
    },
  );

  it.each(["龍装艦 チェンジザ", "龍装艦チェンジザ", "龍装艦　チェンジザ", " 龍装艦  チェンジザ "])(
    "空白のゆれ「%s」でも殿堂入りとして1枚",
    (name) => {
      expect(applyRegulationToRequired([name], reg).adopted).toEqual([{ name, count: 1 }]);
    },
  );
});

describe("applyRegulationToRequired ツインパクトの片面名 (#167)", () => {
  const reg = classifyRegulations([
    { card_name: "龍装艦 チェンジザ / 六奇怪の四 ～土を割る逆瀧～", restriction_type: "殿堂入り" },
    { card_name: "テスト片面X", restriction_type: "プレミアム殿堂" },
  ]);

  it("規制が両面・必須が片面A / 片面B でも殿堂入りとして1枚", () => {
    expect(
      applyRegulationToRequired(["龍装艦 チェンジザ", "六奇怪の四 ～土を割る逆瀧～"], reg).adopted,
    ).toEqual([
      { name: "龍装艦 チェンジザ", count: 1 },
      { name: "六奇怪の四 ～土を割る逆瀧～", count: 1 },
    ]);
  });

  it.each([
    "龍装艦 チェンジザ / 六奇怪の四 ～土を割る逆瀧～",
    "龍装艦 チェンジザ／六奇怪の四 ～土を割る逆瀧～",
    "龍装艦チェンジザ/六奇怪の四～土を割る逆瀧～",
  ])("両面表記・区切りのゆれ %s でも殿堂入りとして1枚", (name) => {
    expect(applyRegulationToRequired([name], reg).adopted).toEqual([{ name, count: 1 }]);
  });

  it("規制が片面だけ・必須が両面表記でも不採用 (逆向き)", () => {
    expect(applyRegulationToRequired(["テスト片面X / テスト片面Y"], reg)).toEqual({
      adopted: [],
      warnings: ["「テスト片面X / テスト片面Y」はプレミアム殿堂のため採用できません"],
    });
  });

  it("片面同士がぶつかったら強い規制を採る", () => {
    const r = classifyRegulations([
      { card_name: "共通面 / 弱いほう", restriction_type: "殿堂入り" },
      { card_name: "共通面 / 強いほう", restriction_type: "プレミアム殿堂" },
    ]);
    expect(r.isBanned("共通面")).toBe(true);
    expect(r.isLimited("弱いほう")).toBe(true);
    // 逆順で入っても同じ
    const r2 = classifyRegulations([
      { card_name: "共通面 / 強いほう", restriction_type: "プレミアム殿堂" },
      { card_name: "共通面 / 弱いほう", restriction_type: "殿堂入り" },
    ]);
    expect(r2.isBanned("共通面")).toBe(true);
  });
});

describe("applyRegulationToRequired 誤爆しない (#167)", () => {
  const reg = classifyRegulations([
    { card_name: "ボルシャック / ドラゴン", restriction_type: "プレミアム殿堂" },
    { card_name: "ドラゴン", restriction_type: "殿堂入り" },
  ]);

  it("片面名を部分に含むだけの別カードは制約しない", () => {
    expect(
      applyRegulationToRequired(
        ["ボルシャック・ドラゴン", "ボルシャック・ドラゴン / 別の呪文", "ボルシャックの書"],
        reg,
      ),
    ).toEqual({
      adopted: [
        { name: "ボルシャック・ドラゴン", count: 4 },
        { name: "ボルシャック・ドラゴン / 別の呪文", count: 4 },
        { name: "ボルシャックの書", count: 4 },
      ],
      warnings: [],
    });
  });

  it("全体名の規制が片面より優先する (「ドラゴン」は殿堂入りのまま、禁止にしない)", () => {
    expect(reg.isBanned("ドラゴン")).toBe(false);
    expect(reg.isLimited("ドラゴン")).toBe(true);
    expect(applyRegulationToRequired(["ドラゴン"], reg)).toEqual({
      adopted: [{ name: "ドラゴン", count: 1 }],
      warnings: [],
    });
    // 片面「ボルシャック」は全体名に無いのでツインパクトの規制 (プレミアム殿堂) が効く
    expect(reg.isBanned("ボルシャック")).toBe(true);
  });

  it("コンビの全体名は片面の殿堂入りより優先し、autoBuild では制約しない (validator と同じ規則)", () => {
    const r = classifyRegulations([
      { card_name: "コンビ札", restriction_type: "プレミアム殿堂コンビ" },
      { card_name: "コンビ札 / 別面", restriction_type: "殿堂入り" },
    ]);
    expect(r.isLimited("コンビ札")).toBe(false);
    expect(r.isLimited("別面")).toBe(true);
  });
});
