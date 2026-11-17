import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * loadRegulations の DB 失敗ログに err の中身を出さない (#311)。
 *
 * DB ドライバの例外には接続先 (host:port)、SQL、入力値が入りうる。秘密文字列を
 * message / stack / cause に仕込んだ例外を getSql に投げさせ、console.error に渡された
 * 全引数に秘密が含まれないことと、toSafeErrorLog の要約 (event / errorId) が出ていることを固定する。
 * 呼び出し側の戻り値 (ok: false と固定の reason) は変えない。
 */

const SECRETS = ["postgres://user:SECRET_PW@db.internal:5432", "sk-SECRET-TOKEN"];

function makeLeakyError(): Error {
  const cause = new Error(`cause ${SECRETS[1]}`);
  const err = new Error(`connect failed ${SECRETS[0]}`, { cause });
  err.stack = `Error: ${SECRETS[0]}\n    at ${SECRETS[1]}`;
  return err;
}

vi.mock("@dm-ai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dm-ai/db")>();
  return {
    ...actual,
    getSql: () => {
      throw makeLeakyError();
    },
  };
});

const { loadRegulations } = await import("../src/regulation-check.js");

function logged(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls
    .flat()
    .map(
      (a) => (typeof a === "string" ? a : JSON.stringify(a)) + (a instanceof Error ? a.stack : ""),
    )
    .join("\n");
}

describe("err 生ログを出さない (#311): deck-engine", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("loadRegulations: DB 失敗時のログに秘密が出ない (戻り値は従来どおり)", async () => {
    const out = await loadRegulations("original");
    expect(out).toEqual({ ok: false, reason: "殿堂データベースに接続できませんでした" });
    expect(errorSpy).toHaveBeenCalled();
    const text = logged(errorSpy);
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(text).toContain('"event"');
    expect(text).toContain('"errorId"');
    expect(errorSpy.mock.calls.flat().some((a) => a instanceof Error)).toBe(false);
  });
});
