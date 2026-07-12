import { Hono } from "hono";
import {
  chat,
  ChatRequestSchema,
  CIVILIZATIONS,
  CARD_TYPES,
  type ChatMode,
  type ChatResponse,
} from "@dm-ai/core";
import { z } from "zod";
import { searchRules } from "@dm-ai/rag";
import {
  parseDecklist,
  scoreDeck,
  validateRegulation,
  autoBuild,
  suggestReplacements,
} from "@dm-ai/deck-engine";
import { getSql } from "@dm-ai/db";
import { TOOL_DEFINITIONS } from "../tools.js";

const chatRouter = new Hono();

const SYSTEM_PROMPTS: Record<ChatMode, string> = {
  rule: `あなたはデュエル・マスターズのルール専門家です。
ユーザーのルールに関する質問に、公式ルールの条文を引用しながら正確に回答してください。
回答形式: 結論 → 根拠引用 → 例外 → 不確実な場合は「公式ジャッジに確認してください」`,

  deck: `あなたはデュエル・マスターズのデッキ構築アドバイザーです。
デッキの評価、構築アドバイス、改善提案を行います。
3大原則（S・トリガー、コストカーブ、文明バランス）を重視してアドバイスしてください。`,

  meta: `あなたはデュエル・マスターズの環境分析エキスパートです。
大会結果やメタゲームの分析を行い、ティア情報やアーキタイプの解説を提供します。`,

  integrated: `あなたはデュエル・マスターズの総合Q&Aアシスタントです。
ルール確認、デッキ構築支援、環境分析など、デュエル・マスターズに関するあらゆる質問に回答します。
必要に応じてツールを使用して正確な情報を提供してください。`,
};

chatRouter.post("/", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: "リクエストが不正です",
        details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      400,
    );
  }
  const { message, mode, history, format } = parsed.data;
  const messages = [...history, { role: "user" as const, content: message }];
  const systemPrompt = SYSTEM_PROMPTS[mode];
  const useTools = mode === "integrated";

  // Gemini にリクエスト
  const response = await chat(messages, {
    systemPrompt,
    tools: useTools ? TOOL_DEFINITIONS : undefined,
    temperature: 0.3,
  });

  if (response.toolCalls && response.toolCalls.length > 0) {
    const text = await chatWithToolResults(
      messages,
      response.toolCalls,
      systemPrompt,
      response.text,
      format,
    );
    return c.json({ response: text, toolCalls: response.toolCalls, mode });
  }

  if (mode === "rule") {
    const rag = await chatWithRuleContext(messages, message, systemPrompt);
    if (rag) {
      return c.json({ response: rag.text, citations: rag.citations, mode });
    }
  }

  return c.json({ response: response.text, mode });
});

/** ツール呼び出しを実行し、結果を踏まえた再問い合わせの応答文を返す */
async function chatWithToolResults(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  toolCalls: NonNullable<ChatResponse["toolCalls"]>,
  systemPrompt: string,
  responseText: string,
  format?: string,
): Promise<string> {
  const toolResults: string[] = [];
  for (const toolCall of toolCalls) {
    const result = await executeToolCall(toolCall.name, toolCall.args, format);
    toolResults.push(`[${toolCall.name}の結果]\n${result}`);
  }
  const followUp = await chat(
    [
      ...messages,
      { role: "assistant", content: responseText || "ツールを実行しています..." },
      {
        role: "user",
        content: `ツール実行結果:\n${toolResults.join("\n\n")}\n\nこの結果を踏まえてユーザーの質問に回答してください。`,
      },
    ],
    { systemPrompt, temperature: 0.3 },
  );
  return followUp.text;
}

/** rule モード: RAG 検索結果を付加して回答を生成する。ヒットが無ければ null */
async function chatWithRuleContext(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  query: string,
  systemPrompt: string,
): Promise<{ text: string; citations: Array<Record<string, unknown>> } | null> {
  const searchResult = await searchRules(query);
  if (searchResult.chunks.length === 0) return null;
  const context = searchResult.chunks
    .map((ch, i) => `[${i + 1}] ${ch.meta.article ? `条${ch.meta.article}: ` : ""}${ch.text}`)
    .join("\n\n");
  const ragResponse = await chat(
    [
      ...messages,
      {
        role: "user",
        content: `以下のルール条文を参考に回答してください:\n\n${context}`,
      },
    ],
    { systemPrompt, temperature: 0.2 },
  );
  return {
    text: ragResponse.text,
    citations: searchResult.chunks.map((ch) => ({
      text: ch.text.slice(0, 100),
      ...ch.meta,
    })),
  };
}

export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  format?: string,
): Promise<string> {
  try {
    switch (name) {
      case "search_rules": {
        const result = await searchRules(args.query as string);
        return result.chunks
          .map((ch) => `${ch.meta.article ? `[${ch.meta.article}] ` : ""}${ch.text}`)
          .join("\n\n");
      }

      case "search_cards": {
        // Gemini 出力なので必ず検証してから使う
        const schema = z.object({
          query: z.string(),
          civilization: z.enum(CIVILIZATIONS).optional(),
          max_cost: z.number().optional(),
          type: z.enum(CARD_TYPES).optional(),
        });
        const parsed = schema.safeParse(args);
        if (!parsed.success) {
          return `ツール引数が不正です: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join(", ")}`;
        }
        const { query, civilization, max_cost, type } = parsed.data;
        const sql = getSql();
        // 文明フィルタ: jsonb 配列に要素が含まれるか (? 演算子は避け、移植性の高い EXISTS 形で)
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
        return rows
          .map(
            (r) =>
              `${r.name} (${r.cost}コスト, ${(r.civilizations as string[]).join("/")}): ${(r.text as string).slice(0, 100)}`,
          )
          .join("\n");
      }

      case "evaluate_deck": {
        const deck = parseDecklist(args.decklist as string);
        const fmt = (args.format as string) ?? format ?? "original";
        const [score, validation] = await Promise.all([
          scoreDeck(deck),
          validateRegulation(deck, fmt as "original" | "advance"),
        ]);
        return JSON.stringify({ score, validation }, null, 2);
      }

      case "build_deck": {
        const result = await autoBuild(
          args.theme as string,
          ((args.format as string) ?? format ?? "original") as "original" | "advance",
          { requiredCards: args.required_cards as string[] },
        );
        return JSON.stringify(result, null, 2);
      }

      case "get_tier_list": {
        const sql = getSql();
        const fmt = (args.format as string) ?? format ?? "original";
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
        if (snapshots.length === 0) return "ティアデータがまだありません";
        return JSON.stringify(snapshots[0].tier_data, null, 2);
      }

      case "suggest_improvements": {
        const deck = parseDecklist(args.decklist as string);
        const goals = (args.goals as string[]) ?? [];
        const suggestions = await suggestReplacements(deck.entries, goals);
        return JSON.stringify(suggestions, null, 2);
      }

      default:
        return `不明なツール: ${name}`;
    }
  } catch (err) {
    // 生のエラー文言をユーザー/Gemini に渡さない (詳細はサーバーログのみ)
    console.error(`[api/chat] ツール実行エラー (${name}):`, err);
    return "ツール実行中にエラーが発生しました。しばらくしてから再度お試しください。";
  }
}

export { chatRouter };
