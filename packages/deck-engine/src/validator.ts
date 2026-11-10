import {
  DECK_SIZE,
  MAX_COPIES,
  ORIGINAL_EXTRA_ZONE_SEVERITY,
  type Format,
  type ValidationResult,
} from "@dm-ai/core";
import { getSql } from "@dm-ai/db";
import type { ParsedDeck } from "./parser.js";
import { mergeEntriesByName, type MergedEntry } from "./card-name.js";
import {
  buildRegulationIndex,
  lookupRegulationByKey,
  type RegulationRow,
} from "./regulation-index.js";

/**
 * デッキのレギュレーション準拠チェック
 */
export async function validateRegulation(
  deck: ParsedDeck,
  format: Format,
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 枚数チェック。**メインデッキだけ**を数える (超次元・GR は totalCards に入っていない。QA②)
  if (deck.totalCards !== DECK_SIZE) {
    errors.push(`デッキは${DECK_SIZE}枚ちょうどである必要があります (現在: ${deck.totalCards}枚)`);
  }

  // オリジナルで超次元・GR を使っていないか (重大度は ORIGINAL_EXTRA_ZONE_SEVERITY で切り替える)
  const zoneIssue = checkExtraZones(deck, format);
  if (zoneIssue) {
    (zoneIssue.severity === "error" ? errors : warnings).push(zoneIssue.message);
  }

  // カード名は正規化して、同じカードの複数行を合算してから判定する (B-02/B-03)。
  // 4枚制限と殿堂は**全ゾーン**に掛かるので、超次元・GR のカードも含める。
  const merged = mergeEntriesByName([
    ...deck.entries,
    ...(deck.zones?.hyperspatial ?? []),
    ...(deck.zones?.gr ?? []),
  ]);

  // 同名カード4枚制限
  for (const entry of merged.values()) {
    if (entry.count > MAX_COPIES) {
      errors.push(`「${entry.name}」は最大${MAX_COPIES}枚までです (現在: ${entry.count}枚)`);
    }
  }

  // 殿堂チェック
  let regulations: RegulationRow[];
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT card_name, restriction_type
      FROM regulations
      WHERE format = ${format}
    `;
    regulations = rows.map((r) => ({
      card_name: r.card_name as string,
      restriction_type: r.restriction_type as string,
    }));
  } catch {
    warnings.push("殿堂データベースに接続できないため、殿堂チェックをスキップしました");
    return { valid: errors.length === 0, errors, warnings, restrictionChecked: false };
  }

  // 規制データが0件だと何も当たらず「問題なし」に見える。未確認として扱う (#164)
  if (regulations.length === 0) {
    warnings.push("殿堂データが登録されていないため、殿堂チェックができませんでした (未確認)");
    return { valid: errors.length === 0, errors, warnings, restrictionChecked: false };
  }

  const result = checkRestrictions(merged, regulations);
  errors.push(...result.errors);
  warnings.push(...result.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    restrictionChecked: true,
  };
}

/**
 * オリジナル形式で超次元・GR ゾーンのカードを使っていれば、その指摘を返す (純粋関数。テスト用に export)。
 *
 * オリジナルでは超次元・GR を使えない。重大度は既定で {@link ORIGINAL_EXTRA_ZONE_SEVERITY}
 * (今は "warning" = 評価を続ける)。アドバンスでは何も返さない。
 */
export function checkExtraZones(
  deck: ParsedDeck,
  format: Format,
  severity: "warning" | "error" = ORIGINAL_EXTRA_ZONE_SEVERITY,
): { severity: "warning" | "error"; message: string } | null {
  if (format !== "original") return null;
  const count = (entries: readonly { count: number }[] | undefined) =>
    (entries ?? []).reduce((sum, e) => sum + e.count, 0);
  const hyperspatial = count(deck.zones?.hyperspatial);
  const gr = count(deck.zones?.gr);
  if (hyperspatial === 0 && gr === 0) return null;

  const parts = [
    hyperspatial > 0 ? `超次元ゾーン${hyperspatial}枚` : null,
    gr > 0 ? `GRゾーン${gr}枚` : null,
  ].filter(Boolean);
  return {
    severity,
    message:
      `オリジナルでは超次元・GRゾーンを使えません (${parts.join("・")})` +
      (severity === "warning" ? "。メインデッキだけで評価しています" : ""),
  };
}

/**
 * 殿堂・プレミアム殿堂の判定 (DB に触らない純粋関数。テスト用に export)。
 *
 * `merged` は {@link mergeEntriesByName} で正規化キーごとに合算済みのデッキ。
 * regulations 側の名前も同じキーにして照合する。
 *
 * ## ツインパクトの片面名 (#167)
 *
 * 規制が `A / B` でデッキが `A` だけ (またはその逆) でも当たるようにする。
 * - 規制側: 全体名 `a/b` に加え、片面 `a` `b` でも regMap に登録する。
 *   **全体名での登録が常に優先**し、片面キーが別の規制の全体名と同じなら上書きしない。
 *   片面キー同士がぶつかったら強い規制を採る。
 * - デッキ側: 全体名で当たらなければ、片面 `a` `b` でも引く (規制が片面だけで載っている場合)。
 * - `A / B` と `A` を別の行に書いても同じ規制として**枚数を合算**する
 *   (殿堂入り1枚制限を行の書き分けですり抜けさせない)。
 */
export function checkRestrictions(
  merged: Map<string, MergedEntry>,
  regulations: readonly RegulationRow[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 照合は regulation-index に一本化している (autoBuild と同じ索引を使う)
  const regMap = buildRegulationIndex(regulations);

  // 同じ規制に当たった行をまとめる (並びは最初に当たった順)
  const hits = new Map<string, { restriction: string; names: string[]; count: number }>();
  for (const [key, entry] of merged) {
    const hit = lookupRegulationByKey(regMap, key);
    if (!hit) continue;
    const agg = hits.get(hit.id);
    if (agg) {
      agg.names.push(entry.name);
      agg.count += entry.count;
    } else {
      hits.set(hit.id, { restriction: hit.restriction, names: [entry.name], count: entry.count });
    }
  }

  for (const { restriction, names, count } of hits.values()) {
    const name = names.join("」「");
    switch (restriction) {
      case "プレミアム殿堂":
        errors.push(`「${name}」はプレミアム殿堂のため使用できません`);
        break;
      case "殿堂入り":
        if (count > 1) {
          errors.push(`「${name}」は殿堂入りのため1枚までです (現在: ${count}枚)`);
        }
        break;
      case "プレミアム殿堂コンビ":
        warnings.push(`「${name}」はプレミアム殿堂コンビです。組み合わせを確認してください`);
        break;
    }
  }

  return { errors, warnings };
}
