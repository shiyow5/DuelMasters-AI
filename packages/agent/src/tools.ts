import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  CIVILIZATIONS,
  CARD_TYPES,
  CARD_NAME_TRANSLATE_FROM,
  CARD_NAME_TRANSLATE_TO,
  aggregateTierData,
  likeContains,
  mergeArchetypeCounts,
} from "@dm-ai/core";
import { searchRules } from "@dm-ai/rag";
import {
  parseDecklist,
  scoreDeck,
  validateRegulation,
  autoBuild,
  suggestReplacements,
  loadRegulations,
  buildRegulationIndex,
  checkRegulationNames,
  listRestrictedInDeck,
  regulationTagForCard,
  restrictionLimitLabel,
  type ParsedDeck,
  type RegulationsLoad,
  type RegulationCheck,
  type RestrictedInDeck,
} from "@dm-ai/deck-engine";
import { getSql } from "@dm-ai/db";
import { buildCardSearchArgs, normalizeCardName } from "./card-search.js";
import { citationsFromChunks } from "./citations.js";
import type { Citation } from "./state.js";

export interface ToolResult {
  /** モデルへ返すテキスト結果 */
  text: string;
  /** UI へ添える引用 (search_rules のみ) */
  citations?: Citation[];
  /**
   * ツールが**実際にデータを取れたか**。既定 true。
   *
   * システム障害でも引数エラーでも false。**0件は true** — 検索は成功しており、
   * 「該当なし」という事実が得られている (#111。0件をエラー扱いしたせいでモデルが
   * 「ツールの一時的なエラー」と誤報し、記憶から捏造した)。
   *
   * これが無いと「ツールを呼んだ」と「根拠を得た」を区別できない。eval の evidenceRate は
   * toolCalls (= モデルの**要求**) を見ていたため、**ツールが全部失敗しても「根拠あり」と
   * 数えていた** — #112 の失敗モードそのものを見逃す指標になっていた。
   */
  ok?: boolean;
  /**
   * **システムが壊れている**か (例外)。既定 false。
   *
   * `ok: false` には性質の違う2つが混ざる。**混ぜたままでは使えない**:
   *
   * - **システム障害** (DB が落ちている等) … 本当に壊れている。利用者に警告し、
   *   eval のゲートを落とすべき。#112 がこれ。
   * - **引数エラー** (モデルが `civilization=虹` と推測した等) … 壊れていない。
   *   モデルは正しい引数で呼び直せるし、実際に回復する。利用者への警告は**誤報**になり
   *   (本番実測: 引用9件付きの正しい回答に「データで裏付けられていません」と出た)、
   *   ゲートを落とすのも筋違い (モデルの推測ミスは退行ではない)。
   *
   * 警告とゲートはこちらだけを見る。根拠の有無 (evidenceRate) は `ok` を見る。
   */
  systemFailure?: boolean;
}

type Format = "original" | "advance";

export function resolveFormat(value: unknown, fallback?: string): Format {
  const v = (value as string) ?? fallback ?? "original";
  return v === "advance" ? "advance" : "original";
}

/**
 * build_deck ツールの引数スキーマ。グラフの tools ノードは zod schema を通さず args を直接渡すので
 * runTool 内で検証する。**eval の deckQuality もこれを再利用して「実ツールなら拒否される呼び出し」を
 * 正しく不合格にする** (#140 レビュー: 拒否される引数でもデッキを捏造してゲートを素通りしていた)。
 *
 * `.positive()` は排他境界 (exclusiveMinimum) になり Gemini の function declaration が 400 を返す。
 * `.min(1)` で包含境界にする。
 */
export const BUILD_DECK_SCHEMA = z.object({
  theme: z.string(),
  format: z.enum(["original", "advance"]).optional(),
  required_cards: z.array(z.string()).optional(),
  civilizations: z.array(z.enum(CIVILIZATIONS)).nonempty().optional(),
  max_cost: z.number().optional(),
  min_creatures: z.number().int().min(1).optional(),
});

const FORMAT_LABEL: Record<Format, string> = { original: "オリジナル", advance: "アドバンス" };

/** check_regulation で一度に調べられる名前の上限 (デッキ1つぶんより少し多め) */
const MAX_REGULATION_NAMES = 40;

