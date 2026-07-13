import {
  CIVILIZATIONS,
  CIVILIZATION_LABELS,
  CARD_TYPES,
  type Civilization,
  type CardType,
} from "@dm-ai/core";

/**
 * カード検索の引数と検索語の正規化 (#111)。
 *
 * ## 本番で実際に壊れていた
 *
 * `search_cards` は `name ILIKE '%query%'` の**素朴な部分一致**しかしていなかった。
 * その結果:
 *
 * 1. **《ヘブンズ・ゲート》を「ヘブンズゲート」(中黒なし) で探すと 0件。**
 *    カード名には中黒が入る。利用者も LLM も中黒を落として書く。
 *    LLM が気まぐれに中黒を補ったときだけ成功するので、**間欠的な故障に見える**。
 * 2. **「コスト7以上のクリーチャー」がそもそも表現できない。**
 *    `query` が必須で `min_cost` が無いため、agent は仕方なく
 *    `query: "コスト7以上"` と意味的な語を部分一致検索に突っ込み、0件になる。
 * 3. Gemini が文明を「火」と**日本語**で、数値を**文字列**で渡してくると zod が弾き、
 *    「ツール引数が不正です」になる。
 *
 * そして **0件とエラーを agent が区別できず**、「カード検索ツールに一時的なエラーが
 * 発生しているようです」と誤報していた (ユーザー報告)。
 */

/**
 * カード名の照合用に正規化する。
 *
 * 中黒・空白・囲み記号を落とし、全角/半角と大小文字を揃える。
 * DB 側も同じ正規化をかけて比較する (SQL の translate/lower で同等の処理を行う)。
 */
export function normalizeCardName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[・･]/g, "") // 中黒 (これが本番のバグの本体)
    .replace(/[《》≪≫«»『』【】「」\s]/g, ""); // 囲み記号と空白
}

/** 文明の日本語 → 内部コード。Gemini は「火」と日本語で渡してくることがある。 */
const CIVILIZATION_BY_LABEL: Record<string, Civilization> = Object.fromEntries(
  (Object.entries(CIVILIZATION_LABELS) as Array<[Civilization, string]>).map(([code, label]) => [
    label,
    code,
  ]),
);

/** カード種別の日本語 → 内部コード。 */
const CARD_TYPE_BY_LABEL: Record<string, CardType> = {
  クリーチャー: "creature",
  呪文: "spell",
  クロスギア: "cross_gear",
  城: "castle",
  ウエポン: "weapon",
  フィールド: "field",
  タマシード: "tamaseed",
  スター進化クリーチャー: "star_evolution_creature",
};

export interface CardSearchArgs {
  query?: string;
  civilization?: Civilization;
  min_cost?: number;
  max_cost?: number;
  type?: CardType;
}

export type BuildResult = { ok: true; args: CardSearchArgs } | { ok: false; reason: string };

/** 数値。Gemini は数値を文字列で渡してくることがある。 */
function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** 文明。内部コードでも日本語でも受ける。知らない値は**受けない** (捏造で検索させない)。 */
function toCivilization(v: unknown): Civilization | undefined | "invalid" {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim();
  if ((CIVILIZATIONS as readonly string[]).includes(s)) return s as Civilization;
  const byLabel = CIVILIZATION_BY_LABEL[s.replace(/文明$/, "")];
  return byLabel ?? "invalid";
}

/** カード種別。内部コードでも日本語でも受ける。 */
function toCardType(v: unknown): CardType | undefined | "invalid" {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim();
  if ((CARD_TYPES as readonly string[]).includes(s)) return s as CardType;
  return CARD_TYPE_BY_LABEL[s] ?? "invalid";
}

/**
 * ツール引数を検証・正規化する。
 *
 * **`query` を必須にしない。** 「コスト7以上のクリーチャー」のように、絞り込み条件だけで
 * 検索したいことがある。必須にすると agent が意味的な語を部分一致に突っ込んで 0件になる。
 * ただし**絞り込みが1つも無いのは拒否する** (全件返しても意味がない)。
 */
export function buildCardSearchArgs(raw: Record<string, unknown>): BuildResult {
  const civ = toCivilization(raw.civilization);
  if (civ === "invalid") {
    return { ok: false, reason: `文明「${String(raw.civilization)}」は存在しません` };
  }
  const type = toCardType(raw.type);
  if (type === "invalid") {
    return { ok: false, reason: `カード種別「${String(raw.type)}」は存在しません` };
  }

  const query =
    typeof raw.query === "string" && raw.query.trim() !== "" ? raw.query.trim() : undefined;
  const min_cost = toNumber(raw.min_cost);
  const max_cost = toNumber(raw.max_cost);

  if (
    query === undefined &&
    civ === undefined &&
    type === undefined &&
    min_cost === undefined &&
    max_cost === undefined
  ) {
    return { ok: false, reason: "検索条件がありません (名前・文明・コスト・種別のいずれかを指定)" };
  }

  return { ok: true, args: { query, civilization: civ, min_cost, max_cost, type } };
}
