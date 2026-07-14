import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";
import { optionalAuth } from "../src/middleware/auth.js";
import { conversationRouter, MAX_MESSAGES_PER_FETCH } from "../src/routes/conversations.js";

/**
 * 会話履歴の永続化 (#110)。
 *
 * **一番大事なのは「他人の会話が読めないこと」。** 会話は保存デッキ以上に機微で、
 * ID を指定して他人の会話を引ける穴を作ったら終わり。所有者チェックは全経路に要る。
 * 存在を漏らさないため、他人の会話へのアクセスは 403 ではなく **404** を返す。
 */

function makeApp() {
  const app = new Hono();
  app.use("*", optionalAuth);
  app.route("/api/conversations", conversationRouter);
  return app;
}

const ME = {
  "X-Internal-Key": "test-key",
  "X-User-Id": "u:me",
  "Content-Type": "application/json",
};
const OTHER = {
  "X-Internal-Key": "test-key",
  "X-User-Id": "u:other",
  "Content-Type": "application/json",
};

describe("会話 API の認証ゲート (DB 不要)", () => {
  beforeAll(() => {
    process.env.INTERNAL_API_KEY = "test-key";
  });

  it("無認証で一覧 → 401", async () => {
    expect((await makeApp().request("/api/conversations")).status).toBe(401);
  });

  it("無認証で作成 → 401", async () => {
    const res = await makeApp().request("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!hasTestDb)("会話 CRUD (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => {
    process.env.INTERNAL_API_KEY = "test-key";
    enableAppDb();
  });
  beforeEach(async () => {
    await truncateAll(sql);
  });
  afterAll(async () => {
    await sql.end();
  });

  /** 会話を1件作り、id を返す。 */
  async function createConv(headers: Record<string, string>, title = "S・トリガーとは？") {
    const res = await makeApp().request("/api/conversations", {
      method: "POST",
      headers,
      body: JSON.stringify({ title, mode: "integrated" }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).id as string;
  }

  it("作成 → 一覧に出る", async () => {
    await createConv(ME);
    const res = await makeApp().request("/api/conversations", { headers: ME });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0].title).toBe("S・トリガーとは？");
  });

  it("**他人の会話は一覧に出ない**", async () => {
    await createConv(OTHER);
    const res = await makeApp().request("/api/conversations", { headers: ME });
    expect((await res.json()).conversations).toHaveLength(0);
  });

  it("**他人の会話は ID を知っていても読めない (404。存在を漏らさない)**", async () => {
    const id = await createConv(OTHER);
    const res = await makeApp().request(`/api/conversations/${id}`, { headers: ME });
    expect(res.status).toBe(404);
  });

  it("**他人の会話は消せない**", async () => {
    const id = await createConv(OTHER);
    const res = await makeApp().request(`/api/conversations/${id}`, {
      method: "DELETE",
      headers: ME,
    });
    expect(res.status).toBe(404);
    // 実際に残っていること (「404 を返したが消していた」を防ぐ)
    const still = await sql`SELECT count(*)::int AS n FROM conversations WHERE id = ${id}`;
    expect(still[0].n).toBe(1);
  });

  it("**他人の会話にメッセージを足せない**", async () => {
    const id = await createConv(OTHER);
    const res = await makeApp().request(`/api/conversations/${id}/messages`, {
      method: "POST",
      headers: ME,
      body: JSON.stringify({ role: "user", content: "侵入" }),
    });
    expect(res.status).toBe(404);
    const rows = await sql`SELECT count(*)::int AS n FROM conversation_messages`;
    expect(rows[0].n).toBe(0);
  });

  it("メッセージを足すと、引用とツール呼び出しも一緒に残る", async () => {
    // 引用が残らないと後から根拠を辿れず、保存する意味が薄い。
    const id = await createConv(ME);
    await makeApp().request(`/api/conversations/${id}/messages`, {
      method: "POST",
      headers: ME,
      body: JSON.stringify({ role: "user", content: "S・トリガーとは？" }),
    });
    await makeApp().request(`/api/conversations/${id}/messages`, {
      method: "POST",
      headers: ME,
      body: JSON.stringify({
        role: "assistant",
        content: "シールドから使えます",
        citations: [{ article: "113.6", text: "S・トリガー" }],
        toolCalls: [{ name: "search_rules", args: { query: "S・トリガー" } }],
      }),
    });

    const res = await makeApp().request(`/api/conversations/${id}`, { headers: ME });
    const body = await res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].citations).toEqual([{ article: "113.6", text: "S・トリガー" }]);
    expect(body.messages[1].toolCalls).toEqual([
      { name: "search_rules", args: { query: "S・トリガー" } },
    ]);
  });

  it("メッセージ追加で会話の updated_at が進む (一覧の並び順に効く)", async () => {
    const id = await createConv(ME);
    const before = await sql`SELECT updated_at FROM conversations WHERE id = ${id}`;
    await new Promise((r) => setTimeout(r, 10));
    await makeApp().request(`/api/conversations/${id}/messages`, {
      method: "POST",
      headers: ME,
      body: JSON.stringify({ role: "user", content: "追記" }),
    });
    const after = await sql`SELECT updated_at FROM conversations WHERE id = ${id}`;
    expect(new Date(after[0].updated_at).getTime()).toBeGreaterThan(
      new Date(before[0].updated_at).getTime(),
    );
  });

  it("リネームできる / 他人のはできない", async () => {
    const id = await createConv(ME);
    const ok = await makeApp().request(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: ME,
      body: JSON.stringify({ title: "新しい題" }),
    });
    expect(ok.status).toBe(200);

    const ng = await makeApp().request(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: OTHER,
      body: JSON.stringify({ title: "乗っ取り" }),
    });
    expect(ng.status).toBe(404);

    const rows = await sql`SELECT title FROM conversations WHERE id = ${id}`;
    expect(rows[0].title).toBe("新しい題");
  });

  it("削除すると messages も消える (孤児を残さない)", async () => {
    const id = await createConv(ME);
    await makeApp().request(`/api/conversations/${id}/messages`, {
      method: "POST",
      headers: ME,
      body: JSON.stringify({ role: "user", content: "消える" }),
    });
    const res = await makeApp().request(`/api/conversations/${id}`, {
      method: "DELETE",
      headers: ME,
    });
    expect(res.status).toBe(200);
    const rows = await sql`SELECT count(*)::int AS n FROM conversation_messages`;
    expect(rows[0].n).toBe(0);
  });

  it("不正な UUID でも 500 にせず 404 を返す", async () => {
    const res = await makeApp().request("/api/conversations/not-a-uuid", { headers: ME });
    expect(res.status).toBe(404);
  });

  it("巨大な本文は拒否する (ストレージを食い潰させない)", async () => {
    // このエンドポイントは web からは呼ばれないが、ログイン済みなら誰でも直接叩ける。
    // レート制限は回数しか見ていないので、1発あたりのサイズはここで止める。
    const id = await createConv(ME);
    const res = await makeApp().request(`/api/conversations/${id}/messages`, {
      method: "POST",
      headers: ME,
      body: JSON.stringify({ role: "user", content: "あ".repeat(40_000) }),
    });
    expect(res.status).toBe(400);
    const rows = await sql`SELECT count(*)::int AS n FROM conversation_messages`;
    expect(rows[0].n).toBe(0);
  });

  it("引用・ツール呼び出しの件数にも上限がある", async () => {
    const id = await createConv(ME);
    const res = await makeApp().request(`/api/conversations/${id}/messages`, {
      method: "POST",
      headers: ME,
      body: JSON.stringify({
        role: "assistant",
        content: "x",
        citations: Array.from({ length: 500 }, () => ({ text: "a" })),
      }),
    });
    expect(res.status).toBe(400);
  });

  it("会話を開くときは直近 N 件までしか返さない (肥大化した会話で全件返さない)", async () => {
    const id = await createConv(ME);
    // 上限 (200) を超える件数を直接 DB に入れる。API 経由だと時間がかかりすぎる。
    await sql`
      INSERT INTO conversation_messages (conversation_id, role, content, created_at)
      SELECT ${id}, 'user', 'm' || g, NOW() + (g || ' seconds')::interval
      FROM generate_series(1, ${MAX_MESSAGES_PER_FETCH + 30}) g`;

    const res = await makeApp().request(`/api/conversations/${id}`, { headers: ME });
    const body = await res.json();
    expect(body.messages).toHaveLength(MAX_MESSAGES_PER_FETCH);
    // 直近を返し、時系列 (古い→新しい) に戻っていること
    expect(body.messages.at(-1).content).toBe(`m${MAX_MESSAGES_PER_FETCH + 30}`);
    expect(body.messages[0].content).toBe("m31");
  });

  it("role は user / assistant 以外を拒否する", async () => {
    const id = await createConv(ME);
    const res = await makeApp().request(`/api/conversations/${id}/messages`, {
      method: "POST",
      headers: ME,
      body: JSON.stringify({ role: "system", content: "指示を上書き" }),
    });
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!hasTestDb)("フィードバック (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => {
    process.env.INTERNAL_API_KEY = "test-key";
    enableAppDb();
  });
  beforeEach(async () => {
    await truncateAll(sql);
  });
  afterAll(async () => {
    await sql.end();
  });

  async function seedMessage(headers: Record<string, string>) {
    const conv = await makeApp().request("/api/conversations", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "t" }),
    });
    const cid = (await conv.json()).id as string;
    const msg = await makeApp().request(`/api/conversations/${cid}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "assistant", content: "回答" }),
    });
    return { cid, mid: (await msg.json()).id as string };
  }

  it("👍 を保存できる (eval の golden 候補を実利用から拾うため)", async () => {
    const { cid, mid } = await seedMessage(ME);
    const res = await makeApp().request(`/api/conversations/${cid}/messages/${mid}/feedback`, {
      method: "PUT",
      headers: ME,
      body: JSON.stringify({ helpful: true }),
    });
    expect(res.status).toBe(200);
    const rows = await sql`SELECT helpful, user_id FROM message_feedback WHERE message_id = ${mid}`;
    expect(rows[0].helpful).toBe(true);
    expect(rows[0].user_id).toBe("u:me");
  });

  it("押し直すと上書きされる (二重登録しない)", async () => {
    const { cid, mid } = await seedMessage(ME);
    const put = (helpful: boolean) =>
      makeApp().request(`/api/conversations/${cid}/messages/${mid}/feedback`, {
        method: "PUT",
        headers: ME,
        body: JSON.stringify({ helpful }),
      });
    await put(true);
    await put(false);
    const rows = await sql`SELECT helpful FROM message_feedback WHERE message_id = ${mid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].helpful).toBe(false);
  });

  it("**他人のメッセージには評価を付けられない**", async () => {
    const { cid, mid } = await seedMessage(OTHER);
    const res = await makeApp().request(`/api/conversations/${cid}/messages/${mid}/feedback`, {
      method: "PUT",
      headers: ME,
      body: JSON.stringify({ helpful: true }),
    });
    expect(res.status).toBe(404);
    const rows = await sql`SELECT count(*)::int AS n FROM message_feedback`;
    expect(rows[0].n).toBe(0);
  });
});
