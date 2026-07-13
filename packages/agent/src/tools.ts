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
import type { Citation } from "./state.js";

export interface ToolResult {
  /** モデルへ返すテキスト結果 */
  text: string;
  /** UI へ添える引用 (search_rules のみ) */
  citations?: Citation[];
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
        const schema = z.object({
          query: z.string(),
          civilization: z.enum(CIVILIZATIONS).optional(),
          max_cost: z.number().optional(),
          type: z.enum(CARD_TYPES).optional(),
        });
        const parsed = schema.safeParse(args);
        if (!parsed.success) {
          return {
            text: `ツール引数が不正です: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join(", ")}`,
          };
        }
        const { query, civilization, max_cost, type } = parsed.data;
        const sql = getSql();
        const civFrag = civilization
          ? sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(civilizations) c WHERE c = ${civilization})`
          : sql``;
        const costFrag = max_cost !== undefined ? sql`AND cost <= ${max_cost}` : sql``;
        const typeFrag = type ? sql`AND type = ${type}` : sql``;
        const rows = await sql`
          SELECT name, civilizations, cost, type, races, text, power
          FROM cards
          WHERE (name ILIKE ${"%" + query + "%"} OR text ILIKE ${"%" + query + "%"})
            ${civFrag} ${costFrag} ${typeFrag}
          LIMIT 10
        `;
        const text = rows
          .map(
            (r) =>
              `${r.name} (${r.cost}コスト, ${(r.civilizations as string[]).join("/")}): ${(r.text as string).slice(0, 100)}`,
          )
          .join("\n");
        return { text: text || "該当するカードが見つかりませんでした" };
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
          return {
            text: `ツール引数が不正です: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join(", ")}`,
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
        return { text: `不明なツール: ${name}` };
    }
  } catch (err) {
    console.error(`[agent] ツール実行エラー (${name}):`, err);
    return { text: "ツール実行中にエラーが発生しました。しばらくしてから再度お試しください。" };
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
    description: "カードを名前やテキストで検索します",
    schema: z.object({
      query: z.string().describe("検索クエリ"),
      civilization: z.enum(CIVILIZATIONS).optional().describe("文明フィルタ"),
      max_cost: z.number().optional().describe("最大コスト"),
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
