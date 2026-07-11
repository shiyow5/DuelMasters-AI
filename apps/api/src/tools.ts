import type { ToolDefinition } from "@dm-ai/core";

/** Gemini Function Calling 用ツール定義 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "search_rules",
    description: "デュエル・マスターズのルールや裁定を検索します",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索クエリ" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_cards",
    description: "カードを名前やテキストで検索します",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索クエリ" },
      },
      required: ["query"],
    },
  },
  {
    name: "evaluate_deck",
    description: "デッキリストを評価して診断結果を返します",
    parameters: {
      type: "object",
      properties: {
        decklist: { type: "string", description: "デッキリスト (テキスト形式)" },
        format: {
          type: "string",
          enum: ["original", "advance"],
          description: "フォーマット",
        },
      },
      required: ["decklist"],
    },
  },
  {
    name: "build_deck",
    description: "テーマに基づいてデッキを自動構築します",
    parameters: {
      type: "object",
      properties: {
        theme: { type: "string", description: "デッキテーマ" },
        format: {
          type: "string",
          enum: ["original", "advance"],
          description: "フォーマット",
        },
        required_cards: {
          type: "array",
          items: { type: "string" },
          description: "必須カード名リスト",
        },
      },
      required: ["theme"],
    },
  },
  {
    name: "get_tier_list",
    description: "環境のティアリストを取得します",
    parameters: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["original", "advance"],
          description: "フォーマット",
        },
      },
      required: [],
    },
  },
  {
    name: "suggest_improvements",
    description: "デッキの改善提案を行います",
    parameters: {
      type: "object",
      properties: {
        decklist: { type: "string", description: "デッキリスト" },
        goals: {
          type: "array",
          items: { type: "string" },
          description: "改善目標 (例: 受け強化, 速度アップ)",
        },
      },
      required: ["decklist"],
    },
  },
];
