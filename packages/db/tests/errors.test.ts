import { describe, it, expect } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import {
  classifyDbError,
  getErrorName,
  getSqlState,
  isUniqueViolation,
  toDbErrorResponse,
  toSafeDbErrorLog,
  toSafeErrorLog,
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
    // DB 以外の例外扱いになり、toSafeErrorLog により種別名と errorId だけがログに出る。
    const nested = new Error("wrap", { cause: wrapped("23505") });
    expect(getSqlState(nested)).toBeNull();
    expect(classifyDbError(nested)).toBe("unknown");
    expect(JSON.stringify(toSafeErrorLog(nested))).not.toContain(MARKER);
  });
});

describe("toSafeDbErrorLog は制約名を出さない", () => {
  it("cause / 直下の constraint_name はログ要約に含めない", () => {
    const inCause = new DrizzleQueryError(
      "q",
      [],
      Object.assign(driverError("23505"), { constraint_name: "user_settings_pkey" }),
    );
    const direct = Object.assign(driverError("23505"), {
      constraint_name: "cards_official_id_uidx",
    });
    for (const err of [inCause, direct]) {
      const text = JSON.stringify(toSafeDbErrorLog(err));
      expect(text).not.toContain("constraint");
      expect(text).not.toContain("user_settings_pkey");
      expect(text).not.toContain("cards_official_id_uidx");
    }
  });
});

describe("toSafeErrorLog / getErrorName", () => {
  it("DB 例外は DB 要約 + errorId", () => {
    expect(toSafeErrorLog(wrapped("23505"), "id-1")).toEqual({
      event: "db_error",
      kind: "unique_violation",
      sqlstate: "23505",
      errorId: "id-1",
    });
  });

  it("DB 以外は種別名 + errorId だけで、message・stack・cause を含まない", () => {
    const err = new TypeError(MARKER, { cause: new Error(MARKER) });
    const log = toSafeErrorLog(err, "id-2");
    expect(log).toEqual({ event: "error", name: "TypeError", errorId: "id-2" });
    expect(JSON.stringify(log)).not.toContain(MARKER);
  });

  it("errorId を省略すると UUID を毎回生成する", () => {
    const a = toSafeErrorLog(new Error("x"));
    const b = toSafeErrorLog(new Error("x"));
    expect(a.errorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.errorId).not.toBe(b.errorId);
  });

  it.each([
    [
      "識別子形式でない name",
      Object.assign(new Error("x"), { name: `bad ${MARKER}` }),
      "UnknownError",
    ],
    ["name が文字列でない", Object.assign(new Error("x"), { name: 1 }), "UnknownError"],
    ["文字列を throw", MARKER, "string"],
    ["null", null, "null"],
    ["undefined", undefined, "undefined"],
  ])("%s は固定値に倒し、値を漏らさない", (_l, err, expected) => {
    expect(getErrorName(err)).toBe(expected);
    expect(JSON.stringify(toSafeErrorLog(err, "id"))).not.toContain(MARKER);
  });

  it("throw する getter / Proxy でも throw しない", () => {
    const err = Object.defineProperty({}, "name", {
      get: () => {
        throw new Error(MARKER);
      },
    });
    const proxy = new Proxy(
      {},
      {
        get: () => {
          throw new Error(MARKER);
        },
      },
    );
    expect(getErrorName(err)).toBe("UnknownError");
    expect(() => toSafeErrorLog(proxy)).not.toThrow();
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
    expect(Object.keys(log).sort()).toEqual(["event", "kind", "sqlstate"]);
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
