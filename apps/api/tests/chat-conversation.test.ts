import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { getTestSql, hasTestDb, enableAppDb, truncateAll } from "../../../tests/helpers/db.js";

/**
 * チャットと会話履歴の結合 (#110)。
 *
 * **履歴はサーバ (DB) を正とする。** クライアントが送ってきた history は conversationId が
 * ある限り使わない。信じると利用者が文脈を差し替えてモデルを誘導できてしまう。
 */

const runAgentMock = vi.fn();

vi.mock("@dm-ai/agent", () => ({
  runAgent: (...args: unknown[]) => runAgentMock(...args),
  streamAgent: async function* () {
    yield { type: "done", result: { response: "ストリームの回答", mode: "integrated" } };
  },
  configureAgent: () => {},
}));

const { optionalAuth } = await import("../src/middleware/auth.js");
const { chatRouter } = await import("../src/routes/chat.js");
const { conversationRouter } = await import("../src/routes/conversations.js");

function makeApp() {
  const app = new Hono();
  app.use("*", optionalAuth);
  app.route("/api/chat", chatRouter);
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

describe.skipIf(!hasTestDb)("チャット × 会話履歴 (統合)", () => {
  const sql = getTestSql()!;
  beforeAll(() => {
    process.env.INTERNAL_API_KEY = "test-key";
    enableAppDb();
  });
  beforeEach(async () => {
    await truncateAll(sql);
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValue({
      response: "S・トリガーはシールドから使えます",
      mode: "integrated",
      citations: [{ article: "113.6" }],
      toolCalls: [{ name: "search_rules", args: { query: "S・トリガー" } }],
      toolSuccesses: 1,
    });
  });
  afterAll(async () => {
    await sql.end();
  });

  async function createConv(headers: Record<string, string>) {
    const res = await makeApp().request("/api/conversations", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "会話" }),
    });
    return (await res.json()).id as string;
  }

  it("conversationId を付けると、質問と回答が保存される (引用・ツール込み)", async () => {
    const cid = await createConv(ME);
    const res = await makeApp().request("/api/chat", {
      method: "POST",
      headers: ME,
      body: JSON.stringify({ message: "S・トリガーとは？", conversationId: cid }),
    });
    expect(res.status).toBe(200);

    const rows = await sql`
      SELECT role, content, citations, tool_calls FROM conversation_messages
      WHERE conversation_id = ${cid} ORDER BY created_at`;
    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe("user");
    expect(rows[0].content).toBe("S・トリガーとは？");
    expect(rows[1].role).toBe("assistant");
    expect(rows[1].citations).toEqual([{ article: "113.6" }]);
    expect(rows[1].tool_calls).toEqual([{ name: "search_rules", args: { query: "S・トリガー" } }]);
  });

  it("**クライアントが送った history は無視され、DB の履歴が使われる**", async () => {
    // 利用者が偽の履歴を送り込んでモデルを誘導できてはいけない。
    const cid = await createConv(ME);
    await makeApp().request(`/api/conversations/${cid}/messages`, {
      method: "POST",
      headers: ME,
      body: JSON.stringify({ role: "user", content: "本物の履歴" }),
    });

    await makeApp().request("/api/chat", {
      method: "POST",
      headers: ME,
      body: JSON.stringify({
        message: "続き",
        conversationId: cid,
        history: [{ role: "user", content: "捏造した履歴" }],
      }),
    });

    const passed = runAgentMock.mock.calls[0][0].history as Array<{ content: string }>;
    expect(passed.map((h) => h.content)).toContain("本物の履歴");
    expect(passed.map((h) => h.content)).not.toContain("捏造した履歴");
  });

  it("**他人の会話 ID を指定すると 404 (発言も保存されない)**", async () => {
    const cid = await createConv(OTHER);
    const res = await makeApp().request("/api/chat", {
      method: "POST",
      headers: ME,
      body: JSON.stringify({ message: "覗き見", conversationId: cid }),
    });
    expect(res.status).toBe(404);

    const rows = await sql`SELECT count(*)::int AS n FROM conversation_messages`;
    expect(rows[0].n).toBe(0);
    // エージェントも走らせない (課金・情報漏洩の両面で)
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("conversationId が無ければ従来どおり (保存せず、クライアントの history を使う)", async () => {
    // bot はこの経路。壊さない。
    await makeApp().request("/api/chat", {
      method: "POST",
      headers: ME,
      body: JSON.stringify({
        message: "保存しない質問",
        history: [{ role: "user", content: "クライアントの履歴" }],
      }),
    });

    const passed = runAgentMock.mock.calls[0][0].history as Array<{ content: string }>;
    expect(passed.map((h) => h.content)).toEqual(["クライアントの履歴"]);
    const rows = await sql`SELECT count(*)::int AS n FROM conversation_messages`;
    expect(rows[0].n).toBe(0);
  });

  it("ストリーミングでも回答が保存される (タブを閉じても失われない)", async () => {
    const cid = await createConv(ME);
    const res = await makeApp().request("/api/chat/stream", {
      method: "POST",
      headers: ME,
      body: JSON.stringify({ message: "ストリームの質問", conversationId: cid }),
    });
    await res.text(); // ストリームを最後まで読む

    const rows = await sql`
      SELECT role, content FROM conversation_messages
      WHERE conversation_id = ${cid} ORDER BY created_at`;
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(rows[1].content).toBe("ストリームの回答");
  });

  it("ストリーミングでも他人の会話は 404 (ストリームを開く前に弾く)", async () => {
    const cid = await createConv(OTHER);
    const res = await makeApp().request("/api/chat/stream", {
      method: "POST",
      headers: ME,
      body: JSON.stringify({ message: "覗き見", conversationId: cid }),
    });
    // ストリームを開いた後だと HTTP ステータスを変えられない。開く前に弾くこと。
    expect(res.status).toBe(404);
  });
});