/** check_regulation ツールの引数スキーマ (#178)。runTool 内でも検証する (BUILD_DECK_SCHEMA と同じ理由) */
export const CHECK_REGULATION_SCHEMA = z.object({
  card_names: z.array(z.string()).min(1).max(MAX_REGULATION_NAMES),
  format: z.enum(["original", "advance"]).optional(),
});

/**
 * regulations を読めなかったときの返答 (#178 (e))。
 * 「制限なし」「殿堂入りしていない」と言い切らせない。
 */
export function regulationUnavailableText(names: readonly string[], reason: string): string {
  return (
    `殿堂レギュレーションを確認できませんでした (${reason})。\n` +
    `対象: ${names.map((n) => `「${n}」`).join("")}\n` +
    `**これらのカードが殿堂入りしているか・していないかは、どちらとも言えません。** ` +
    `「殿堂入りしていない」「4枚入れられる」と書いてはいけません。記憶で補わず、` +
    `「殿堂の区分を確認できなかった。時間をおいて再度お試しください」とだけ伝えてください。`
  );
}

/** 区分の1行表示 (例: `殿堂入り (1枚まで)`) */
function restrictionText(restriction: string): string {
  return `${restriction} (${restrictionLimitLabel(restriction)})`;
}

/**
 * check_regulation の結果をモデルへ返す文にする (純粋関数, #178 (a))。
 *
 * @param cardsChecked cards テーブルを引けたか。引けなかったときは「カード名を特定できない」の理由を変える
 */
export function formatRegulationChecks(
  checks: readonly RegulationCheck[],
  fmt: Format,
  fetchedAt: string | null,
  cardsChecked = true,
): string {
  const header =
    `殿堂レギュレーションの確認結果 (フォーマット: ${FORMAT_LABEL[fmt]}` +
    `${fetchedAt ? ` / 殿堂データ取込日: ${fetchedAt}` : ""})`;
  const lines = checks.map((c) => {
    switch (c.status) {
      case "restricted":
        return (
          `- 「${c.name}」: ${restrictionText(c.restriction)}` +
          (c.matchedName !== c.name ? ` ※殿堂リスト上の表記《${c.matchedName}》` : "")
        );
      case "unrestricted":
        return `- 「${c.name}」: ${restrictionText("制限なし")}。殿堂リスト (プレミアム殿堂・殿堂入り・プレミアム殿堂コンビ) に載っていません`;
      case "unknown_name": {
        const why = cardsChecked
          ? "この名前のカードが見つからず、どのカードか特定できませんでした (略称・誤記の可能性)"
          : "カードDBを引けず、どのカードか特定できませんでした";
        const cands =
          c.candidates.length > 0
            ? ` 名前を含むカード: ${c.candidates.map((x) => `《${x.name}》[${x.restriction}]`).join(" ")}`
            : " search_cards で正式なカード名を調べ、その名前でもう一度 check_regulation を呼んでください。";
        return `- 「${c.name}」: ${why}。**制限なしと断定しないでください。**${cands}`;
      }
    }
  });
  return (
    `${header}\n${lines.join("\n")}\n` +
    `殿堂かどうか・何枚入れられるかは、この結果だけを根拠に答えてください。記憶と食い違う場合もこの結果を優先してください。`
  );
}

/**
 * evaluate_deck の restricted_in_deck (#178 (c)/(e))。
 * 規制カードがあれば区分つきで全部、無ければ「規制カードなし」、読めなければ「確認できなかった」。
 */
export function restrictedInDeckField(
  deck: ParsedDeck,
  regs: RegulationsLoad,
): RestrictedInDeck[] | string {
  if (!regs.ok) {
    return `確認できなかった (${regs.reason})。このデッキの殿堂カードの有無は不明です。殿堂入りしていないと言い切らないでください`;
  }
  const list = listRestrictedInDeck(deck, regs.rows);
  return list.length > 0 ? list : "規制カードなし";
}

/**
 * 聞かれた名前を含むカード名を cards から引く (check_regulation の名前確認・候補用)。
 * 正規化は search_cards と同じ。引けなかったら null (例外は投げない)。
 */
