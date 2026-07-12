import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// generateContent のモック (テストごとに挙動を差し替える)
const generateContentMock = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
  Type: { OBJECT: "OBJECT", STRING: "STRING", ARRAY: "ARRAY", NUMBER: "NUMBER" },
}));

function makeResponse(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

const schema = z.object({ name: z.string(), value: z.number() });

describe("generateStructured", () => {
  beforeEach(() => {
    generateContentMock.mockReset();
    process.env.GEMINI_API_KEY = "test-key";
  });

  it("正しい JSON を返すと parse された値が返る", async () => {
    const { generateStructured } = await import("../src/gemini.js");
    generateContentMock.mockResolvedValueOnce(
      makeResponse(JSON.stringify({ name: "a", value: 1 })),
    );
    const result = await generateStructured("p", schema, { responseSchema: {} });
    expect(result).toEqual({ name: "a", value: 1 });
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("1回目が不正 JSON、2回目が正しいとリトライして成功", async () => {
    const { generateStructured } = await import("../src/gemini.js");
    generateContentMock
      .mockResolvedValueOnce(makeResponse("not json"))
      .mockResolvedValueOnce(makeResponse(JSON.stringify({ name: "b", value: 2 })));
    const result = await generateStructured("p", schema, { responseSchema: {} });
    expect(result).toEqual({ name: "b", value: 2 });
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("2回とも Zod 不一致なら例外", async () => {
    const { generateStructured } = await import("../src/gemini.js");
    generateContentMock.mockResolvedValue(
      makeResponse(JSON.stringify({ name: "c" })), // value 欠落
    );
    await expect(generateStructured("p", schema, { responseSchema: {} })).rejects.toThrow(
      "構造化出力の検証に失敗しました",
    );
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("GEMINI_API_KEY 未設定なら getClient で例外", async () => {
    vi.resetModules();
    delete process.env.GEMINI_API_KEY;
    const { generateStructured } = await import("../src/gemini.js");
    await expect(generateStructured("p", schema, { responseSchema: {} })).rejects.toThrow(
      "GEMINI_API_KEY is not set",
    );
  });
});
