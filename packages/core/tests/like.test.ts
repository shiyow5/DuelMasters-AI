import { describe, it, expect } from "vitest";
import { escapeLike, likeContains } from "../src/like.js";

describe("escapeLike (#170)", () => {
  it.each([
    ["100%", "100\\%"],
    ["a_b", "a\\_b"],
    ["c:\\x", "c:\\\\x"],
    ["%_\\", "\\%\\_\\\\"],
    ["ボルメテウス", "ボルメテウス"],
    ["", ""],
  ])("%j → %j", (input, expected) => {
    expect(escapeLike(input)).toBe(expected);
  });

  it("likeContains は前後に % を付ける (中身はエスケープ済み)", () => {
    expect(likeContains("100%")).toBe("%100\\%%");
  });
});
