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
    expect(logged).toContain('"constraint":"user_settings_pkey"');
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

  it("DB 以外の例外は従来どおり 500 / 汎用文言 (応答に message を出さない)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await makeApp(new TypeError(MARKER)).request("/boom");

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "内部エラーが発生しました" });
    expect(text).not.toContain(MARKER);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
