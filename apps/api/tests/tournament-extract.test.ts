import { describe, it, expect, vi } from "vitest";

const generateStructuredMock = vi.fn();
vi.mock("@dm-ai/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dm-ai/core")>();
  return { ...actual, generateStructured: generateStructuredMock };
});

const { extractTournament } = await import("../src/tournament-extract.js");

describe("extractTournament", () => {
  it("generateStructured を検証済みスキーマ・temperature 0 で呼び、結果を返す", async () => {
    const expected = {
      event_name: "CS",
      event_date: "2026-07-01",
      participants: 32,
      results: [{ deck_archetype: "アグロ", placement: 1 }],
    };
    generateStructuredMock.mockResolvedValueOnce(expected);

    const result = await extractTournament("大会結果ページのテキスト");
    expect(result).toEqual(expected);

    expect(generateStructuredMock).toHaveBeenCalledTimes(1);
    const [prompt, , opts] = generateStructuredMock.mock.calls[0];
    expect(prompt).toContain("大会結果ページのテキスト");
    expect(opts.responseSchema).toBeDefined();
    expect(opts.temperature).toBe(0);
  });
});
