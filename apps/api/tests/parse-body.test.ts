import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { parseBody } from "../src/parse-body.js";

/**
 * parseBody が ZodError の issue.path / message から作る 400 応答の形式を固定する (Issue #297 PR-1)。
 * 期待値は現行 zod v3 の message。v4 では組み込みメッセージの文言が変わる見込みのものがある。
 * カスタムメッセージ (日本語) は変わらないはず。
 */
const Schema = z.object({
  name: z.string().min(1, "name は必須です"),
  count: z.number().int(),
  nested: z.object({ items: z.array(z.object({ n: z.number() })) }).optional(),
  kind: z.enum(["a", "b"]).optional(),
});

function makeApp() {
  const app = new Hono();
  app.post("/t", async (c) => {
    const body = await parseBody(c, Schema);
    if (!body.ok) return body.res;
    return c.json({ ok: true, data: body.data });
  });
  return app;
}

const post = (body: string) =>
  makeApp().request("/t", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("parseBody の 400 応答", () => {
  it("形式: { error, details: string[] } で details は 'path: message'", async () => {
    const res = await post(JSON.stringify({ name: "", count: 1 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "リクエストが不正です",
      details: ["name: name は必須です"],
    });
  });

  it("カスタムメッセージ無しの組み込みメッセージ (v4 で変わる見込み: 文言が変わる)", async () => {
    const res = await post(JSON.stringify({ name: "x", count: "1" }));
    const json = (await res.json()) as { details: string[] };
    expect(json.details).toEqual(["count: Expected number, received string"]);
  });

  it("必須キー欠落 (v4 で変わる見込み: 'Required' → 型不一致の文言)", async () => {
    const res = await post(JSON.stringify({}));
    const json = (await res.json()) as { details: string[] };
    expect(json.details).toEqual(["name: Required", "count: Required"]);
  });

  it("小数は int で失敗 (v4 で変わる見込み: 文言)", async () => {
    const res = await post(JSON.stringify({ name: "x", count: 1.5 }));
    const json = (await res.json()) as { details: string[] };
    expect(json.details).toEqual(["count: Expected integer, received float"]);
  });

  it("enum 不一致 (v4 で変わる見込み: 文言)", async () => {
    const res = await post(JSON.stringify({ name: "x", count: 1, kind: "z" }));
    const json = (await res.json()) as { details: string[] };
    expect(json.details).toEqual(["kind: Invalid enum value. Expected 'a' | 'b', received 'z'"]);
  });

  it("ネストと配列要素の path は '.' 連結 (items.0.n)", async () => {
    const res = await post(
      JSON.stringify({ name: "x", count: 1, nested: { items: [{ n: 1 }, { n: "s" }] } }),
    );
    const json = (await res.json()) as { details: string[] };
    expect(json.details).toEqual(["nested.items.1.n: Expected number, received string"]);
  });

  it("ルート直下の型不一致は path が空で ': message' になる (v4 で変わる見込み: 文言)", async () => {
    const res = await post(JSON.stringify([1]));
    const json = (await res.json()) as { details: string[] };
    expect(json.details).toEqual([": Expected object, received array"]);
  });

  it("不正 JSON / 空ボディは raw=null として 400 (例外にならない)", async () => {
    for (const body of ["{", "", "null"]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("リクエストが不正です");
    }
  });

  it("成功時は data を返し、未知キーは strip される", async () => {
    const res = await post(JSON.stringify({ name: "x", count: 1, extra: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { name: "x", count: 1 } });
  });
});
