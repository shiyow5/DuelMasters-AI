import { describe, it, expect } from "vitest";
import { timingSafeEqual } from "../src/middleware/timing-safe-equal.js";

describe("timingSafeEqual", () => {
  it("同じ文字列は true", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
  });

  it("異なる文字列は false", () => {
    expect(timingSafeEqual("abc", "abd")).toBe(false);
  });

  it("片方が空文字なら false (長さが異なる)", () => {
    expect(timingSafeEqual("abc", "")).toBe(false);
  });

  it("長さが異なる文字列は false", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("日本語も正しく比較できる", () => {
    expect(timingSafeEqual("こんにちは", "こんにちは")).toBe(true);
    expect(timingSafeEqual("こんにちは", "こんいちは")).toBe(false);
  });

  it("undefined/null は false", () => {
    expect(timingSafeEqual(undefined, "abc")).toBe(false);
    expect(timingSafeEqual("abc", undefined)).toBe(false);
    expect(timingSafeEqual(null, null)).toBe(false);
  });

  it("接頭辞一致でも長さが違えば false", () => {
    expect(timingSafeEqual("abcd", "abc")).toBe(false);
    expect(timingSafeEqual("abc", "abc\0")).toBe(false);
  });
});
