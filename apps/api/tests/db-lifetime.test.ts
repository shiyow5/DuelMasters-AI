import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

/**
 * リクエストスコープ DB 接続の寿命 (#112)。
 *
 * **本番で起きたこと。** `dbEnv` は `next()` が解決した直後に `sql.end()` していた。
 * ところが `streamSSE` は **本文を書き終える前に Response を返す**。つまり `next()` は
 * ストリーム開始と同時に解決し、その時点で DB 接続が閉じられる。
 * 結果、ストリーム中に走るエージェントのツールは全て
 * `Error: write CONNECTION_ENDED ...hyperdrive.local:5432` で落ちていた。
 *
 * ツールが落ちると runTool の catch が例外を平文に潰してモデルへ返すため、モデルは
 * 記憶から捏造した回答を出す。ユーザーには「たまにツールが失敗する」としか見えず、
 * **#91 のストリーミング導入以降ずっと web UI ではツールが1本も動いていなかった**。
 * eval は非ストリーミングの runAgent を Node で叩くのでこの経路を通らず、検出できない。
 *
 * ここでは「応答本文を書き終えるまで接続を閉じない」ことを直接検証する。
 */

const fake = { ended: false };

vi.mock("@dm-ai/db", () => {
  let scoped: unknown = null;
  return {
    configureDb: () => {},
    createSql: () => {
      const sql = {
        end: async () => {
          fake.ended = true;
        },
      };
      return sql;
    },
    runWithSql: (sql: unknown, fn: () => unknown) => {
      scoped = sql;
      return fn();
    },
    getSql: () => scoped,
    getSupabase: () => {
      throw new Error("使わない");
    },
  };
});

const { dbEnv } = await import("../src/db.js");

const ENV = { HYPERDRIVE: { connectionString: "postgres://u:p@localhost/db" } };

/** executionCtx.waitUntil に積まれた仕事を集める (Workers 相当)。 */
function makeCtx() {
  const waits: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {} },
    settle: () => Promise.all(waits),
  };
}

beforeEach(() => {
  fake.ended = false;
});

describe("dbEnv の DB 接続寿命", () => {
  it("ストリーミング中に接続を閉じない (本番で全ツールが CONNECTION_ENDED になっていた)", async () => {
    /** ストリームの途中 = 「エージェントがツールを呼ぶ瞬間」に接続が生きているか。 */
    let endedMidStream: boolean | null = null;

    const app = new Hono();
    app.use("*", dbEnv);
    app.post("/stream", (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "token", data: "考え中" });
        // エージェントが LLM を待ってからツールを呼ぶまでの間。ここで接続が死んでいた。
        await new Promise((r) => setTimeout(r, 20));
        endedMidStream = fake.ended;
        await stream.writeSSE({ event: "done", data: "完了" });
      }),
    );

    const { ctx, settle } = makeCtx();
    const res = await app.request("/stream", { method: "POST" }, ENV, ctx);
    const body = await res.text();
    await settle();

    expect(endedMidStream).toBe(false);
    // 本文が壊れていないこと (接続寿命を伸ばすために本文を包み直すため)
    expect(body).toContain("event: token");
    expect(body).toContain("event: done");
  });

  it("本文を書き終えたら接続を閉じる (張りっぱなしにしない)", async () => {
    const app = new Hono();
    app.use("*", dbEnv);
    app.post("/stream", (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "done", data: "完了" });
      }),
    );

    const { ctx, settle } = makeCtx();
    const res = await app.request("/stream", { method: "POST" }, ENV, ctx);
    await res.text();
    await settle();

    expect(fake.ended).toBe(true);
  });

  it("非ストリーミング応答でも接続を閉じる", async () => {
    const app = new Hono();
    app.use("*", dbEnv);
    app.get("/json", (c) => c.json({ ok: true }));

    const { ctx, settle } = makeCtx();
    const res = await app.request("/json", {}, ENV, ctx);
    expect(await res.json()).toEqual({ ok: true });
    await settle();

    expect(fake.ended).toBe(true);
  });

  it("ハンドラが投げても接続を閉じる (接続リーク防止)", async () => {
    // Hono は例外を errorHandler で 500 応答に変換するので、dbEnv の catch には届かない。
    // 500 の本文を包む通常経路を通って閉じる — 「どの経路でも必ず閉じる」ことを確かめる。
    const app = new Hono();
    app.use("*", dbEnv);
    app.get("/boom", () => {
      throw new Error("boom");
    });

    const { ctx, settle } = makeCtx();
    const res = await app.request("/boom", {}, ENV, ctx);
    await res.text();
    await settle();

    expect(fake.ended).toBe(true);
  });

  it("HEAD でも接続を閉じる (未認証の /health を連打されるとプールが枯れる)", async () => {
    // Hono は HEAD を GET として処理し、その結果を `new Response(null, res)` で包んで
    // **本文を捨てる**。よって本文を包み直すと誰も読まず pipeTo が永久に解決せず、
    // sql.end() が呼ばれない = 接続リーク。/health は未認証・レート制限外なので、
    // HEAD を連打されるだけで Hyperdrive のプールを枯らせてしまう。
    const app = new Hono();
    app.use("*", dbEnv);
    app.get("/health", (c) => c.json({ status: "ok" }));

    const { ctx, settle } = makeCtx();
    await app.request("/health", { method: "HEAD" }, ENV, ctx);
    await Promise.race([settle(), new Promise((r) => setTimeout(r, 500))]);

    expect(fake.ended).toBe(true);
  });

  it("クライアントが切断しても接続を閉じる (接続リーク防止)", async () => {
    const app = new Hono();
    app.use("*", dbEnv);
    app.post("/stream", (c) =>
      streamSSE(c, async (stream) => {
        for (let i = 0; i < 50; i++) {
          await stream.writeSSE({ event: "token", data: String(i) });
          await new Promise((r) => setTimeout(r, 5));
        }
      }),
    );

    const { ctx, settle } = makeCtx();
    const res = await app.request("/stream", { method: "POST" }, ENV, ctx);
    await res.body!.cancel(); // 途中でブラウザを閉じた
    await settle();

    expect(fake.ended).toBe(true);
  });
});
