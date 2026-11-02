import { MAX_COPIES, type Format } from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
import type { ParsedDeck } from "./parser.js";
import { mergeEntriesByName, regulationNameKey, twinpactSideKeys } from "./card-name.js";
import {
  buildRegulationIndex,
  lookupRegulation,
  lookupRegulationByKey,
  type RegulationIndex,
  type RegulationRow,
} from "./regulation-index.js";

/**
 * 殿堂の区分を名前で引く (#178)。
 *
 * agent の check_regulation / search_cards / evaluate_deck が使う。照合は
 * {@link buildRegulationIndex} / {@link lookupRegulation} だけで行うので、表記ゆれと
 * ツインパクト片面名の扱いは validateRegulation (checkRestrictions) と同じになる。
 *
 * DB を読むのは {@link loadRegulations} だけ。それ以外は純粋関数 (DB なしでテストできる)。
 */

/** 区分の表示名。regulations.restriction_type に無い区分は「制限なし」として扱わない (未知のまま出す) */
export const UNRESTRICTED = "制限なし";

/** 区分ごとの「何枚入れられるか」。モデルに枚数を推測させないため、区分と一緒に返す */
export function restrictionLimitLabel(restriction: string): string {
  switch (restriction) {
    case "プレミアム殿堂":
      return "デッキに入れられない";
    case "殿堂入り":
      return "1枚まで";
    case "プレミアム殿堂コンビ":
      return "組み合わせの相手と同時には入れられない";
    case UNRESTRICTED:
      return `${MAX_COPIES}枚まで`;
    default:
      return "枚数制限は要確認";
  }
}

/** regulations を読めたときの中身 */
export interface LoadedRegulations {
  ok: true;
  rows: RegulationRow[];
  /** いちばん新しい取込日 (created_at, YYYY-MM-DD)。データが古いかを読み手が判断できるように返す */
  fetchedAt: string | null;
}

/** regulations を読めなかったとき (接続できない・読めない・0件) */
export interface UnavailableRegulations {
  ok: false;
  reason: string;
}

export type RegulationsLoad = LoadedRegulations | UnavailableRegulations;

/**
 * regulations を format で読む。**例外は投げない。**
 *
 * 0件も「読めなかった」として扱う。取込が止まって空になっているときに、全カードを
 * 「制限なし」と言い切ってしまうのを防ぐため (#178 (e))。
 */
