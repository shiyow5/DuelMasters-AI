import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";

/**
 * 捕捉した err をログに出すとき、message / stack / cause の中身を出さない (#294)。
 *
 * DB ドライバの例外には接続先 (host:port)、SQL、制約名、入力値が入りうる。
 * ここでは秘密文字列を message / stack / cause に仕込んだ例外を投げさせ、
 * console.error / warn に渡された全引数に秘密が含まれないことと、
 * `toSafeErrorLog` の要約 (event / errorId) が出ていることを固定する。
 */

const SECRETS = ["postgres://user:SECRET_PW@db.internal:5432", "sk-SECRET-TOKEN"];

function makeLeakyError(): Error {
  const cause = new Error(`cause ${SECRETS[1]}`);
  const err = new Error(`connect failed ${SECRETS[0]}`, { cause });
  err.stack = `Error: ${SECRETS[0]}\n    at ${SECRETS[1]}`;
  return err;
}

const failing = { err: makeLeakyError() };

vi.mock("@dm-ai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dm-ai/db")>();
  return {
    ...actual,
    getSql: () => {
      throw failing.err;
    },
  };
});

vi.mock("@dm-ai/agent", () => ({
  // eslint-disable-next-line require-yield
  streamAgent: async function* () {
    throw failing.err;
  },
  runAgent: async () => {
    throw failing.err;
  },
}));

const { resolveCardImages } = await import("../src/card.js");
const { metaRouter } = await import("../src/routes/meta.js");
const { chatRouter } = await import("../src/routes/chat.js");

function logged(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls
    .flat()
    .map(
      (a) => (typeof a === "string" ? a : JSON.stringify(a)) + (a instanceof Error ? a.stack : ""),
    )
    .join("\n");
}

function expectSafe(text: string) {
  for (const s of SECRETS) expect(text).not.toContain(s);
  expect(text).toContain('"event"');
  expect(text).toContain('"errorId"');
}

describe("err 生ログを出さない (#294)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    failing.err = makeLeakyError();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("resolveCardImages: DB 失敗時の warn に秘密が出ない (全 null で返る)", async () => {
    const out = await resolveCardImages(["ボルシャック・ドラゴン"]);
    expect(Object.values(out).every((v) => v === null)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    expectSafe(logged(warnSpy));
  });

  it("GET /api/meta/tier: フォールバック経路の error に秘密が出ない", async () => {
    const app = new Hono();
    app.route("/api/meta", metaRouter);
    const res = await app.request("/api/meta/tier?format=original");
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalled();
    expectSafe(logged(errorSpy));
  });

  it("POST /api/chat/stream: ストリーム中の失敗で error に秘密が出ない", async () => {
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use("*", async (c, next) => {
      c.set("userId", "test");
      await next();
    });
    app.route("/api/chat", chatRouter);
    const res = await app.request("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "こんにちは", history: [] }),
    });
    await res.text();
    expect(errorSpy).toHaveBeenCalled();
    expectSafe(logged(errorSpy));
  });
});