async function findCardNamesLike(names: readonly string[]): Promise<string[] | null> {
  try {
    const sql = getSql();
    const out = new Set<string>();
    for (const name of names) {
      const key = normalizeCardName(name);
      if (key === "") continue;
      const rows = await sql`
        SELECT name FROM cards
        WHERE lower(translate(normalize(name, NFKC), ${CARD_NAME_TRANSLATE_FROM}, ${CARD_NAME_TRANSLATE_TO})) LIKE ${likeContains(key)} ESCAPE '\\'
        ORDER BY (lower(translate(normalize(name, NFKC), ${CARD_NAME_TRANSLATE_FROM}, ${CARD_NAME_TRANSLATE_TO})) = ${key}) DESC,
                 length(name), name
        LIMIT 20
      `;
      for (const r of rows) out.add(r.name as string);
    }
    return [...out];
  } catch (err) {
    console.error("[agent] check_regulation: cards の参照に失敗:", err);
    return null;
  }
}

/**
 * ツール実行のディスパッチャ。グラフの tools ノードが state.format を渡して呼ぶ。
 * 例外はここで握り、モデル/ユーザーに生のエラー文言を渡さない (詳細はサーバーログのみ)。
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  format?: string,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "search_rules": {
        const result = await searchRules(args.query as string);
        // モデルへ渡す text は全チャンク (兄弟条文=例外規定も資料として要る)。
        const text = result.chunks
          .map((ch) => `${ch.meta.article ? `[${ch.meta.article}] ` : ""}${ch.text}`)
          .join("\n\n");
        // UI の出典は兄弟条文 (expanded) を外す (#116)。context としては正しいが出典としてはノイズ。
        const citations = citationsFromChunks(result.chunks);
        return { text: text || "該当するルールが見つかりませんでした", citations };
      }

      case "search_cards": {
        // 引数の検証・正規化は card-search.ts (query 必須をやめ、日本語の文明/種別も受ける)。
        const built = buildCardSearchArgs(args);
        // 引数エラー。**システム障害ではない** — モデルは正しい引数で呼び直せる。
        if (!built.ok) return { text: `検索条件が不正です: ${built.reason}`, ok: false };
        const { query, civilization, min_cost, max_cost, type } = built.args;

        const sql = getSql();

        /**
         * **カード名は正規化して突き合わせる。**
         * 《ヘブンズ・ゲート》を「ヘブンズゲート」(中黒なし) で探しても引けるように、
         * DB 側の name にも同じ正規化 (NFKC → 長音・ハイフン類を `ー` に畳み、中黒・空白・囲み・引用符を
         * 落とす → 小文字化) をかける。文字集合は TS の normalizeCardName と同じ
         * CARD_NAME_TRANSLATE_FROM / TO (#167。以前は SQL だけ NFKC が無く、≪≫«»・タブ等も落としておらず、
         * TS とズレていた)。
         * これをやらないと素朴な部分一致が 0件になり、agent がそれを「ツールのエラー」と
         * 誤解して「一時的なエラーが発生している」と誤報する (本番で実際に起きた)。
         */
        const normalized = query ? normalizeCardName(query) : "";
        const nameFrag = query
          ? sql`AND (
              lower(translate(normalize(name, NFKC), ${CARD_NAME_TRANSLATE_FROM}, ${CARD_NAME_TRANSLATE_TO})) LIKE ${likeContains(normalized)} ESCAPE '\\'
              OR text ILIKE ${likeContains(query)} ESCAPE '\\'
            )`
          : sql``;
        const civFrag = civilization
          ? sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(civilizations) c WHERE c = ${civilization})`
          : sql``;
        const minFrag = min_cost !== undefined ? sql`AND cost >= ${min_cost}` : sql``;
        const maxFrag = max_cost !== undefined ? sql`AND cost <= ${max_cost}` : sql``;
        const typeFrag = type ? sql`AND type = ${type}` : sql``;

        const rows = await sql`
          SELECT name, civilizations, cost, type, races, text, power
          FROM cards
          WHERE TRUE ${nameFrag} ${civFrag} ${minFrag} ${maxFrag} ${typeFrag}
          ORDER BY cost, name
          LIMIT 15
        `;
        if (rows.length === 0) {
          // **0件は「エラー」ではない。** そう伝えないと agent が「ツールの一時的なエラー」と
          // 誤解して誤報する (本番で実際に起きた)。何で絞ったかも返し、条件を緩める判断材料にする。
          const cond = [
            query && `名前/テキスト「${query}」`,
            civilization && `文明=${civilization}`,
            min_cost !== undefined && `コスト>=${min_cost}`,
            max_cost !== undefined && `コスト<=${max_cost}`,
            type && `種別=${type}`,
          ]
            .filter(Boolean)
            .join(" / ");
          return {
            text: `検索は成功しましたが、条件に一致するカードは0件でした (条件: ${cond})。これはエラーではありません。条件を緩めて再検索するか、該当するカードが無い旨を回答してください。`,
          };
        }
        // 1行ごとに殿堂の区分を付ける (#178 (b))。モデルが check_regulation を呼ばなかったときの保険。
        // 読めなかったら「確認できず」と付け、制限なしとは書かない (#178 (e))。
        const fmt = resolveFormat(undefined, format);
        const regs = await loadRegulations(fmt);
        const index = regs.ok ? buildRegulationIndex(regs.rows) : null;
        const text = rows
          .map(
            (r) =>
              `${r.name} ${regulationTagForCard(r.name as string, index)} (${r.cost}コスト, ${(r.civilizations as string[]).join("/")}, ${r.type}): ${String(r.text ?? "").slice(0, 100)}`,
          )
          .join("\n");
        const note = regs.ok
          ? `\n※ [ ] 内は${FORMAT_LABEL[fmt]}の殿堂区分 (regulations 参照)。`
          : `\n※ ${regs.reason}。殿堂区分は確認できませんでした。殿堂入りしていないと言い切らないでください。`;
        return { text: text + note };
      }

      case "evaluate_deck": {
        const deck = parseDecklist(args.decklist as string);
        const fmt = resolveFormat(args.format, format);
        const [score, validation, regs] = await Promise.all([
          scoreDeck(deck),
          validateRegulation(deck, fmt),
          loadRegulations(fmt),
        ]);
        // 違反の有無に関係なく、デッキ内の規制カードを必ず返す (#178 (c))。
        // 無いと「このデッキの殿堂カードはどれか」をモデルが記憶で埋める (No.32)。
        const restricted_in_deck = restrictedInDeckField(deck, regs);
        // 読み取れなかった行があるときだけ parseErrors を添える (#165 B-06)。
        const out = {
          score,
          validation,
          restricted_in_deck,
          ...(deck.errors.length > 0 ? { parseErrors: deck.errors } : {}),
        };
        return { text: JSON.stringify(out, null, 2) };
      }

      case "check_regulation": {
        const parsed = CHECK_REGULATION_SCHEMA.safeParse(args);
        if (!parsed.success) {
          // 引数エラー。**システム障害ではない** — モデルは正しい引数で呼び直せる。
          return {
            text: `ツール引数が不正です: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join(", ")}`,
            ok: false,
          };
        }
        const names = [...new Set(parsed.data.card_names.map((n) => n.trim()))].filter(Boolean);
        if (names.length === 0) {
          return {
            text: "ツール引数が不正です: card_names: カード名を1つ以上指定してください",
            ok: false,
          };
        }
        const fmt = resolveFormat(parsed.data.format, format);
        const regs = await loadRegulations(fmt);
        if (!regs.ok) {
          // **「殿堂入りしていない」と言い切らせない** (#178 (e))。
          return {
            text: regulationUnavailableText(names, regs.reason),
            ok: false,
            systemFailure: true,
          };
        }
        const cardNames = await findCardNamesLike(names);
        const checks = checkRegulationNames(names, regs.rows, cardNames ?? []);
        return { text: formatRegulationChecks(checks, fmt, regs.fetchedAt, cardNames !== null) };
      }

      case "build_deck": {
        // 文明・最大コストは autoBuild の制約に渡す。自然文の theme だけでは
        // 「火文明中心の速攻」等の意図が ILIKE に載らず文明無視のデッキになるため、
        // モデルが抽出した civilizations / max_cost を構造化制約として明示的に渡す。
        // グラフの tools ノードは zod schema を通さず args を直接渡すのでここで検証する。
        // 不正な文明コード (例: 日本語の "火") を黙って捨てると制約なしで構築が走り、
        // まさに防ぎたい混色デッキが返るため、引数エラーとしてモデルに再指定させる。
        const parsed = BUILD_DECK_SCHEMA.safeParse(args);
        if (!parsed.success) {
          // 引数エラー。**システム障害ではない** — モデルは正しい引数で呼び直せる。
          return {
            text: `ツール引数が不正です: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join(", ")}`,
            ok: false,
          };
        }
        const { theme, required_cards, civilizations, max_cost, min_creatures } = parsed.data;
        const result = await autoBuild(theme, resolveFormat(parsed.data.format, format), {
          requiredCards: required_cards,
          civilizations,
          maxCost: max_cost,
          minCreatures: min_creatures,
        });
        return { text: JSON.stringify(result, null, 2) };
      }

      case "get_tier_list": {
        const sql = getSql();
        const fmt = resolveFormat(args.format, format);
        const period = (args.period as string) ?? "4w";
        const weeks = parseInt(period.replace("w", ""), 10) || 4;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - weeks * 7);
        const cutoffStr = cutoff.toISOString().split("T")[0];
        // 要求された期間と**同じ長さ**のスナップショットだけを使う (API の /api/meta/tier と同じ。QA③)。
        // 長さを見ないと、cron が作る 4 週ぶんのスナップショットが 2w / 8w にも返ってしまう。
        // snapshot-meta は period_start = period_end - weeks*7日 で作るので、日数の差で照合する。
        const snapshots = await sql`
          SELECT tier_data, period_start, period_end
          FROM meta_snapshots
          WHERE format = ${fmt}
            AND period_end >= ${cutoffStr}
            AND (period_end - period_start) = ${weeks * 7}
          ORDER BY period_end DESC
          LIMIT 1
        `;
        if (snapshots.length > 0) return { text: JSON.stringify(snapshots[0].tier_data, null, 2) };

        // 同じ長さのスナップショットが無ければその場で集計する (API と同じ優先度:
        // 週次ランキング > 個別 CS 記事)。ここで「データなし」と返すと 2w / 8w が常に空になる。
        const weekly = await sql`
          SELECT deck_archetype, SUM(entries)::int as count
          FROM archetype_weekly_stats
          WHERE format = ${fmt} AND period_end >= ${cutoffStr}
          GROUP BY deck_archetype
          ORDER BY count DESC
        `;
        const results =
          weekly.length > 0
            ? weekly
            : await sql`
                SELECT deck_archetype, COUNT(*)::int as count
                FROM tournament_results
                WHERE format = ${fmt} AND event_date >= ${cutoffStr}
                GROUP BY deck_archetype
                ORDER BY count DESC
              `;
        if (results.length === 0) return { text: "ティアデータがまだありません" };
        const tierData = aggregateTierData(
          mergeArchetypeCounts(
            results.map((r) => ({
              deck_archetype: r.deck_archetype as string,
              count: r.count as number,
            })),
          ),
        );
        return { text: JSON.stringify(tierData, null, 2) };
      }

      case "suggest_improvements": {
        const deck = parseDecklist(args.decklist as string);
        const goals = (args.goals as string[]) ?? [];
        const suggestions = await suggestReplacements(deck.entries, goals);
        return { text: JSON.stringify(suggestions, null, 2) };
      }

      default:
        return { text: `不明なツール: ${name}`, ok: false };
    }
  } catch (err) {
    console.error(`[agent] ツール実行エラー (${name}):`, err);
    // **ここで捏造を止める。** 以前は「エラーが発生しました」とだけ返しており、モデルは
    // それを「ツールが使えないので記憶で答えよう」と解釈して**誤ったカードテキストを創作した**
    // (本番で《ヘブンズ・ゲート》を「コスト7以上のブロッカーを2体」と誤答。#112)。
    // ツールが落ちた時に許される振る舞いは「答えないこと」だけである。
    return {
      text:
        `ツール ${name} の実行に失敗しました (システム障害)。\n` +
        `**記憶や一般知識でこの質問に答えてはいけません。** カードテキスト・コスト・効果・` +
        `ルールを推測で書くと誤情報になります。\n` +
        `「システム障害で情報を確認できませんでした。時間をおいて再度お試しください」と` +
        `だけ伝え、確認できていない内容は一切書かないでください。`,
      ok: false,
      systemFailure: true,
    };
  }
}

// モデルへ渡すツール定義 (schema)。実行はグラフの tools ノードが runTool で行うため、
// ここの func は runTool への薄い委譲 (state.format 無しの既定動作)。
export const AGENT_TOOLS = [
  tool(async (a: { query: string }) => (await runTool("search_rules", a)).text, {
    name: "search_rules",
    description: "デュエル・マスターズのルールや裁定を検索します",
    schema: z.object({ query: z.string().describe("検索クエリ") }),
  }),
  tool(async (a: Record<string, unknown>) => (await runTool("search_cards", a)).text, {
    name: "search_cards",
    description:
      "カードを検索します。名前・文明・コスト・種別のいずれかで絞り込めます。" +
      "「コスト7以上のクリーチャー」のように名前を使わない検索もできます (query は省略可)。" +
      "名前は中黒 (・) の有無を問いません。",
    schema: z.object({
      // **必須にしない。** 必須だと「コスト7以上のクリーチャー」を表現できず、
      // モデルが意味的な語 ("コスト7以上") を部分一致検索に突っ込んで 0件になる (本番で発生)。
      query: z.string().optional().describe("カード名またはテキストに含まれる語 (省略可)"),
      civilization: z.enum(CIVILIZATIONS).optional().describe("文明"),
      min_cost: z.number().optional().describe("最小コスト (これ以上)"),
      max_cost: z.number().optional().describe("最大コスト (これ以下)"),
      type: z.enum(CARD_TYPES).optional().describe("カード種別"),
    }),
  }),
  tool(async (a: Record<string, unknown>) => (await runTool("check_regulation", a)).text, {
    name: "check_regulation",
    description:
      "カードが殿堂入り・プレミアム殿堂・プレミアム殿堂コンビか (何枚入れられるか) を殿堂レギュレーションで確認します。" +
      "「〇〇は殿堂入りしてる？」「何枚入れられる？」と聞かれたら、記憶で答えずに必ず呼んでください。" +
      "略称しか分からないときは、先に search_cards で正式なカード名を調べてから渡してください。",
    schema: z.object({
      card_names: z.array(z.string()).describe("調べるカード名の配列 (正式名)"),
      format: z.enum(["original", "advance"]).optional().describe("フォーマット"),
    }),
  }),
  tool(async (a: Record<string, unknown>) => (await runTool("evaluate_deck", a)).text, {
    name: "evaluate_deck",
    description: "デッキリストを評価して診断結果を返します",
    schema: z.object({
      decklist: z.string().describe("デッキリスト (テキスト形式)"),
      format: z.enum(["original", "advance"]).optional().describe("フォーマット"),
    }),
  }),
  tool(async (a: Record<string, unknown>) => (await runTool("build_deck", a)).text, {
    name: "build_deck",
    description:
      "テーマに基づいてデッキを自動構築します。文明指定(例: 火文明中心)は civilizations に、速攻など低コスト寄せは max_cost に必ず反映してください。",
    schema: z.object({
      theme: z.string().describe("デッキテーマ"),
      format: z.enum(["original", "advance"]).optional().describe("フォーマット"),
      required_cards: z.array(z.string()).optional().describe("必須カード名リスト"),
      civilizations: z
        .array(z.enum(CIVILIZATIONS))
        .optional()
        .describe('中心となる文明の内部コード配列 (例: ["fire"] や ["fire","nature"])'),
      max_cost: z.number().optional().describe("最大コスト。速攻なら低め(例: 5)を指定"),
      min_creatures: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("クリーチャーの最低枚数。未指定なら40枚デッキの55%(22枚)"),
    }),
  }),
  tool(async (a: Record<string, unknown>) => (await runTool("get_tier_list", a)).text, {
    name: "get_tier_list",
    description: "環境のティアリストを取得します",
    schema: z.object({
      format: z.enum(["original", "advance"]).optional().describe("フォーマット"),
      period: z.string().optional().describe("期間 (例: 2w, 4w)"),
    }),
  }),
  tool(async (a: Record<string, unknown>) => (await runTool("suggest_improvements", a)).text, {
    name: "suggest_improvements",
    description: "デッキの改善提案を行います",
    schema: z.object({
      decklist: z.string().describe("デッキリスト"),
      goals: z.array(z.string()).optional().describe("改善目標 (例: 受け強化, 速度アップ)"),
    }),
  }),
];
