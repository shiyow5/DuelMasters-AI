import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from "./api";
import type { Citation } from "./types";

/** 会話履歴 (#110)。所有者チェックは api 側が SQL の WHERE で行う。 */

export interface ConversationSummary {
  id: string;
  title: string;
  mode: string;
  message_count: number;
  updated_at: string;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  helpful?: boolean;
  created_at: string;
}

export interface ConversationDetail extends ConversationSummary {
  messages: StoredMessage[];
}

/**
 * 会話のタイトルを最初の質問から作る。
 *
 * LLM を呼ぶ必要はない (1回の質問に1回の課金が乗るだけで、得るものが少ない)。
 * 改行で切って先頭 N 文字。空なら日付でフォールバックする。
 */
export const TITLE_MAX = 40;
export function titleFromMessage(message: string): string {
  const firstLine =
    message
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  if (firstLine === "") return "新しい会話";
  return firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX)}…` : firstLine;
}

export const listConversations = () =>
  apiGet<{ conversations: ConversationSummary[] }>("/api/conversations").then(
    (r) => r.conversations,
  );

export const createConversation = (title: string, mode: string) =>
  apiPost<ConversationSummary>("/api/conversations", { title, mode });

export const getConversation = (id: string) =>
  apiGet<ConversationDetail>(`/api/conversations/${id}`);

export const renameConversation = (id: string, title: string) =>
  apiPatch<ConversationSummary>(`/api/conversations/${id}`, { title });

export const deleteConversation = (id: string) =>
  apiDelete<{ ok: true }>(`/api/conversations/${id}`);

/**
 * 「役に立った / 立たなかった」を保存する。
 * **eval に直結する** — 低評価が付いた質問は golden set の候補になる。
 */
export const sendFeedback = (conversationId: string, messageId: string, helpful: boolean) =>
  apiPut<{ ok: true }>(`/api/conversations/${conversationId}/messages/${messageId}/feedback`, {
    helpful,
  });