export async function loadRegulations(format: Format): Promise<RegulationsLoad> {
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT card_name, restriction_type, created_at
      FROM regulations
      WHERE format = ${format}
    `;
    if (rows.length === 0) {
      return { ok: false, reason: "殿堂データが空です (取込が止まっている可能性があります)" };
    }
    let latest: Date | null = null;
    for (const r of rows) {
      const d = r.created_at instanceof Date ? r.created_at : null;
      if (d && (!latest || d > latest)) latest = d;
    }
    return {
      ok: true,
      rows: rows.map((r) => ({
        card_name: r.card_name as string,
        restriction_type: r.restriction_type as string,
      })),
      fetchedAt: latest ? latest.toISOString().slice(0, 10) : null,
    };
  } catch (err) {
    console.error("[deck-engine] regulations の読み込みに失敗:", err);
    return { ok: false, reason: "殿堂データベースに接続できませんでした" };
  }
}

/** 正規化キー → regulations 上の表記 (結果に「どの規制に当たったか」を出すため) */
function regulationNamesByKey(rows: readonly RegulationRow[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const r of rows) {
    const key = regulationNameKey(r.card_name);
    if (!names.has(key)) names.set(key, r.card_name);
  }
  return names;
}

/** 名前1つぶんの判定結果 */
export type RegulationCheck =
  | {
      /** 聞かれた名前 (そのまま) */
      name: string;
      status: "restricted";
      restriction: string;
      /** regulations 上の表記 */
      matchedName: string;
    }
  | { name: string; status: "unrestricted" }
  | {
      name: string;
      /** カード名として特定できない (略称など)。制限なしとは**言わない** */
      status: "unknown_name";
      /** 名前を含むカードの候補 (区分つき) */
      candidates: { name: string; restriction: string }[];
    };

/** 候補として出す最大件数 */
const MAX_CANDIDATES = 8;

/** key が cardKey の全体名かツインパクト片面と一致するか */
function isSameCardKey(key: string, cardKey: string): boolean {
  if (key === cardKey) return true;
  const keySides = twinpactSideKeys(key);
  const cardSides = twinpactSideKeys(cardKey);
  return cardSides.includes(key) || keySides.includes(cardKey);
}

/**
 * カード名ごとに殿堂の区分を決める (純粋関数, #178)。
 *
 * 1. regulations の索引に当たれば、その区分 (validateRegulation と同じ照合)。
 * 2. 当たらず、`cardNames` (cards テーブルで見つかったカード名) に同じカードがあれば「制限なし」。
 *    同じカード = 正規化キーの一致か、ツインパクトの片面どうしの一致。
 * 3. どちらでもなければ「カード名を特定できない」。**ここで制限なしと言うと、略称で聞かれたとき
 *    (No.33「ジョラゴン」) に誤答する。** 名前を含むカードを区分つきで候補に出す。
 *
 * @param names 調べたいカード名
 * @param regulations regulations の行 ({@link loadRegulations} で読んだもの)
 * @param cardNames cards テーブルから引いたカード名 (名前を含むもの。候補にも使う)
 */
export function checkRegulationNames(
  names: readonly string[],
  regulations: readonly RegulationRow[],
  cardNames: readonly string[],
): RegulationCheck[] {
  const index = buildRegulationIndex(regulations);
  const regNames = regulationNamesByKey(regulations);
  const cardKeys = cardNames.map((n) => ({ name: n, key: regulationNameKey(n) }));

  return names.map((name): RegulationCheck => {
    const key = regulationNameKey(name);
    const hit = lookupRegulation(index, name);
    if (hit) {
      return {
        name,
        status: "restricted",
        restriction: hit.restriction,
        matchedName: regNames.get(hit.id) ?? hit.id,
      };
    }
    if (key !== "" && cardKeys.some((c) => isSameCardKey(key, c.key))) {
      return { name, status: "unrestricted" };
    }
    return {
      name,
      status: "unknown_name",
      candidates: findCandidates(key, index, regNames, cardKeys),
    };
  });
}

/** 名前 (キー) を含むカードを、regulations と cards の両方から区分つきで集める */
function findCandidates(
  key: string,
  index: RegulationIndex,
  regNames: ReadonlyMap<string, string>,
  cardKeys: readonly { name: string; key: string }[],
): { name: string; restriction: string }[] {
  if (key === "") return [];
  const seen = new Set<string>();
  const out: { name: string; restriction: string }[] = [];
  const push = (displayName: string, candKey: string) => {
    if (seen.has(candKey) || out.length >= MAX_CANDIDATES) return;
    seen.add(candKey);
    const hit = lookupRegulationByKey(index, candKey);
    out.push({ name: displayName, restriction: hit?.restriction ?? UNRESTRICTED });
  };
  // 規制カードを先に出す (取り違えたときの害が大きいほう)
  for (const [regKey, regName] of regNames) {
    if (regKey.includes(key)) push(regName, regKey);
  }
  for (const c of cardKeys) {
    if (c.key.includes(key)) push(c.name, c.key);
  }
  return out;
}

/** デッキに入っている規制カード1件 */
export interface RestrictedInDeck {
  /** デッキに書かれた名前 (同じ規制に当たった行が複数あれば「」でつなぐ) */
  name: string;
  restriction: string;
  /** デッキ内の枚数 (同じ規制に当たった行の合計) */
  count: number;
  /** 何枚入れられるか */
  limit: string;
}

/**
 * デッキに入っている規制カードを、**違反の有無に関係なく**全部返す (純粋関数, #178 (c))。
 *
 * validateRegulation と同じく全ゾーン (メイン・超次元・GR) を正規化キーで合算し、
 * 同じ規制に当たった行はまとめる。並びは最初に出てきた順。
 */
export function listRestrictedInDeck(
  deck: ParsedDeck,
  regulations: readonly RegulationRow[],
): RestrictedInDeck[] {
  const index = buildRegulationIndex(regulations);
  const merged = mergeEntriesByName([
    ...deck.entries,
    ...(deck.zones?.hyperspatial ?? []),
    ...(deck.zones?.gr ?? []),
  ]);
  const hits = new Map<string, { restriction: string; names: string[]; count: number }>();
  for (const [key, entry] of merged) {
    const hit = lookupRegulationByKey(index, key);
    if (!hit) continue;
    const agg = hits.get(hit.id);
    if (agg) {
      agg.names.push(entry.name);
      agg.count += entry.count;
    } else {
      hits.set(hit.id, { restriction: hit.restriction, names: [entry.name], count: entry.count });
    }
  }
  return [...hits.values()].map((h) => ({
    name: h.names.join("」「"),
    restriction: h.restriction,
    count: h.count,
    limit: restrictionLimitLabel(h.restriction),
  }));
}

/**
 * search_cards の1行に付ける区分ラベル (純粋関数, #178 (b))。
 * regulations を読めなかったときは「確認できず」。**制限なしとは書かない。**
 */
export function regulationTagForCard(cardName: string, index: RegulationIndex | null): string {
  if (!index) return "[殿堂区分: 確認できず]";
  const hit = lookupRegulation(index, cardName);
  return `[${hit ? hit.restriction : UNRESTRICTED}]`;
}
