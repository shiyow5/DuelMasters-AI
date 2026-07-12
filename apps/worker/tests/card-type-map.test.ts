import { describe, it, expect } from "vitest";
import { normalizeCardType } from "../src/card-type-map.js";

describe("normalizeCardType", () => {
  it("クリーチャー → creature", () => {
    expect(normalizeCardType("クリーチャー")).toBe("creature");
  });

  it("進化クリーチャー → creature", () => {
    expect(normalizeCardType("進化クリーチャー")).toBe("creature");
  });

  it("スター進化クリーチャー → star_evolution_creature", () => {
    expect(normalizeCardType("スター進化クリーチャー")).toBe("star_evolution_creature");
  });

  it("呪文 → spell", () => {
    expect(normalizeCardType("呪文")).toBe("spell");
  });

  it("タマシード/クリーチャー → creature (順序仕様: クリーチャーが先にマッチ)", () => {
    expect(normalizeCardType("タマシード/クリーチャー")).toBe("creature");
  });

  it("タマシード (単独) → tamaseed", () => {
    expect(normalizeCardType("タマシード")).toBe("tamaseed");
  });

  it("未知表記 → null", () => {
    expect(normalizeCardType("ツインパクト")).toBeNull();
  });
});
