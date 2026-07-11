import { Hono } from "hono";
import { chat, ChatRequestSchema, type ChatMode } from "@dm-ai/core";
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
        details: parsed.error.issues.map(
          (i) => `${i.path.join(".")}: ${i.message}`
        ),
      },
      400
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

  // ツール呼び出しがある場合は実行
  if (response.toolCalls && response.toolCalls.length > 0) {
    const toolResults: string[] = [];

    for (const toolCall of response.toolCalls) {
      const result = await executeToolCall(
        toolCall.name,
        toolCall.args,
        format
      );
      toolResults.push(`[${toolCall.name}の結果]\n${result}`);
    }

    // ツール結果を含めて再度 Gemini に問い合わせ
    const followUp = await chat(
      [
        ...messages,
        { role: "assistant", content: response.text || "ツールを実行しています..." },
        {
          role: "user",
          content: `ツール実行結果:\n${toolResults.join("\n\n")}\n\nこの結果を踏まえてユーザーの質問に回答してください。`,
        },
      ],
      { systemPrompt, temperature: 0.3 }
    );

    return c.json({
      response: followUp.text,
      toolCalls: response.toolCalls,
      mode,
    });
  }

  // ルールモードの場合は RAG 結果を付加
  if (mode === "rule") {
    const searchResult = await searchRules(message);
    if (searchResult.chunks.length > 0) {
      const context = searchResult.chunks
        .map(
          (ch, i) =>
            `[${i + 1}] ${ch.meta.article ? `条${ch.meta.article}: ` : ""}${ch.text}`
        )
        .join("\n\n");

      const ragResponse = await chat(
        [
          ...messages,
          {
            role: "user",
            content: `以下のルール条文を参考に回答してください:\n\n${context}`,
          },
        ],
        { systemPrompt, temperature: 0.2 }
      );

      return c.json({
        response: ragResponse.text,
        citations: searchResult.chunks.map((ch) => ({
          text: ch.text.slice(0, 100),
          ...ch.meta,
        })),
        mode,
      });
    }
  }

  return c.json({
    response: response.text,
    mode,
  });
});

async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  format?: string
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
        const sql = getSql();
        const query = args.query as string;
        const rows = await sql`
          SELECT name, civilizations, cost, type, races, text, power
          FROM cards
          WHERE name ILIKE ${"%" + query + "%"}
             OR text ILIKE ${"%" + query + "%"}
          LIMIT 10
        `;
        return rows
          .map(
            (r) =>
              `${r.name} (${r.cost}コスト, ${(r.civilizations as string[]).join("/")}): ${(r.text as string).slice(0, 100)}`
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
          { requiredCards: args.required_cards as string[] }
        );
        return JSON.stringify(result, null, 2);
      }

      case "get_tier_list": {
        const sql = getSql();
        const fmt = (args.format as string) ?? format ?? "original";
        const snapshots = await sql`
          SELECT tier_data, period_start, period_end
          FROM meta_snapshots
          WHERE format = ${fmt}
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
    return `ツール実行エラー: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export { chatRouter };
