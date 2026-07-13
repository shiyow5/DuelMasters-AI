import { describe, it, expect } from "vitest";
import { DeckBuildRequestSchema } from "../src/schemas.js";

describe("DeckBuildRequestSchema", () => {
  it("constraints をすべて素通しする (未知キーは黙って捨てられるため取りこぼしに注意)", () => {
    const parsed = DeckBuildRequestSchema.parse({
      theme: "火の速攻",
      constraints: {
        requiredCards: ["A"],
        excludeCards: ["B"],
        civilizations: ["fire"],
        maxCost: 5,
        minCreatures: 24,
      },
    });
    expect(parsed.constraints).toEqual({
      requiredCards: ["A"],
      excludeCards: ["B"],
      civilizations: ["fire"],
      maxCost: 5,
      minCreatures: 24,
    });
  });

  it("minCreatures は省略できる", () => {
    const parsed = DeckBuildRequestSchema.parse({ theme: "火の速攻" });
    expect(parsed.constraints.minCreatures).toBeUndefined();
  });

  it("minCreatures が非正の整数なら弾く", () => {
    expect(() =>
      DeckBuildRequestSchema.parse({ theme: "x", constraints: { minCreatures: 0 } }),
    ).toThrow();
  });
});
