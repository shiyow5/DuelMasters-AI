import { describe, it, expect } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import {
  classifyDbError,
  getConstraintName,
  getSqlState,
  isUniqueViolation,
  toDbErrorResponse,
  toSafeDbErrorLog,
} from "../src/errors.js";

// 合成マーカー。ログ・応答に 1 文字でも漏れたら検出できるよう、一意な文字列にする。
const MARKER = "SYNTH_MARKER_7f3c9a";

/** postgres.js の PostgresError 相当 (直下に code)。 */
function driverError(code: unknown): Error {
  return Object.assign(new Error(`duplicate key value ${MARKER}`), {
    code,
    detail: `Key (name)=(${MARKER}) already exists.`,
  });
}

/** drizzle-orm 0.45.2 の形 (直下 code なし、cause.code に SQLSTATE)。 */
function wrapped(code: unknown): DrizzleQueryError {
  return new DrizzleQueryError(
    `insert into t values ($1) -- ${MARKER}`,
    [MARKER],
    driverError(code),
  );
}

describe("getSqlState / classifyDbError", () => {
  it("drizzle 0.45.2 の形: cause.code の 23505 を一意制約違反と分類する", () => {
    const err = wrapped("23505");
    expect((err as unknown as { code?: unknown }).code).toBeUndefined();
    expect(getSqlState(err)).toBe("23505");
    expect(classifyDbError(err)).toBe("unique_violation");
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("旧版・postgres.js 直の形: 直下 code の 23505 も分類する (後方互換)", () => {
    const err = driverError("23505");
    expect(getSqlState(err)).toBe("23505");
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("23505 以外の SQLSTATE は unknown", () => {
    expect(getSqlState(wrapped("23503"))).toBe("23503");
    expect(classifyDbError(wrapped("23503"))).toBe("unknown");
    expect(classifyDbError(driverError("40001"))).toBe("unknown");
  });

  it("直下と cause の両方が SQLSTATE で食い違うときは cause.code を優先する", () => {
    const a = Object.assign(new Error("x"), { code: "23503", cause: { code: "23505" } });
    expect(getSqlState(a)).toBe("23505");
    const b = Object.assign(new Error("x"), { code: "23505", cause: { code: "23503" } });
    expect(getSqlState(b)).toBe("23503");
    expect(isUniqueViolation(b)).toBe(false);
  });

  it("cause.code が不正なら直下 code にフォールバックする", () => {
    const err = Object.assign(new Error("x"), { code: "23505", cause: { code: 23505 } });
    expect(getSqlState(err)).toBe("23505");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["文字列", "23505"],
    ["数値", 23505],
    ["真偽値", true],
    ["シンボル", Symbol("23505")],
    ["空オブジェクト", {}],
  ])("%s を渡しても throw せず null / unknown", (_label, value) => {
    expect(getSqlState(value)).toBeNull();
    expect(classifyDbError(value)).toBe("unknown");
  });

  it.each([
    ["数値の code", 23505],
    ["小文字を含む", "2350a"],
    ["4 文字", "2350"],
    ["6 文字", "235050"],
    ["前後に空白", " 23505"],
    ["改行入り", "23505\n"],
    ["オブジェクト", { toString: () => "23505" }],
  ])("不正形式の code (%s) は採用しない", (_label, code) => {
    expect(getSqlState(driverError(code))).toBeNull();
    expect(getSqlState(wrapped(code))).toBeNull();
  });

  it("message にだけ 23505 / duplicate key があっても分類しない", () => {
    const err = new Error("duplicate key value violates unique constraint (SQLSTATE 23505)");
    expect(isUniqueViolation(err)).toBe(false);
    expect(isUniqueViolation(new DrizzleQueryError("q", [], new Error("23505")))).toBe(false);
  });

  it("cause が無い・プリミティブでも throw しない", () => {
    expect(getSqlState(new DrizzleQueryError("q", []))).toBeNull();
    expect(getSqlState({ cause: "23505" })).toBeNull();
    expect(getSqlState({ cause: null, code: "23505" })).toBe("23505");
  });

  it("循環した cause でも無限ループにならない", () => {
    const a: Record<string, unknown> = { code: "23505" };
    a.cause = a;
    expect(getSqlState(a)).toBe("23505");
    const b: Record<string, unknown> = {};
    const c: Record<string, unknown> = { cause: b };
    b.cause = c;
    expect(getSqlState(b)).toBeNull();
  });

  it("throw する getter / Proxy でも throw しない", () => {
    const boom = () => {
      throw new Error(MARKER);
    };
    const throwingCode = Object.defineProperty({}, "code", { get: boom });
    const throwingCause = Object.defineProperty({ code: "23505" }, "cause", { get: boom });
    const causeWithThrowingCode = { cause: throwingCode };
    const proxy = new Proxy({}, { get: boom });
    expect(getSqlState(throwingCode)).toBeNull();
    expect(getSqlState(throwingCause)).toBe("23505");
    expect(getSqlState(causeWithThrowingCode)).toBeNull();
    expect(getSqlState(proxy)).toBeNull();
    expect(() => toSafeDbErrorLog(proxy)).not.toThrow();
    expect(() => toDbErrorResponse(proxy)).not.toThrow();
  });
});

describe("ネストした cause (2 段以上) の扱い (現状の仕様を固定)", () => {
  it("DB 例外を cause でさらに包むと SQLSTATE を拾わず null / unknown になる", () => {
    // 例: アプリ側で DrizzleQueryError を new Error(..., { cause }) で包み直したケース。
    // cause は 1 段しか読まないため SQLSTATE は取れない。apps/api の onError では
    // DB 以外の例外扱いになり、従来どおり例外本体 (params / query を含みうる) がログに出る。
    // 現状そのように包む箇所は無い。包む箇所を作るときは getSqlState の探索段数を見直すこと。
    const nested = new Error("wrap", { cause: wrapped("23505") });
    expect(getSqlState(nested)).toBeNull();
    expect(classifyDbError(nested)).toBe("unknown");
    expect(getConstraintName(nested)).toBeNull();
  });
});

describe("getConstraintName", () => {
  function withConstraint(name: unknown, code = "23505"): Error {
    return Object.assign(driverError(code), { constraint_name: name });
  }

  it("cause の constraint_name を返す (drizzle 0.45.2 の形)", () => {
    const err = new DrizzleQueryError("q", [], withConstraint("user_settings_pkey"));
    expect(getConstraintName(err)).toBe("user_settings_pkey");
    expect(toSafeDbErrorLog(err).constraint).toBe("user_settings_pkey");
  });

  it("直下の constraint_name も返す (後方互換)", () => {
    expect(getConstraintName(withConstraint("cards_official_id_uidx"))).toBe(
      "cards_official_id_uidx",
    );
  });

  it("SQLSTATE を採用した側の constraint_name だけを見る", () => {
    const err = Object.assign(new Error("x"), {
      code: "23505",
      constraint_name: "outer_c",
      cause: { code: "23503", constraint_name: "inner_c" },
    });
    expect(getConstraintName(err)).toBe("inner_c");
  });

  it.each([
    ["無い", undefined],
    ["数値", 1],
    ["空文字", ""],
    ["空白入り", "a b"],
    ["改行入り", "a\n"],
    ["数字始まり", "1abc"],
    ["64 文字", "a".repeat(64)],
    ["引用符付き識別子相当", 'c"x'],
  ])("不正・欠落 (%s) は null", (_l, name) => {
    expect(getConstraintName(withConstraint(name))).toBeNull();
  });

  it("SQLSTATE が無ければ constraint_name があっても null", () => {
    expect(getConstraintName({ constraint_name: "c" })).toBeNull();
  });

  it("throw する getter でも throw しない", () => {
    const err = Object.defineProperty({ code: "23505" }, "constraint_name", {
      get: () => {
        throw new Error(MARKER);
      },
    });
    expect(getConstraintName(err)).toBeNull();
  });
});

describe("toSafeDbErrorLog / toDbErrorResponse は入力を漏らさない", () => {
  const cases = [
    ["23505 (cause.code)", wrapped("23505")],
    ["23505 (直下 code)", driverError("23505")],
    ["非 23505 (cause.code)", wrapped("23503")],
    ["SQLSTATE なし", new DrizzleQueryError(`q ${MARKER}`, [MARKER], new Error(MARKER))],
  ] as const;

  it.each(cases)("%s: ログ要約に許可したキーだけがあり、マーカーを含まない", (_l, err) => {
    const log = toSafeDbErrorLog(err);
    expect(Object.keys(log).sort()).toEqual(["constraint", "event", "kind", "sqlstate"]);
    expect(JSON.stringify(log)).not.toContain(MARKER);
  });

  it.each(cases)("%s: 応答本文は error だけで、マーカーを含まない", (_l, err) => {
    const res = toDbErrorResponse(err);
    expect(Object.keys(res.body)).toEqual(["error"]);
    expect(JSON.stringify(res)).not.toContain(MARKER);
  });

  it("23505 は 409、それ以外は既存の 500 応答と同じ本文", () => {
    expect(toDbErrorResponse(wrapped("23505"))).toEqual({
      status: 409,
      body: { error: "同じデータが既に登録されています" },
    });
    expect(toDbErrorResponse(wrapped("23503"))).toEqual({
      status: 500,
      body: { error: "内部エラーが発生しました" },
    });
  });

  it("応答本文は呼び出しごとに新しいオブジェクト (呼び出し側の書き換えが漏れない)", () => {
    const a = toDbErrorResponse(wrapped("23505"));
    a.body.error = MARKER;
    expect(toDbErrorResponse(wrapped("23505")).body.error).not.toContain(MARKER);
  });
});
