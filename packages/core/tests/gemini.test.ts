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

/** レート制限を模した @google/genai 風エラー (status プロパティ付き) */
function rateLimitError(message = "got status: 429 RESOURCE_EXHAUSTED") {
  return Object.assign(new Error(message), { status: 429 });
}

describe("isRetryableModelError", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.GEMINI_API_KEY = "test-key";
  });

  it("429 / 503 / RESOURCE_EXHAUSTED / overloaded は true", async () => {
    const { isRetryableModelError } = await import("../src/gemini.js");
    expect(isRetryableModelError({ status: 429 })).toBe(true);
    expect(isRetryableModelError({ status: 503 })).toBe(true);
    expect(isRetryableModelError({ code: 429 })).toBe(true);
    expect(isRetryableModelError(rateLimitError())).toBe(true);
    expect(isRetryableModelError(new Error("the model is overloaded, UNAVAILABLE"))).toBe(true);
  });

  it("400 / 一般エラー / null / undefined は false", async () => {
    const { isRetryableModelError } = await import("../src/gemini.js");
    expect(isRetryableModelError({ status: 400 })).toBe(false);
    expect(isRetryableModelError(new Error("invalid request"))).toBe(false);
    expect(isRetryableModelError(null)).toBe(false);
    expect(isRetryableModelError(undefined)).toBe(false);
  });
});

describe("chat モデルフォールバック", () => {
  beforeEach(() => {
    vi.resetModules();
    generateContentMock.mockReset();
    process.env.GEMINI_API_KEY = "test-key";
    delete process.env.GEMINI_CHAT_MODELS;
  });

  it("1つ目(Gemma)が429なら2つ目(flash-lite)へフォールバックして成功", async () => {
    const { chat } = await import("../src/gemini.js");
    generateContentMock
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce(makeResponse("ok"));
    const res = await chat([{ role: "user", content: "hi" }]);
    expect(res.text).toBe("ok");
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(generateContentMock.mock.calls[0][0].model).toBe("gemma-4-31b-it");
    expect(generateContentMock.mock.calls[1][0].model).toBe("gemini-2.5-flash-lite");
  });

  it("非リトライ系(400)はフォールバックせず即失敗", async () => {
    const { chat } = await import("../src/gemini.js");
    generateContentMock.mockRejectedValueOnce(
      Object.assign(new Error("bad request"), { status: 400 }),
    );
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toThrow("bad request");
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("全モデルが429なら最後のエラーを投げる", async () => {
    const { chat } = await import("../src/gemini.js");
    generateContentMock.mockRejectedValue(rateLimitError("429 all exhausted"));
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toThrow("429 all exhausted");
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("1つ目が成功すれば1回のみ・Gemma を使用", async () => {
    const { chat } = await import("../src/gemini.js");
    generateContentMock.mockResolvedValueOnce(makeResponse("hello"));
    const res = await chat([{ role: "user", content: "hi" }]);
    expect(res.text).toBe("hello");
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    expect(generateContentMock.mock.calls[0][0].model).toBe("gemma-4-31b-it");
  });

  it("GEMINI_CHAT_MODELS 環境変数でチェーンを上書きできる", async () => {
    process.env.GEMINI_CHAT_MODELS = "model-x, model-y";
    const { chat } = await import("../src/gemini.js");
    generateContentMock
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce(makeResponse("z"));
    const res = await chat([{ role: "user", content: "hi" }]);
    expect(res.text).toBe("z");
    expect(generateContentMock.mock.calls[0][0].model).toBe("model-x");
    expect(generateContentMock.mock.calls[1][0].model).toBe("model-y");
  });
});

describe("generateStructured モデルフォールバック", () => {
  beforeEach(() => {
    vi.resetModules();
    generateContentMock.mockReset();
    process.env.GEMINI_API_KEY = "test-key";
    delete process.env.GEMINI_STRUCTURED_MODELS;
  });

  it("1つ目(flash-lite)が429なら2つ目(flash)へフォールバックして成功", async () => {
    const { generateStructured } = await import("../src/gemini.js");
    generateContentMock
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce(makeResponse(JSON.stringify({ name: "a", value: 1 })));
    const res = await generateStructured("p", schema, { responseSchema: {} });
    expect(res).toEqual({ name: "a", value: 1 });
    expect(generateContentMock.mock.calls[0][0].model).toBe("gemini-2.5-flash-lite");
    expect(generateContentMock.mock.calls[1][0].model).toBe("gemini-2.5-flash");
  });

  it("構造化チェーンは Gemma を含まない (responseSchema 非対応のため)", async () => {
    const { STRUCTURED_MODEL_CHAIN } = await import("../src/gemini.js");
    expect(STRUCTURED_MODEL_CHAIN.some((m: string) => m.startsWith("gemma"))).toBe(false);
  });
});
