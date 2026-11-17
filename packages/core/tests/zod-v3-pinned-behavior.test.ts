import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  CardSchema,
  ChatRequestSchema,
  IngestUrlRequestSchema,
  TournamentResultSchema,
} from "../src/schemas.js";

/**
 * Issue #297 (zod 3→4) PR-1: 現行 v3 の挙動を固定する境界値テスト。
 * 期待値は **v3 の実挙動**。v4 に上げて落ちたら、それが v4 での差分 (意図的なら期待値を更新)。
 * 「v4 で変わる見込み」と付いたケースは差分が出る可能性が高いもの。
 */

const parses = (schema: z.ZodTypeAny, v: unknown) => schema.safeParse(v).success;

describe("coerce.number().int().positive() (deck /:id と同形)", () => {
  const S = z.coerce.number().int().positive();
  it.each([
    ["5", true],
    ["1", true],
    ["0", false],
    ["-1", false],
    ["5.5", false],
    ["1.0", true], // Number("1.0") === 1
    ["", false], // v3: Number("") === 0 → positive で落ちる
    ["abc", false],
    [" 5 ", true], // Number(" 5 ") === 5
    ["1e3", true],
    ["0x10", true], // Number("0x10") === 16
    ["Infinity", false],
    ["9007199254740991", true], // MAX_SAFE_INTEGER
    ["9007199254740992", true], // 超過でも v3 は .int() を通す (v4 で変わる見込み: safe integer 限定になる)
    ["1e21", true], // 同上 (v4 で変わる見込み)
  ])("入力 %j → success=%s", (v, ok) => {
    expect(parses(S, v)).toBe(ok);
  });

  it("coerce は null / undefined / 配列 / 真偽値を数値化する (v4 で変わる見込み: 入力型が unknown になるだけで挙動は同じはずだが要確認)", () => {
    expect(parses(S, null)).toBe(false); // Number(null) = 0
    expect(parses(S, undefined)).toBe(false); // NaN
    expect(parses(S, true)).toBe(true); // Number(true) = 1
    expect(parses(S, [5])).toBe(true); // Number([5]) = 5
  });
});

describe("number().int() の境界 (v4 で変わる見込み: 安全整数外は int() で失敗)", () => {
  const cost = (n: number) =>
    CardSchema.safeParse({ name: "x", civilizations: [], cost: n, type: "creature" }).success;
  it.each([
    [0, true],
    [-1, false],
    [1.5, false],
    [Number.MAX_SAFE_INTEGER, true],
    [Number.MAX_SAFE_INTEGER + 1, true], // v3 は通る。v4 で変わる見込み
    [Number.MAX_VALUE, true], // v4 で変わる見込み
    [Infinity, false],
    [NaN, false],
  ])("CardSchema.cost=%s → success=%s", (n, ok) => {
    expect(cost(n)).toBe(ok);
  });

  it("文字列 '5' は coerce でないので失敗する", () => {
    expect(
      CardSchema.safeParse({ name: "x", civilizations: [], cost: "5", type: "creature" }).success,
    ).toBe(false);
  });

  it("TournamentResultSchema.placement は 0 / 負数 / 小数 を弾く (.positive())", () => {
    const base = {
      event_name: "e",
      event_date: "2026-11-17",
      format: "original",
      deck_archetype: "a",
    };
    const at = (p: number) => TournamentResultSchema.safeParse({ ...base, placement: p }).success;
    expect([at(0), at(-1), at(1.5), at(1)]).toEqual([false, false, false, true]);
  });

  it("participants: nonnegative().nullable() は 0 と null を許す", () => {
    const base = {
      event_name: "e",
      event_date: "2026-11-17",
      format: "original",
      deck_archetype: "a",
      placement: 1,
    };
    const p = (v: unknown) => TournamentResultSchema.safeParse({ ...base, participants: v });
    expect(p(0).success).toBe(true);
    expect(p(null).success).toBe(true);
    expect(p(-1).success).toBe(false);
  });
});

