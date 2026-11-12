import { describe, it, expect } from "vitest";
import {
  DeckParseRequestSchema,
  DeckEvaluateRequestSchema,
  DeckBuildRequestSchema,
  DeckSuggestRequestSchema,
  DeckSaveRequestSchema,
  DECKLIST_MAX_LENGTH,
  DECK_THEME_MAX_LENGTH,
  DECK_CARD_NAME_MAX_LENGTH,
  DECK_CARD_LIST_MAX_ITEMS,
  DECK_CIVILIZATIONS_MAX_ITEMS,
  DECK_CIVILIZATION_MAX_LENGTH,
  DECK_MAX_COST_LIMIT,
  DECK_GOALS_MAX_ITEMS,
  DECK_GOAL_MAX_LENGTH,
} from "../src/schemas.js";

/** #253 (R8 M-1): deck 系リクエストの入力サイズ上限。上限ちょうどは通り、+1 で落ちる。 */
const s = (n: number) => "あ".repeat(n);
const arr = (n: number, len = 1) => Array.from({ length: n }, () => s(len));
const ok = (r: { success: boolean }) => expect(r.success).toBe(true);
const ng = (r: { success: boolean }) => expect(r.success).toBe(false);

describe("decklist の上限 (parse / evaluate / suggest / save)", () => {
  const cases: Array<[string, (d: string) => { success: boolean }]> = [
    ["parse", (d) => DeckParseRequestSchema.safeParse({ decklist: d })],
    ["evaluate", (d) => DeckEvaluateRequestSchema.safeParse({ decklist: d })],
    ["suggest", (d) => DeckSuggestRequestSchema.safeParse({ decklist: d })],
    ["save", (d) => DeckSaveRequestSchema.safeParse({ title: "t", decklist: d })],
  ];
  for (const [name, run] of cases) {
    it(`${name}: 上限ちょうどは OK、+1 は失敗`, () => {
      ok(run(s(DECKLIST_MAX_LENGTH)));
      ng(run(s(DECKLIST_MAX_LENGTH + 1)));
    });
  }
});

describe("DeckBuildRequestSchema の上限", () => {
  const build = (constraints: Record<string, unknown>, theme = "火") =>
    DeckBuildRequestSchema.safeParse({ theme, constraints });

  it("theme", () => {
    ok(build({}, s(DECK_THEME_MAX_LENGTH)));
    ng(build({}, s(DECK_THEME_MAX_LENGTH + 1)));
  });
  for (const key of ["requiredCards", "excludeCards"]) {
    it(`${key}: 件数と各要素の長さ`, () => {
      ok(build({ [key]: arr(DECK_CARD_LIST_MAX_ITEMS) }));
      ng(build({ [key]: arr(DECK_CARD_LIST_MAX_ITEMS + 1) }));
      ok(build({ [key]: [s(DECK_CARD_NAME_MAX_LENGTH)] }));
      ng(build({ [key]: [s(DECK_CARD_NAME_MAX_LENGTH + 1)] }));
    });
  }
  it("civilizations: 件数と各要素の長さ", () => {
    ok(build({ civilizations: arr(DECK_CIVILIZATIONS_MAX_ITEMS) }));
    ng(build({ civilizations: arr(DECK_CIVILIZATIONS_MAX_ITEMS + 1) }));
    ok(build({ civilizations: [s(DECK_CIVILIZATION_MAX_LENGTH)] }));
    ng(build({ civilizations: [s(DECK_CIVILIZATION_MAX_LENGTH + 1)] }));
  });
  it("maxCost: 0〜99 の整数", () => {
    ok(build({ maxCost: 0 }));
    ok(build({ maxCost: DECK_MAX_COST_LIMIT }));
    ng(build({ maxCost: DECK_MAX_COST_LIMIT + 1 }));
    ng(build({ maxCost: -1 }));
    ng(build({ maxCost: 5.5 }));
  });
});

describe("DeckSuggestRequestSchema goals の上限", () => {
  const suggest = (goals: string[]) =>
    DeckSuggestRequestSchema.safeParse({ decklist: "4 A", goals });
  it("件数と各要素の長さ", () => {
    ok(suggest(arr(DECK_GOALS_MAX_ITEMS)));
    ng(suggest(arr(DECK_GOALS_MAX_ITEMS + 1)));
    ok(suggest([s(DECK_GOAL_MAX_LENGTH)]));
    ng(suggest([s(DECK_GOAL_MAX_LENGTH + 1)]));
  });
});
