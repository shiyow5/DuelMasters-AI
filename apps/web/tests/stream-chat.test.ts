import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// supabase を読み込ませない (Node 環境で NEXT_PUBLIC_* が無くても動くように)
vi.mock("../src/lib/supabase", () => ({ supabase: null }));

import { streamChat, ApiError, type ChatStreamEvent } from "../src/lib/api.js";

/** 与えた文字列チャンクを流す Response を作る */
function sseResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function collect(chunks: string[]): Promise<ChatStreamEvent[]> {
  globalThis.fetch = vi.fn().mockResolvedValue(sseResponse(chunks));
  const events: ChatStreamEvent[] = [];
  await streamChat({ message: "x", mode: "integrated" }, (e) => events.push(e));
  return events;
}

describe("streamChat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("phase / tool / token / done を順に通知する", async () => {
    // tool は **args** を、phase は **node** を運ぶ (#98)。ここが欠けると進行表示に
    // 「何を」検索しているかを出せない。SSE のパース経路まで通して確かめる。
    const events = await collect([
      'event: phase\ndata: {"node":"agent"}\n\n',
      'event: tool\ndata: {"name":"search_rules","args":{"query":"S・トリガー 任意"}}\n\n',
      'event: phase\ndata: {"node":"tools"}\n\n',
      'event: token\ndata: {"text":"結論"}\n\n',
      'event: done\ndata: {"result":{"response":"答え","citations":[]}}\n\n',
    ]);
    expect(events).toEqual([
      { type: "phase", node: "agent" },
      { type: "tool", name: "search_rules", args: { query: "S・トリガー 任意" } },
      { type: "phase", node: "tools" },
      { type: "token", text: "結論" },
      { type: "done", result: { response: "答え", citations: [] } },
    ]);
  });

  it("done も error も無くストリームが閉じたら error を出す", async () => {
    // Worker/プロキシがヘッダだけ返して切ることがある。ここで何も通知しないと
    // UI の streaming フラグが下りず、タイピング表示が永久に残る。
    const events = await collect(['event: token\ndata: {"text":"途中まで"}\n\n']);
    expect(events).toEqual([
      { type: "token", text: "途中まで" },
      { type: "error", message: "回答の途中で接続が切れました。もう一度お試しください。" },
    ]);
  });

  it("1件も流れずに閉じても error を出す", async () => {
    expect(await collect([])).toEqual([
      { type: "error", message: "回答の途中で接続が切れました。もう一度お試しください。" },
    ]);
  });

  it("error イベントが来たら EOF で二重に通知しない", async () => {
    const events = await collect(['event: error\ndata: {"message":"生成に失敗"}\n\n']);
    expect(events).toEqual([{ type: "error", message: "生成に失敗" }]);
  });

  it("壊れた done フレームは終端として数えない (無言で終わらせない)", async () => {
    const events = await collect(["event: done\ndata: {壊れたJSON\n\n"]);
    expect(events).toEqual([
      { type: "error", message: "回答の途中で接続が切れました。もう一度お試しください。" },
    ]);
  });

  it("401 は ApiError になり、次に何をすべきか伝える", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "ログインが必要です" }), { status: 401 }),
      );
    await expect(streamChat({}, () => {})).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: "ログインの有効期限が切れました。再度ログインしてください。",
    });
  });

  it("429 はレート制限として伝える", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 429 }));
    const err = await streamChat({}, () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain("リクエストが多すぎます");
  });
});
