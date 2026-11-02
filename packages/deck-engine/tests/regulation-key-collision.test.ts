import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { CARD_NAME_DASH_CHARS, cardNameKey } from "@dm-ai/core";
import { regulationNameKey, twinpactSideKeys } from "../src/card-name.js";
import {
  buildRegulationIndex,
  lookupRegulation,
  type RegulationRow,
} from "../src/regulation-index.js";

/**
 * 公式の規制カード全件で、正規化キーが衝突しないことを確かめる (#167)。
 *
 * fixture は公式 /rule/regulation/ を 2026-11-03 に GET で1回読み (読み取りのみ)、
 * worker の `parseRegulations` で取り出した結果そのもの。127件
 * (プレミアム殿堂 40 / 殿堂入り 85 / プレミアム殿堂コンビ 2)。
 * #167 では「128件」と書かれているが、PR #173 (11/02) と同じく今日のページから取れたのは 127件。
 *
 * 長音・ハイフンを `ー` に畳む (#173) と、別のカードが同じキーになる危険がある
 * (rei の条件「128件でキー衝突0を確認してから入れる」)。#173 では手元で確認しただけだったので、
 * ここでテストとして固定する。公式リストが変わったら fixture を取り直し、この表で衝突を確認する。
 */

const OFFICIAL: RegulationRow[] = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures", "official-regulations-2026-11-03.json"),
    "utf8",
  ),
) as RegulationRow[];

/** 衝突したキーと、そのキーになった名前の一覧 (0件のとき空) */
function collisions(
  pairs: ReadonlyArray<readonly [key: string, name: string]>,
): Record<string, string[]> {
  const byKey = new Map<string, Set<string>>();
  for (const [key, name] of pairs) {
    const set = byKey.get(key) ?? new Set<string>();
    set.add(name);
    byKey.set(key, set);
  }
  return Object.fromEntries(
    [...byKey].filter(([, names]) => names.size > 1).map(([k, names]) => [k, [...names]]),
  );
}

/**
 * 長音・ハイフンを**畳まない**キー (#173 より前の挙動)。
 * NFKC のあとでダッシュ類を1文字ずつ別の私用領域の文字に置き換えてから cardNameKey にかける。
 * 私用領域の文字は NFKC でも変わらず、落とす文字にも畳む文字にも入っていない。
 */
function keyWithoutDashFolding(name: string): string {
  const dashes = [...CARD_NAME_DASH_CHARS, "ー"];
  const marked = [...name.normalize("NFKC")]
    .map((ch) => {
      const i = dashes.indexOf(ch);
      return i === -1 ? ch : String.fromCodePoint(0xe000 + i);
    })
    .join("");
  return cardNameKey(marked);
}

describe("公式の規制カード fixture (2026-11-03)", () => {
  it("127件 (プレミアム殿堂 40 / 殿堂入り 85 / プレミアム殿堂コンビ 2)", () => {
    expect(OFFICIAL).toHaveLength(127);
    const byType: Record<string, number> = {};
    for (const r of OFFICIAL) byType[r.restriction_type] = (byType[r.restriction_type] ?? 0) + 1;
    expect(byType).toEqual({ プレミアム殿堂: 40, 殿堂入り: 85, プレミアム殿堂コンビ: 2 });
  });
});

describe("規制カード127件の正規化キー衝突 (#167)", () => {
  it("検出器が効いている (衝突を仕込めば拾い、ハイフン化けは畳まないキーでは別になる)", () => {
    expect(
      collisions([
        [regulationNameKey("ヘブンズ・ゲート"), "ヘブンズ・ゲート"],
        [regulationNameKey("ヘブンズゲート"), "ヘブンズゲート"],
      ]),
    ).not.toEqual({});
    expect(keyWithoutDashFolding("ゲ-ト")).not.toBe(keyWithoutDashFolding("ゲート"));
    expect(regulationNameKey("ゲ-ト")).toBe(regulationNameKey("ゲート"));
  });

  it("全体名どうしの衝突は0件", () => {
    expect(collisions(OFFICIAL.map((r) => [regulationNameKey(r.card_name), r.card_name]))).toEqual(
      {},
    );
    expect(new Set(OFFICIAL.map((r) => regulationNameKey(r.card_name))).size).toBe(OFFICIAL.length);
  });

  it("ツインパクトの片面どうし・片面と別の全体名の衝突は0件", () => {
    const pairs: Array<[string, string]> = [];
    for (const r of OFFICIAL) {
      const key = regulationNameKey(r.card_name);
      pairs.push([key, r.card_name]);
      for (const side of twinpactSideKeys(key)) pairs.push([side, r.card_name]);
    }
    // 同じカードの全体名と片面は同じ名前で数えるので、衝突は「別の規制カード」どうしだけ
    expect(collisions(pairs)).toEqual({});
  });

  it("ツインパクトは片面に分かれる (分割が効いていない = 片面の衝突確認が空振り、を防ぐ)", () => {
    const twinpacts = OFFICIAL.filter(
      (r) => twinpactSideKeys(regulationNameKey(r.card_name)).length,
    );
    expect(twinpacts.length).toBeGreaterThanOrEqual(6);
  });

  it("長音・ハイフンを畳んでも、以前は別だった名前が同じキーにならない", () => {
    const before = new Set(OFFICIAL.map((r) => keyWithoutDashFolding(r.card_name)));
    const after = new Set(OFFICIAL.map((r) => regulationNameKey(r.card_name)));
    expect(before.size).toBe(OFFICIAL.length);
    expect(after.size).toBe(before.size);
  });

  it("索引で全件が自分自身の区分に当たる (後勝ち・片面で別の規制に化けない)", () => {
    const index = buildRegulationIndex(OFFICIAL);
    const wrong = OFFICIAL.filter((r) => {
      const hit = lookupRegulation(index, r.card_name);
      return hit?.id !== regulationNameKey(r.card_name) || hit.restriction !== r.restriction_type;
    });
    expect(wrong).toEqual([]);
  });

  it("表記ゆれ (中黒なし・《》・ハイフン化け・全角空白) でも全件が同じ規制に当たる", () => {
    const index = buildRegulationIndex(OFFICIAL);
    const variants = (n: string) => [
      n.replace(/[・･]/g, ""),
      `《${n}》`,
      n.replace(/ー/g, "-"),
      n.replace(/ー/g, "－"),
      n.replace(/ /g, "　"),
    ];
    const miss: string[] = [];
    for (const r of OFFICIAL) {
      for (const v of variants(r.card_name)) {
        const hit = lookupRegulation(index, v);
        if (hit?.id !== regulationNameKey(r.card_name)) miss.push(`${r.card_name} ← ${v}`);
      }
    }
    expect(miss).toEqual([]);
  });
});