describe("conversationId: z.string().uuid() — RFC 非準拠も v3 は通す", () => {
  const ok = (id: string) =>
    ChatRequestSchema.safeParse({ message: "q", conversationId: id }).success;
  it.each([
    ["123e4567-e89b-42d3-a456-426614174000", true], // v4 UUID
    ["018f1a2b-3c4d-7e5f-8a6b-7c8d9e0f1a2b", true], // v7 UUID
    ["00000000-0000-0000-0000-000000000000", true], // nil UUID: v4 でも通る
    ["ffffffff-ffff-ffff-ffff-ffffffffffff", true], // max UUID: v4 でも通る
    ["123e4567-e89b-02d3-a456-426614174000", true], // version=0 (規格外)。v4 で変わる見込み
    ["123e4567-e89b-92d3-a456-426614174000", true], // version=9 (規格外)。v4 で変わる見込み
    ["123e4567-e89b-42d3-0456-426614174000", true], // variant=0 (規格外)。v4 で変わる見込み
    ["123e4567-e89b-42d3-c456-426614174000", true], // variant=c (規格外)。v4 で変わる見込み
    ["123E4567-E89B-42D3-A456-426614174000", true], // 大文字
    ["123e4567e89b42d3a456426614174000", false], // ハイフン無し
    ["{123e4567-e89b-42d3-a456-426614174000}", false], // 波括弧
    ["123e4567-e89b-42d3-a456-42661417400", false], // 1 桁不足
    ["123e4567-e89b-42d3-a456-4266141740000", false], // 1 桁過剰
    ["123e4567-e89b-42d3-a456-42661417400g", false], // 非 16 進
    ["", false],
  ])("conversationId=%j → success=%s", (id, expected) => {
    expect(ok(id)).toBe(expected);
  });
});

describe("z.string().url() — v3 の挙動を固定 (v4 は URL パーサ依存で変わりうる)", () => {
  const ingest = (u: string) => IngestUrlRequestSchema.safeParse({ url: u }).success;
  it.each([
    ["https://example.com/a?b=1#c", true],
    ["http://example.com", true],
    ["https://localhost:3000/x", true],
    ["https://日本語.example/パス", true],
    ["ftp://example.com/file", true], // v3 は scheme を問わない
    ["javascript:alert(1)", true], // v3 は通る (ingest 側の別検査に依存)。v4 で変わる見込み
    ["mailto:a@example.com", true], // v4 で変わる見込み
    ["file:///etc/passwd", true], // v4 で変わる見込み
    ["example.com", false],
    ["//example.com", false],
    ["https://", false],
    ["", false],
    [" https://example.com", true], // 先頭空白: v3 は通る (new URL が trim する)。v4 で変わる見込み
  ])("IngestUrlRequestSchema.url=%j → success=%s", (u, expected) => {
    expect(ingest(u)).toBe(expected);
  });

  it("実運用で使う Supabase 画像 URL / 公式カード画像 URL が通る", () => {
    const card = { name: "x", civilizations: [], cost: 1, type: "creature" };
    for (const u of [
      "https://example.supabase.co/storage/v1/object/public/cards/a.jpg",
      "https://dm.takaratomy.co.jp/wp-content/card/cardthumb/dm01-001.jpg",
    ]) {
      expect(CardSchema.parse({ ...card, card_image_url: u }).card_image_url).toBe(u);
    }
  });
});

describe("default / optional / nullable の parse 出力 (キーの有無と値)", () => {
  const card = { name: "x", civilizations: [], cost: 1, type: "creature" };
  it("CardSchema: optional の id は省略時キー自体が無い、default 群は埋まる", () => {
    const out = CardSchema.parse(card);
    expect("id" in out).toBe(false);
    expect(out).toMatchObject({
      races: [],
      text: "",
      power: null,
      is_rainbow: false,
      is_shield_trigger: false,
      tags: [],
      card_image_url: null,
      official_id: null,
      set_code: null,
      rarity: null,
    });
  });
  it("optional に明示 undefined を渡してもキーは出力に残る/残らない を固定する", () => {
    const out = CardSchema.parse({ ...card, id: undefined });
    // v3: 明示 undefined のキーは出力に残る (v4 で変わる可能性あり。値は undefined のまま)
    expect(out.id).toBeUndefined();
    expect(Object.keys(out)).toContain("id");
  });
  it("nullable().default(null): undefined → null、null → null、値 → 値", () => {
    expect(CardSchema.parse({ ...card, power: undefined }).power).toBeNull();
    expect(CardSchema.parse({ ...card, power: null }).power).toBeNull();
    expect(CardSchema.parse({ ...card, power: 0 }).power).toBe(0);
  });
  it("optional は null を受け付けない (conversationId: null は失敗)", () => {
    expect(ChatRequestSchema.safeParse({ message: "q", conversationId: null }).success).toBe(false);
    const out = ChatRequestSchema.parse({ message: "q" });
    expect("conversationId" in out).toBe(false);
    expect(out.mode).toBe("integrated");
    expect(out.history).toEqual([]);
  });
  it("未知キーは strip される (v4 でも既定は strip)", () => {
    const out = CardSchema.parse({ ...card, extra: 1 }) as Record<string, unknown>;
    expect("extra" in out).toBe(false);
  });
  it("default の値は parse ごとに独立 (配列を共有しない)", () => {
    const a = CardSchema.parse(card);
    a.races.push("x");
    expect(CardSchema.parse(card).races).toEqual([]);
  });
});
