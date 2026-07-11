import { describe, it, expect } from "vitest";
import { parseDecklist } from "../src/parser.js";
import { validateRegulation } from "../src/validator.js";

// DATABASE_URL 無しで実行される前提 (vitest.config.ts で強制)。
// 殿堂チェックはスキップされ、固定の警告文が返る。
const DB_SKIP_WARNING =
  "殿堂データベースに接続できないため、殿堂チェックをスキップしました";

function list(n: number, prefix = "カード"): string {
  const lines: string[] = [];
  let rest = n;
  let i = 1;
  while (rest > 0) {
    const c = Math.min(4, rest);
    lines.push(`${c} ${prefix}${i}`);
    rest -= c;
    i++;
  }
  return lines.join("\n");
}

describe("validateRegulation 特性テスト (DB無し)", () => {
  it("40枚ちょうどは valid", async () => {
    const deck = parseDecklist(list(40));
    expect(await validateRegulation(deck, "original")).toEqual({
      valid: true,
      errors: [],
      warnings: [DB_SKIP_WARNING],
    });
  });

  it("39枚は枚数エラー", async () => {
    const deck = parseDecklist(list(39));
    expect(await validateRegulation(deck, "original")).toEqual({
      valid: false,
      errors: ["デッキは40枚ちょうどである必要があります (現在: 39枚)"],
      warnings: [DB_SKIP_WARNING],
    });
  });

  it("同名5枚は上限エラー (合計40枚)", async () => {
    const deck = parseDecklist("5 過剰カード\n" + list(35, "カードX"));
    expect(await validateRegulation(deck, "original")).toEqual({
      valid: false,
      errors: ["「過剰カード」は最大4枚までです (現在: 5枚)"],
      warnings: [DB_SKIP_WARNING],
    });
  });
});
