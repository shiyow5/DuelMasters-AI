import { describe, it, expect } from "vitest";
import { ChatRequestSchema, DeckBuildRequestSchema } from "../src/schemas.js";

/**
 * zod 3→4 移行で挙動が変わりうる境界・既定値の回帰テスト。
 * (min/max の境界、.default() の適用、.uuid() の厳格化、日本語カスタムメッセージ)
 */

describe("ChatRequestSchema.message の長さ境界", () => {
  it.each([
    [0, false],
    [1, true],
    [32_000, true],
    [32_001, false],
  ])("%i 字 → success=%s", (len, ok) => {
    expect(ChatRequestSchema.safeParse({ message: "a".repeat(len) }).success).toBe(ok);
  });

  it("空文字・超過のメッセージは日本語のカスタムメッセージのまま出る", () => {
    const empty = ChatRequestSchema.safeParse({ message: "" });
    const long = ChatRequestSchema.safeParse({ message: "a".repeat(32_001) });
    expect(empty.success ? [] : empty.error.issues.map((i) => i.message)).toEqual([
      "message は必須です",
    ]);
    expect(long.success ? [] : long.error.issues.map((i) => i.message)).toEqual([
      "message が長すぎます",
    ]);
  });

  it("issue の path は配列で、history の要素位置まで入る", () => {
    const r = ChatRequestSchema.safeParse({
      message: "q",
      history: [{ role: "user", content: "x".repeat(32_001) }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(["history", 0, "content"]);
    }
  });
});

describe("ChatRequestSchema.conversationId (.uuid())", () => {
  it("RFC 9562 準拠の UUID (v4) は通る", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(ChatRequestSchema.safeParse({ message: "q", conversationId: id }).success).toBe(true);
  });
  it("UUID でない文字列は失敗する", () => {
    expect(ChatRequestSchema.safeParse({ message: "q", conversationId: "abc" }).success).toBe(
      false,
    );
  });
});

describe("DeckBuildRequestSchema の既定値", () => {
  it("format 省略 → 'original'", () => {
    expect(DeckBuildRequestSchema.parse({ theme: "速攻" }).format).toBe("original");
  });
  it("constraints 省略 → {}", () => {
    expect(DeckBuildRequestSchema.parse({ theme: "速攻" }).constraints).toEqual({});
  });
  it("minCreatures: 0 は失敗、1 は通る", () => {
    const at = (n: number) =>
      DeckBuildRequestSchema.safeParse({ theme: "速攻", constraints: { minCreatures: n } }).success;
    expect(at(0)).toBe(false);
    expect(at(1)).toBe(true);
  });
});
