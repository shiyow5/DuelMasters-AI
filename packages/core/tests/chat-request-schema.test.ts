import { describe, it, expect } from "vitest";
import {
  ChatRequestSchema,
  CHAT_HISTORY_MAX_CONTENT,
  CHAT_HISTORY_MAX_ITEMS,
  CHAT_HISTORY_MAX_TOTAL,
} from "../src/schemas.js";

/**
 * ChatRequestSchema.history の上限 (F-1)。
 *
 * 上限が無いと、1リクエストで巨大な文脈を Gemini に送らせてコストを吊り上げられる。
 */

const msg = (content: string, role: "user" | "assistant" = "user") => ({ role, content });

describe("ChatRequestSchema.history の上限", () => {
  it("上限ちょうどは通る (20件・1件 32,000 字・合計 64,000 字)", () => {
    const items = [
      msg("a".repeat(CHAT_HISTORY_MAX_CONTENT)),
      msg("b".repeat(CHAT_HISTORY_MAX_TOTAL - CHAT_HISTORY_MAX_CONTENT), "assistant"),
      ...Array.from({ length: CHAT_HISTORY_MAX_ITEMS - 2 }, () => msg("")),
    ];
    expect(ChatRequestSchema.safeParse({ message: "q", history: items }).success).toBe(true);
  });

  it("21件は失敗する", () => {
    const items = Array.from({ length: CHAT_HISTORY_MAX_ITEMS + 1 }, () => msg("x"));
    expect(ChatRequestSchema.safeParse({ message: "q", history: items }).success).toBe(false);
  });

  it("content 32,001 字は失敗する", () => {
    const items = [msg("x".repeat(CHAT_HISTORY_MAX_CONTENT + 1))];
    expect(ChatRequestSchema.safeParse({ message: "q", history: items }).success).toBe(false);
  });

  it("合計 64,001 字は失敗する (1件ずつは上限内でも)", () => {
    const items = [
      msg("x".repeat(CHAT_HISTORY_MAX_CONTENT)),
      msg("y".repeat(CHAT_HISTORY_MAX_CONTENT), "assistant"),
      msg("z"),
    ];
    expect(ChatRequestSchema.safeParse({ message: "q", history: items }).success).toBe(false);
  });

  it("history 省略時は空配列になる", () => {
    const parsed = ChatRequestSchema.parse({ message: "q" });
    expect(parsed.history).toEqual([]);
  });
});
