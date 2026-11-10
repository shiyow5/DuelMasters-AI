import { describe, it, expect, vi } from "vitest";

/**
 * 生成オプションの固定 (F-1)。maxOutputTokens が外れると 1回の生成で課金が膨らむ。
 */

const ctorArgs: Array<Record<string, unknown>> = [];

vi.mock("@langchain/google-genai", () => ({
  ChatGoogleGenerativeAI: class {
    constructor(opts: Record<string, unknown>) {
      ctorArgs.push(opts);
    }
    bindTools() {
      return { withFallbacks: () => ({}) };
    }
  },
}));

describe("buildChatModel の生成オプション", () => {
  it("全モデルに maxOutputTokens: 2048 を渡す", async () => {
    const { buildChatModel, configureAgent, MAX_OUTPUT_TOKENS } = await import("../src/models.js");
    configureAgent({ apiKey: "dummy", chatModels: ["model-a", "model-b"] });
    buildChatModel([]);
    expect(MAX_OUTPUT_TOKENS).toBe(2048);
    expect(ctorArgs).toHaveLength(2);
    for (const opts of ctorArgs) expect(opts.maxOutputTokens).toBe(2048);
  });
});
