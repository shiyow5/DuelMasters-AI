import { regulationNameKey, twinpactSideKeys } from "./card-name.js";

/** regulations テーブルの1行 (照合に使う列だけ) */
export interface RegulationRow {
  card_name: string;
  restriction_type: string;
}

/**
 * 規制の強さ。片面名のキーが2つの規制にぶつかったときは強いほうを採る
 * (弱いほうを採ると、すり抜けの穴を新しく作ることになる)。
 */
const RESTRICTION_STRENGTH: Record<string, number> = {
  プレミアム殿堂: 3,
  殿堂入り: 2,
  プレミアム殿堂コンビ: 1,
};

function strength(restriction: string): number {
  return RESTRICTION_STRENGTH[restriction] ?? 0;
}

/** 照合で当たった規制1件 */
export interface RegHit {
  /** 規制の全体名のキー (同じ規制に当たったデッキの行を合算するための ID) */
  id: string;
  restriction: string;
}

/**
 * 「正規化キー → 規制」の索引。{@link buildRegulationIndex} で作り、
 * {@link lookupRegulationByKey} / {@link lookupRegulation} で引く。
 */
export type RegulationIndex = ReadonlyMap<string, RegHit>;

/**
 * regulations の行から照合用の索引を作る (#167)。
 *
 * validator の `checkRestrictions` と autoBuild (`classifyRegulations`) の両方がこれを使う。
 * 照合ロジックを2か所に書くとまたずれるので、ここ1か所にまとめている。
 *
 * - 全体名: {@link regulationNameKey} のキーで登録する。**全体名での登録が常に優先**。
 *   同じキーが複数の行 (複数の区分) にあるときは、**行の順に関係なく強い区分を採る**
 *   (プレミアム殿堂 > 殿堂入り > プレミアム殿堂コンビ。#167 ④。以前は後の行が上書きしていた)。
 * - ツインパクトの片面: {@link twinpactSideKeys} で `a` `b` も登録する。
 *   片面キーが別の規制の全体名と同じなら上書きしない。片面同士がぶつかったら強い規制を採る。
 */
export function buildRegulationIndex(regulations: readonly RegulationRow[]): RegulationIndex {
  const index = new Map<string, RegHit>();
  // 1) 全体名。完全一致はいつも片面より優先する。同じキーが重なったら強い区分 (同じ強さなら先の行)。
  for (const reg of regulations) {
    const key = regulationNameKey(reg.card_name);
    const prev = index.get(key);
    if (!prev || strength(reg.restriction_type) > strength(prev.restriction)) {
      index.set(key, { id: key, restriction: reg.restriction_type });
    }
  }
  const fullKeys = new Set(index.keys());
  // 2) ツインパクトの片面。全体名を上書きしない。片面同士の衝突は強い方。
  for (const reg of regulations) {
    const id = regulationNameKey(reg.card_name);
    for (const side of twinpactSideKeys(id)) {
      if (fullKeys.has(side)) continue;
      const prev = index.get(side);
      if (!prev || strength(reg.restriction_type) > strength(prev.restriction)) {
        index.set(side, { id, restriction: reg.restriction_type });
      }
    }
  }
  return index;
}

/**
 * 正規化済みキーで規制を引く。全体名 → ツインパクトの片面 (当たった中で強い方) の順。
 * 片面で引くのは、規制が片面だけで載っていてデッキ側が `A / B` のとき (逆向き) のため。
 */
export function lookupRegulationByKey(index: RegulationIndex, key: string): RegHit | undefined {
  const exact = index.get(key);
  if (exact) return exact;
  let best: RegHit | undefined;
  for (const side of twinpactSideKeys(key)) {
    const hit = index.get(side);
    if (hit && (!best || strength(hit.restriction) > strength(best.restriction))) best = hit;
  }
  return best;
}

/** 生のカード名で規制を引く ({@link regulationNameKey} してから {@link lookupRegulationByKey})。 */
export function lookupRegulation(index: RegulationIndex, name: string): RegHit | undefined {
  return lookupRegulationByKey(index, regulationNameKey(name));
}
