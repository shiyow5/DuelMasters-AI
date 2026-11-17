import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

/**
 * generateStructured (zodSchema: z.ZodType<T> + zodSchema.parse(JSON.parse(text))) の戻り値/例外の契約。
 * Issue #297 PR-2 / テスト観点 6。zod 3→4 の移行前に現行 (v3) の挙動を固定する。
 *
 * **Gemini API はモック** (@google/genai を差し替え。実 API は呼ばない。課金が発生するため)。
 * zod のエラー本文 (ZodError の文字列表現) は v3/v4 で変わるので固定しない。
 * 固定するのは「どの入力で・何回呼んで・どの接頭辞の例外か」と「成功時の戻り値」。
 */

const generateContentMock = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
  Type: { OBJECT: "OBJECT", STRING: "STRING", ARRAY: "ARRAY", NUMBER: "NUMBER" },
}));

const PREFIX = "構造化出力の検証に失敗しました";

function res(...texts: string[]) {
  return { candidates: [{ content: { parts: texts.map((text) => ({ text })) } }] };
}

const schema = z.object({
  name: z.string(),
  score: z.number().int().min(0).max(100),
  kind: z.enum(["a", "b"]),
});

async function load() {
  return (await import("../src/gemini.js")).generateStructured;
}

beforeEach(() => {
  vi.resetModules();
  generateContentMock.mockReset();
  process.env.GEMINI_API_KEY = "test-key";
});

describe("generateStructured: 戻り値", () => {
  it("正常な JSON は parse 済みの値を返し、1回しか呼ばない", async () => {
    const gen = await load();
    generateContentMock.mockResolvedValueOnce(
      res(JSON.stringify({ name: "x", score: 80, kind: "a" })),
    );
    await expect(gen("p", schema, { responseSchema: {} })).resolves.toEqual({
      name: "x",
      score: 80,
      kind: "a",
    });
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("未知のキーは落とされる (zod 既定の strip)", async () => {
    const gen = await load();
    generateContentMock.mockResolvedValueOnce(
      res(JSON.stringify({ name: "x", score: 1, kind: "b", extra: true })),
    );
    const out = await gen("p", schema, { responseSchema: {} });
    expect(out).toEqual({ name: "x", score: 1, kind: "b" });
    expect(out).not.toHaveProperty("extra");
  });

  it("default / transform を持つスキーマは変換後の値を返す", async () => {
    const gen = await load();
    const s = z.object({
      n: z.string().transform((v) => v.toUpperCase()),
      m: z.number().default(7),
    });
    generateContentMock.mockResolvedValueOnce(res(JSON.stringify({ n: "ab" })));
    await expect(gen("p", s, { responseSchema: {} })).resolves.toEqual({ n: "AB", m: 7 });
  });

  it("複数 part に分かれた text は連結してから JSON.parse される", async () => {
    const gen = await load();
    generateContentMock.mockResolvedValueOnce(res('{"name":"x","sco', 're":5,"kind":"a"}'));
    await expect(gen("p", schema, { responseSchema: {} })).resolves.toEqual({
      name: "x",
      score: 5,
      kind: "a",
    });
  });

  it("responseSchema / JSON mime type / 任意オプションが generateContent の config に渡る", async () => {
    const gen = await load();
    const responseSchema = { type: "OBJECT", properties: { name: { type: "STRING" } } };
    generateContentMock.mockResolvedValueOnce(
      res(JSON.stringify({ name: "x", score: 1, kind: "a" })),
    );
    await gen("p", schema, {
      responseSchema,
      systemPrompt: "sys",
      temperature: 0.2,
      maxTokens: 123,
    });
    const arg = generateContentMock.mock.calls[0][0];
    expect(arg.config).toEqual({
      responseMimeType: "application/json",
      responseSchema,
      systemInstruction: "sys",
      temperature: 0.2,
      maxOutputTokens: 123,
    });
    expect(arg.contents).toEqual([{ role: "user", parts: [{ text: "p" }] }]);
  });
});

describe("generateStructured: スキーマ違反の JSON", () => {
  const violations: Array<[string, unknown]> = [
    ["必須欠落", { name: "x", score: 1 }],
    ["型違い", { name: "x", score: "80", kind: "a" }],
    ["範囲外 (max)", { name: "x", score: 101, kind: "a" }],
    ["範囲外 (min)", { name: "x", score: -1, kind: "a" }],
    ["小数 (int 違反)", { name: "x", score: 1.5, kind: "a" }],
    ["enum 外", { name: "x", score: 1, kind: "z" }],
    ["null", null],
    ["配列", []],
  ];

  it.each(violations)("%s: 2回試行して接頭辞付き Error を投げる", async (_label, body) => {
    const gen = await load();
    generateContentMock.mockResolvedValue(res(JSON.stringify(body)));
    const err = await gen("p", schema, { responseSchema: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.startsWith(PREFIX)).toBe(true);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("検証失敗はモデルフォールバックの対象外 (次のモデルへ進まず 2回で止まる)", async () => {
    const gen = await load();
    generateContentMock.mockResolvedValue(res(JSON.stringify({ name: 1 })));
    await expect(gen("p", schema, { responseSchema: {} })).rejects.toThrow(PREFIX);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    const models = new Set(generateContentMock.mock.calls.map((c) => c[0].model));
    expect(models.size).toBe(1);
  });

  it("1回目が違反でも 2回目が正しければ成功する", async () => {
    const gen = await load();
    generateContentMock
      .mockResolvedValueOnce(res(JSON.stringify({ name: "x", score: 999, kind: "a" })))
      .mockResolvedValueOnce(res(JSON.stringify({ name: "x", score: 9, kind: "a" })));
    await expect(gen("p", schema, { responseSchema: {} })).resolves.toEqual({
      name: "x",
      score: 9,
      kind: "a",
    });
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });
});

describe("generateStructured: 壊れた JSON", () => {
  it.each([
    ["途中で切れた JSON (maxTokens 到達など)", '{"name":"x","score":'],
    ["JSON ではない文章", "申し訳ありません、回答できません"],
    ["コードフェンス付き", '```json\n{"name":"x","score":1,"kind":"a"}\n```'],
    ["空文字", ""],
  ])("%s: 2回試行して接頭辞付き Error (原因に SyntaxError) を投げる", async (_label, text) => {
    const gen = await load();
    generateContentMock.mockResolvedValue(res(text));
    const err = await gen("p", schema, { responseSchema: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.startsWith(PREFIX)).toBe(true);
    expect((err as Error).message).toContain("SyntaxError");
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("candidates が無い応答は空文字扱いで同様に失敗する", async () => {
    const gen = await load();
    generateContentMock.mockResolvedValue({ candidates: [] });
    await expect(gen("p", schema, { responseSchema: {} })).rejects.toThrow(PREFIX);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });
});
