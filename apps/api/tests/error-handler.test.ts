import { describe, it, expect, vi, afterEach } from "vitest";
import { inspect } from "node:util";
import { Hono } from "hono";
import { handleAppError } from "../src/error-handler.js";

// 合成マーカー。ログ・応答に漏れたら検出できる一意な文字列。
const MARKER = "SYNTH_MARKER_api_e81d";

/** drizzle-orm 0.45.2 の DrizzleQueryError 相当 (直下 code なし、cause に PostgresError)。 */
function drizzleLike(code: string): Error {
  const cause = Object.assign(new Error(`driver ${MARKER}`), {
    code,
    constraint_name: "user_settings_pkey",
    detail: `Key (user_id)=(${MARKER}) already exists.`,
  });
  return Object.assign(new Error(`Failed query: insert ... params: ${MARKER}`), {
    query: `insert into user_settings values ($1) -- ${MARKER}`,
    params: [MARKER],
    cause,
  });
}

function makeApp(err: unknown) {
  const app = new Hono();
  app.get("/boom", () => {
    throw err;
  });
  app.onError(handleAppError);
  return app;
}

function loggedText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls
    .map((args) => args.map((a) => inspect(a, { depth: 10 })).join(" "))
    .join("\n");
}

describe("handleAppError (app.onError)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("23505 (cause.code) は 409 を返し、ログ・応答にマーカーを出さない", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await makeApp(drizzleLike("23505")).request("/boom");

    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "同じデータが既に登録されています" });
    expect(text).not.toContain(MARKER);
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = loggedText(spy);
    expect(logged).not.toContain(MARKER);
    expect(logged).toContain('"kind":"unique_violation"');
    expect(logged).toContain('"sqlstate":"23505"');
    // 制約名 (内部スキーマ識別子) はログに出さない
    expect(logged).not.toContain("user_settings_pkey");
    expect(logged).not.toContain("constraint");
    expect(logged).toMatch(/"errorId":"[0-9a-f-]{36}"/);
  });

  it("23505 以外の DB 例外は従来どおり 500 / 汎用文言で、ログ・応答にマーカーを出さない", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await makeApp(drizzleLike("23503")).request("/boom");

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "内部エラーが発生しました" });
    expect(text).not.toContain(MARKER);
    const logged = loggedText(spy);
    expect(logged).not.toContain(MARKER);
    expect(logged).toContain('"kind":"unknown"');
    expect(logged).toContain('"sqlstate":"23503"');
  });

  it("DB 以外の例外は 500 / 汎用文言で、ログは種別名と errorId だけ (message・stack を出さない)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await makeApp(new TypeError(MARKER)).request("/boom");

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "内部エラーが発生しました" });
    expect(text).not.toContain(MARKER);
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = loggedText(spy);
    expect(logged).not.toContain(MARKER);
    expect(logged).not.toContain("error-handler.test"); // stack を出さない
    expect(logged).toContain('"event":"error"');
    expect(logged).toContain('"name":"TypeError"');
    expect(logged).toMatch(/"errorId":"[0-9a-f-]{36}"/);
  });

  it("cause を 2 段以上包んだ DB 例外 (SQLSTATE 非検出) も、ログに SQL・入力値・接続情報を出さない", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const nested = new Error(`wrap ${MARKER}`, { cause: drizzleLike("23505") });
    const res = await makeApp(nested).request("/boom");

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(MARKER);
    const logged = loggedText(spy);
    expect(logged).not.toContain(MARKER);
    expect(logged).not.toContain("user_settings");
    expect(logged).toContain('"name":"Error"');
  });

  it("SQLSTATE を持たない接続系例外 (message に接続先を含む) もログに message を出さない", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const connErr = Object.assign(new Error(`connect ECONNREFUSED ${MARKER}:5432`), {
      code: "ECONNREFUSED",
      address: MARKER,
    });
    const res = await makeApp(connErr).request("/boom");

    expect(res.status).toBe(500);
    const logged = loggedText(spy);
    expect(logged).not.toContain(MARKER);
    expect(logged).toContain('"name":"Error"');
  });
});
