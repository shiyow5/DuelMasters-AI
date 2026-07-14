import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { CIVILIZATIONS, CARD_TYPES } from "@dm-ai/core";
import { searchRules } from "@dm-ai/rag";
import {
  parseDecklist,
  scoreDeck,
  validateRegulation,
  autoBuild,
  suggestReplacements,
} from "@dm-ai/deck-engine";
import { getSql } from "@dm-ai/db";
import { buildCardSearchArgs, normalizeCardName } from "./card-search.js";
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

function resolveFormat(value: unknown, fallback?: string): Format {
  const v = (value as string) ?? fallback ?? "original";
  return v === "advance" ? "advance" : "original";
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
        const text = result.chunks
          .map((ch) => `${ch.meta.article ? `[${ch.meta.article}] ` : ""}${ch.text}`)
          .join("\n\n");
        const citations: Citation[] = result.chunks.map((ch) => ({
          text: ch.text.slice(0, 100),
          ...ch.meta,
        }));
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
         * DB 側の name にも同じ正規化 (中黒・空白・囲みを落として小文字化) をかける。
         * これをやらないと素朴な部分一致が 0件になり、agent がそれを「ツールのエラー」と
         * 誤解して「一時的なエラーが発生している」と誤報する (本番で実際に起きた)。
         */
        const normalized = query ? normalizeCardName(query) : "";
        const nameFrag = query
          ? sql`AND (
              lower(translate(name, '・･ 　《》「」『』【】', '')) LIKE ${"%" + normalized + "%"}
              OR text ILIKE ${"%" + query + "%"}
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
        const text = rows
          .map(
            (r) =>
              `${r.name} (${r.cost}コスト, ${(r.civilizations as string[]).join("/")}, ${r.type}): ${String(r.text ?? "").slice(0, 100)}`,
          )
          .join("\n");
        return { text };
      }

      case "evaluate_deck": {
        const deck = parseDecklist(args.decklist as string);
        const fmt = resolveFormat(args.format, format);
        const [score, validation] = await Promise.all([
          scoreDeck(deck),
          validateRegulation(deck, fmt),
        ]);
        return { text: JSON.stringify({ score, validation }, null, 2) };
      }

      case "build_deck": {
        // 文明・最大コストは autoBuild の制約に渡す。自然文の theme だけでは
        // 「火文明中心の速攻」等の意図が ILIKE に載らず文明無視のデッキになるため、
        // モデルが抽出した civilizations / max_cost を構造化制約として明示的に渡す。
        // グラフの tools ノードは zod schema を通さず args を直接渡すのでここで検証する。
        // 不正な文明コード (例: 日本語の "火") を黙って捨てると制約なしで構築が走り、
        // まさに防ぎたい混色デッキが返るため、引数エラーとしてモデルに再指定させる。
        const schema = z.object({
          theme: z.string(),
          format: z.enum(["original", "advance"]).optional(),
          required_cards: z.array(z.string()).optional(),
          civilizations: z.array(z.enum(CIVILIZATIONS)).nonempty().optional(),
          max_cost: z.number().optional(),
          // .positive() は排他境界 (exclusiveMinimum) になり Gemini の function declaration が
          // 400 を返す。.min(1) で包含境界にする。
          min_creatures: z.number().int().min(1).optional(),
        });
        const parsed = schema.safeParse(args);
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
        const snapshots = await sql`
          SELECT tier_data, period_start, period_end
          FROM meta_snapshots
          WHERE format = ${fmt} AND period_end >= ${cutoffStr}
          ORDER BY period_end DESC
          LIMIT 1
        `;
        if (snapshots.length === 0) return { text: "ティアデータがまだありません" };
        return { text: JSON.stringify(snapshots[0].tier_data, null, 2) };
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
