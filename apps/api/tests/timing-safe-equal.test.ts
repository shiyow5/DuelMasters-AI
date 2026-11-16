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

  it("双方空文字は false (空キーを一致扱いにしない)", () => {
    expect(timingSafeEqual("", "")).toBe(false);
  });

  it("型不正 (数値・オブジェクト) は false", () => {
    expect(timingSafeEqual(123 as unknown as string, "123")).toBe(false);
    expect(timingSafeEqual({} as unknown as string, {} as unknown as string)).toBe(false);
  });

  it("長い入力: 上限以内は比較でき、上限超過は false", () => {
    const ok = "a".repeat(1024);
    expect(timingSafeEqual(ok, ok)).toBe(true);
    const tooLong = "a".repeat(1025);
    expect(timingSafeEqual(tooLong, tooLong)).toBe(false);
  });

  it("固定長 ASCII (hex) キーの一致 / 1文字違い", () => {
    const key = Array.from({ length: 64 }, (_, i) => ((i * 7) % 16).toString(16)).join("");
    expect(timingSafeEqual(key, key)).toBe(true);
    expect(timingSafeEqual(key, key.slice(0, -1) + "0")).toBe(false);
  });

  it("孤立サロゲートは別物でも衝突せず false", () => {
    expect(timingSafeEqual("\uD800", "\uD801")).toBe(false);
    expect(timingSafeEqual("\uD800", "\uD800")).toBe(false);
  });
});
